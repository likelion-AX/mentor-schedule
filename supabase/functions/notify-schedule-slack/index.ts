// ============================================================================
// notify-schedule-slack : 운영팀이 앱에서 교육/배정을 저장할 때 Slack에 알림
//  · 4가지 알림: created(새 일정) / updated(일정 수정) / assigned(멘토 배정,
//    이 프로그램에 확정 배정이 하나도 없었다가 처음 생김) / changed(멘토 변경,
//    이미 있던 배정이 추가·교체·제외됨).
//  · 로컬 Project_management의 push(sync_mentor_app.py)와 짝을 이루는 "앱 저장 경로"용.
//    로컬 push 쪽은 이미 자기 자신이 직접 Slack 웹훅으로 알림을 보내므로, 이 함수는
//    오직 admin.html에서 운영팀이 직접 저장/배정할 때만 호출된다.
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
// old는 회차가 새로 추가된 경우 null(직전엔 이 순번의 회차 자체가 없었음). 날짜로 매칭하지 않고
// 순번(week)으로 매칭하므로 old.date !== new.date(날짜 자체가 바뀜)인 경우도 표현 가능.
type Change = { week?: number | string; old: Session | null; new: Session };
type Action = "created" | "updated" | "assigned" | "changed";

const HEADERS: Record<Action, string> = {
  created: "📅 새 교육 일정이 확정됐습니다",
  updated: "✏️ 일정이 수정됐습니다",
  assigned: "👤 멘토가 배정됐습니다",
  changed: "🔄 담당 멘토가 변경됐습니다",
};

function formatMessage(body: {
  program_id: string;
  company: string;
  course_name: string;
  action: Action;
  sessions?: Session[];
  changes?: Change[];
  mentor_names?: string[];
  added?: string[];
  removed?: string[];
}): string {
  const label = body.company || body.course_name;
  const link = `${APP_URL}?program=${body.program_id}`;
  const mentorLabel = body.mentor_names?.length ? body.mentor_names.join(", ") : "미정";
  const lines: string[] = [`${HEADERS[body.action]} — *[${label}]* ${body.course_name}`];

  if (body.action === "created") {
    for (const s of [...(body.sessions ?? [])].sort((a, b) => a.date.localeCompare(b.date))) {
      const loc = s.location ? ` · ${s.location}` : "";
      lines.push(`• ${s.week ?? "?"}주차 ${fmtDate(s.date)} ${hhmm(s.start_time)}~${hhmm(s.end_time)}${loc}`);
    }
  } else if (body.action === "updated") {
    for (const c of [...(body.changes ?? [])].sort((a, b) => a.new.date.localeCompare(b.new.date))) {
      const newLoc = c.new.location ? ` · ${c.new.location}` : "";
      const newStr = `${fmtDate(c.new.date)} ${hhmm(c.new.start_time)}~${hhmm(c.new.end_time)}${newLoc}`;
      if (!c.old) {
        lines.push(`• ${c.week ?? "?"}주차(신규): ${newStr}`);
      } else {
        const oldLoc = c.old.location ? ` · ${c.old.location}` : "";
        const oldStr = `${fmtDate(c.old.date)} ${hhmm(c.old.start_time)}~${hhmm(c.old.end_time)}${oldLoc}`;
        lines.push(`• ${c.week ?? "?"}주차: ${oldStr} → ${newStr}`);
      }
    }
  } else if (body.action === "changed") {
    for (const n of body.added ?? []) lines.push(`+ ${n} 추가`);
    for (const n of body.removed ?? []) lines.push(`- ${n} 제외`);
  }

  lines.push(body.action === "changed" ? `담당 멘토(현재): ${mentorLabel}` : `담당 멘토: ${mentorLabel}`);
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
    if (!["created", "updated", "assigned", "changed"].includes(body.action)) {
      return json({ error: "알 수 없는 action입니다." }, 400);
    }
    if (body.action === "created" && !body.sessions?.length) return json({ error: "sessions가 필요합니다." }, 400);
    if (body.action === "updated" && !body.changes?.length) return json({ error: "changes가 필요합니다." }, 400);
    if (body.action === "changed" && !body.added?.length && !body.removed?.length) {
      return json({ error: "added/removed 중 하나는 필요합니다." }, 400);
    }

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
