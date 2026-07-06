// ============================================================================
// notify-schedule-slack : 운영팀이 앱에서 교육을 생성/수정할 때 Slack에 알림
//  · 로컬 Project_management의 push(sync_mentor_app.py)와 짝을 이루는 "앱 저장 경로"용.
//    로컬 push 쪽은 이미 자기 자신이 직접 Slack 웹훅으로 알림을 보내므로, 이 함수는
//    오직 admin.html에서 운영팀이 직접 생성/수정 저장할 때만 호출된다.
//  · 실제로 값이 달라졌을 때만 호출하는 판단은 프론트(admin.js)에서 하고, 이 함수는
//    "포맷해서 보내기"만 담당 — AI/DB 조회 없음, 단순 변환+POST.
//  · 호출자가 운영팀(admin)인지 로그인 토큰으로 확인(parse-schedule과 동일 패턴).
//
//  시크릿: SLACK_WEBHOOK_URL, APP_URL (notify-assignment과 공유)
//         (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 주입)
//
//  배포: supabase functions deploy notify-schedule-slack
// ============================================================================
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** 호출자가 운영팀(admin)인지 확인 (parse-schedule과 동일 로직) */
async function isAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: SRK } });
  if (!u.ok) return false;
  const user = await u.json();
  if (!user?.id) return false;
  const m = await fetch(`${SB_URL}/rest/v1/mentors?id=eq.${user.id}&select=role`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
  const rows = m.ok ? await m.json() : [];
  return rows[0]?.role === "admin";
}

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];
function fmtDate(d: string): string {
  const x = new Date(d + "T00:00:00");
  if (isNaN(x.getTime())) return d || "";
  return `${x.getMonth() + 1}/${x.getDate()}(${WEEKDAYS_KO[x.getDay()]})`;
}
const hhmm = (t: string) => (t || "").slice(0, 5);

type Session = { week?: number | string; date: string; start_time: string; end_time: string; location?: string };
type Change = { week?: number | string; date: string; old: Partial<Session>; new: Session };

function formatMessage(body: {
  program_id: string;
  company: string;
  course_name: string;
  action: "created" | "updated";
  sessions?: Session[];
  changes?: Change[];
  mentor_names?: string[];
}): string {
  const label = body.company || body.course_name;
  const link = `${APP_URL}?program=${body.program_id}`;
  const mentorLabel = body.mentor_names?.length ? body.mentor_names.join(", ") : "미정";
  const lines: string[] = [];

  if (body.action === "created") {
    lines.push(`📅 *[${label}]* ${body.course_name} — 새 교육 일정이 확정됐습니다`);
    for (const s of [...(body.sessions ?? [])].sort((a, b) => a.date.localeCompare(b.date))) {
      const loc = s.location ? ` · ${s.location}` : "";
      lines.push(`• ${s.week ?? "?"}주차 ${fmtDate(s.date)} ${hhmm(s.start_time)}~${hhmm(s.end_time)}${loc}`);
    }
  } else {
    lines.push(`✏️ *[${label}]* ${body.course_name} — 일정이 수정됐습니다`);
    for (const c of [...(body.changes ?? [])].sort((a, b) => a.date.localeCompare(b.date))) {
      const oldLoc = c.old?.location ? ` · ${c.old.location}` : "";
      const newLoc = c.new.location ? ` · ${c.new.location}` : "";
      lines.push(
        `• ${c.week ?? "?"}주차: ${hhmm(c.old?.start_time ?? "")}~${hhmm(c.old?.end_time ?? "")}${oldLoc} → ` +
          `${hhmm(c.new.start_time)}~${hhmm(c.new.end_time)}${newLoc}`,
      );
    }
  }
  lines.push(`담당 멘토: ${mentorLabel}`);
  lines.push(`🔗 앱에서 확인: ${link}`);
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!SLACK_WEBHOOK_URL) return json({ error: "SLACK_WEBHOOK_URL 미설정" }, 500);
    if (!(await isAdmin(req))) return json({ error: "운영팀만 사용할 수 있어요." }, 403);

    const body = await req.json();
    if (!body?.program_id || !body?.action) return json({ error: "program_id/action이 필요합니다." }, 400);
    if (body.action === "created" && !body.sessions?.length) return json({ error: "sessions가 필요합니다." }, 400);
    if (body.action === "updated" && !body.changes?.length) return json({ error: "changes가 필요합니다." }, 400);

    const text = formatMessage(body);
    const r = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return json({ error: `Slack 전송 실패: ${r.status} ${await r.text()}` }, 502);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
