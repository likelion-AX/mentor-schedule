// ============================================================================
// parse-schedule : 캡쳐 이미지/러프 텍스트 → 교육 일정 구조화
//  · AI 제공자 이중 지원: Ollama Cloud(무료 티어) 우선, Anthropic Claude 폴백.
//  · 운영팀(admin)만 호출 가능. 결과는 프론트의 '새 교육' 폼에 채워져 검토 후 저장.
//
//  시크릿 (둘 중 하나만 있어도 동작, 둘 다 있으면 Ollama 먼저 → 실패 시 Claude):
//    OLLAMA_API_KEY     ollama.com/settings/keys 에서 발급 (무료)
//    OLLAMA_MODEL       선택, 기본 "qwen3-vl:235b" (비전 지원 모델이어야 함)
//    ANTHROPIC_API_KEY  platform.claude.com 에서 발급 (유료, 더 정확)
//  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 주입)
//
//  배포:
//    supabase secrets set OLLAMA_API_KEY=...
//    supabase functions deploy parse-schedule
// ============================================================================
import Anthropic from "npm:@anthropic-ai/sdk";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OLLAMA_API_KEY = Deno.env.get("OLLAMA_API_KEY") ?? "";
// instruct(비추론) 변형 — 추론(thinking) 변형은 응답이 느리고 구조화 출력이 비는 경우가 있음
const OLLAMA_MODEL = Deno.env.get("OLLAMA_MODEL") || "qwen3-vl:235b-instruct";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/** 호출자가 운영팀(admin)인지 확인 */
async function isAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SRK },
  });
  if (!u.ok) return false;
  const user = await u.json();
  if (!user?.id) return false;
  const m = await fetch(`${SB_URL}/rest/v1/mentors?id=eq.${user.id}&select=role`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
  const rows = m.ok ? await m.json() : [];
  return rows[0]?.role === "admin";
}

// 추출 결과 스키마 — Ollama의 format 파라미터/Claude structured outputs 양쪽에 사용
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["client", "title", "location", "memo", "needed_mentors", "needed_facilitators", "sessions"],
  properties: {
    client: { type: "string", description: "회사(고객사) 이름. 모르면 빈 문자열" },
    title: { type: "string", description: "교육 제목. 모르면 빈 문자열" },
    location: { type: "string", description: "교육 장소. 모르면 빈 문자열" },
    memo: { type: "string", description: "폼에 안 들어가는 유의사항 요약(준비물·주차·담당자 등). 없으면 빈 문자열" },
    needed_mentors: { type: "integer", description: "필요 멘토 수. 언급 없으면 1" },
    needed_facilitators: { type: "integer", description: "필요 퍼실리테이터 수. 언급 없으면 0" },
    sessions: {
      type: "array",
      description: "개별 회차 목록. 반복 표현은 전부 전개",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "start", "end"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          start: { type: "string", description: "시작 시간 HH:MM (24시간)" },
          end: { type: "string", description: "종료 시간 HH:MM (24시간)" },
        },
      },
    },
  },
};

function buildPrompt(text: string): string {
  const now = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  return [
    `오늘은 ${today} (한국 시간)입니다.`,
    "아래의 러프한 텍스트 및/또는 캡쳐 이미지에서 기업 교육 일정 정보를 추출하세요.",
    "",
    "규칙:",
    "- 날짜는 YYYY-MM-DD. 연도가 없으면 오늘 이후에 오는 가장 가까운 해당 날짜로 해석.",
    "- '6/15부터 매주 월·수 10~13시 총 4회' 같은 반복 표현은 개별 회차 날짜로 모두 전개.",
    "- 시간은 24시간 HH:MM. '오후 2시'는 14:00.",
    "- 표에 시간 열이 있으면 각 회차의 시간을 반드시 그 행에서 그대로 읽을 것 — 회차마다 시간이 다를 수 있으므로 한 회차의 시간을 다른 회차에 복사하지 말 것.",
    "- 기본값 10:00~13:00은 텍스트와 이미지 어디에도 시간 정보가 없을 때만 사용.",
    "- 회사명(client)과 교육 제목(title)을 구분. 하나만 있으면 title에 넣고 client는 빈 문자열.",
    "- 인원수를 놓치지 말 것: '멘토 2명' → needed_mentors=2, '퍼실 1명' → needed_facilitators=1.",
    "- 표/캘린더 이미지라면 칸 안의 모든 회차를 빠짐없이 추출.",
    "- 비고·유의사항(준비물, 식사, 주차, 담당자 등)은 memo에 그대로 요약.",
    "- 결과는 JSON만 출력.",
    text ? `\n텍스트:\n${text}` : "",
  ].join("\n");
}

type Img = { data: string; media_type?: string } | null;

/** Ollama Cloud (무료) — 네이티브 /api/chat + format(JSON 스키마) + images(base64) */
async function parseWithOllama(text: string, image: Img) {
  const message: Record<string, unknown> = { role: "user", content: buildPrompt(text) };
  if (image?.data) message.images = [image.data];
  const r = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OLLAMA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [message],
      stream: false,
      format: SCHEMA,
      options: { temperature: 0 },
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Ollama ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  const content = data?.message?.content;
  console.log("[ollama]", OLLAMA_MODEL, "raw:", String(content).slice(0, 500));
  if (!content) throw new Error("Ollama 응답이 비어 있음");
  return JSON.parse(content);
}

/** 모델이 형식만 맞고 알맹이 없는 결과를 주면 실패로 처리 (빈 폼 방지) */
function assertNotEmpty(result: Record<string, unknown>) {
  const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  if (!sessions.length && !result?.title && !result?.client) {
    throw new Error("추출된 내용이 없음 (모델이 빈 결과 반환)");
  }
  return result;
}

/** Anthropic Claude (유료, 더 정확) — 비전 + structured outputs */
async function parseWithClaude(text: string, image: Img) {
  const content: Anthropic.ContentBlockParam[] = [];
  if (image?.data) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.media_type || "image/png",
        data: image.data,
      },
    });
  }
  content.push({ type: "text", text: buildPrompt(text) });

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  });
  const textBlock = msg.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Claude 응답이 비어 있음");
  return JSON.parse(textBlock.text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!OLLAMA_API_KEY && !ANTHROPIC_API_KEY) {
      return json({ error: "OLLAMA_API_KEY 또는 ANTHROPIC_API_KEY를 설정하세요 — SETUP.md 7번 참고" }, 500);
    }
    if (!(await isAdmin(req))) return json({ error: "운영팀만 사용할 수 있어요." }, 403);

    const { text = "", image = null } = await req.json();
    if (!text && !image?.data) return json({ error: "텍스트 또는 이미지를 보내주세요." }, 400);

    // Ollama(무료) 먼저, 실패하면 Claude로 폴백
    const errors: string[] = [];
    if (OLLAMA_API_KEY) {
      try {
        return json({ result: assertNotEmpty(await parseWithOllama(text, image)), provider: "ollama", model: OLLAMA_MODEL });
      } catch (e) {
        console.error("[ollama] 실패:", e);
        errors.push("ollama: " + String(e?.message ?? e));
      }
    }
    if (ANTHROPIC_API_KEY) {
      try {
        return json({ result: assertNotEmpty(await parseWithClaude(text, image)), provider: "claude" });
      } catch (e) {
        console.error("[claude] 실패:", e);
        errors.push("claude: " + String(e?.message ?? e));
      }
    }
    return json({ error: "분석 실패: " + errors.join(" / ") }, 500);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
