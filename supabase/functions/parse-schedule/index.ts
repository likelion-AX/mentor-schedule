// ============================================================================
// parse-schedule : 캡쳐 이미지/러프 텍스트 → 교육 일정 구조화 (Claude API)
//  · 운영팀(admin)만 호출 가능. 결과는 프론트의 '새 교육' 폼에 채워져 검토 후 저장.
//  시크릿: ANTHROPIC_API_KEY  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 주입)
//  배포:   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//          supabase functions deploy parse-schedule
// ============================================================================
import Anthropic from "npm:@anthropic-ai/sdk";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

// 추출 결과 스키마 (structured outputs — 항상 이 형태의 유효한 JSON이 보장됨)
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
    "- 시간은 24시간 HH:MM. '오후 2시'는 14:00. 시간 정보가 전혀 없으면 10:00~13:00 사용.",
    "- 회사명(client)과 교육 제목(title)을 구분. 하나만 있으면 title에 넣고 client는 빈 문자열.",
    "- 표/캘린더 이미지라면 칸 안의 모든 회차를 빠짐없이 추출.",
    text ? `\n텍스트:\n${text}` : "",
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY 미설정 — SETUP.md 참고" }, 500);
    if (!(await isAdmin(req))) return json({ error: "운영팀만 사용할 수 있어요." }, 403);

    const { text = "", image = null } = await req.json();
    if (!text && !image?.data) return json({ error: "텍스트 또는 이미지를 보내주세요." }, 400);

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
    if (!textBlock || textBlock.type !== "text") return json({ error: "추출 결과가 비어 있어요." }, 500);
    return json({ result: JSON.parse(textBlock.text) });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
