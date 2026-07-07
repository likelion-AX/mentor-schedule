// ============================================================================
// notify-schedule-slack : 운영팀이 앱에서 교육/배정을 저장할 때 Slack에 알림
//  · 5가지 알림: created(새 일정) / updated(일정 수정) / assigned(멘토 배정,
//    이 프로그램에 확정 배정이 하나도 없었다가 처음 생김) / changed(멘토 변경,
//    이미 있던 배정이 추가·교체·제외됨) / deleted(교육 삭제 — program_id가 더 이상
//    없으므로 앱 링크는 안 붙임).
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

/** Slack mrkdwn 특수문자를 무력화 — 회사명·교육명·멘토 이름·장소처럼 사용자가 자유롭게 입력하는
 *  텍스트에 *_~`(굵게/기울임/취소선/코드 서식 문자)나 &<>(엔티티 문자)가 섞여 있으면 의도치 않은
 *  서식이 깨지거나 메시지 뒷부분까지 번질 수 있어 여기서 미리 무력화한다.
 *  &/</>는 Slack 공식 이스케이프(엔티티). *_~`는 공식 이스케이프가 없어 각 문자 바로 뒤에 폭 없는
 *  공백(U+200B)을 붙여 서식 페어링이 안 되게 끊는다(사람 눈엔 원래 문자 그대로 보임). */
function escSlack(s?: string | null): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([*_~`])/g, "$1​");
}

type Session = { week?: number | string; date: string; start_time: string; end_time: string; location?: string };
// old/new 중 하나는 null일 수 있다(둘 다는 아님) — new만 있으면 추가된 회차, old만 있으면 삭제된 회차,
// 둘 다 있으면 같은 회차가 수정된 것(날짜 자체가 바뀐 경우도 포함). admin.js에서 폼 행에 실려있는
// 원래 DB row id로 짝지어서 넘겨주므로, 이 함수는 매칭 자체는 신경 쓰지 않고 받은 대로 포맷만 한다.
type Change = { old: Session | null; new: Session | null };
type Action = "created" | "updated" | "assigned" | "changed" | "deleted";

const HEADERS: Record<Action, string> = {
  created: "📅 새 교육 일정이 확정됐습니다",
  updated: "✏️ 일정이 수정됐습니다",
  assigned: "👤 멘토가 배정됐습니다",
  changed: "🔄 담당 멘토가 변경됐습니다",
  deleted: "🗑️ 교육이 삭제됐습니다",
};

/** 회차 목록을 "N회차 날짜 시간 · 장소" 줄들로 — created/updated 둘 다에서 "현재 전체 일정"을 보여줄 때 재사용.
 *  updated에서도 이걸 넣는 이유: 변경분(diff)만 보면 사람이 이전 일정을 외우고 있어야 맥락이 이해되는데,
 *  실제로는 아무도 그걸 외우고 있지 않으므로 매번 전체 일정을 함께 보여준다.
 *  "주차"가 아니라 "회차"인 이유: 하루에 회차가 2개 이상인 교육도 있어서 "주차" 단위로는 안 맞음. */
function sessionLines(sessions: Session[]): string[] {
  return [...sessions]
    .sort((a, b) => a.date.localeCompare(b.date) || hhmm(a.start_time).localeCompare(hhmm(b.start_time)))
    .map((s) => {
      const loc = s.location ? ` · ${escSlack(s.location)}` : "";
      return `• ${s.week ?? "?"}회차 ${fmtDate(s.date)} ${hhmm(s.start_time)}~${hhmm(s.end_time)}${loc}`;
    });
}

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
  const label = escSlack(body.company || body.course_name);
  const link = `${APP_URL}?program=${body.program_id}`;
  const mentorLabel = body.mentor_names?.length ? body.mentor_names.map(escSlack).join(", ") : "미정";
  const lines: string[] = [`${HEADERS[body.action]} — *[${label}]* ${escSlack(body.course_name)}`];

  if (body.action === "created") {
    lines.push(...sessionLines(body.sessions ?? []));
  } else if (body.action === "updated") {
    lines.push("변경사항:");
    for (const c of [...(body.changes ?? [])].sort((a, b) => (a.new?.date ?? a.old!.date).localeCompare(b.new?.date ?? b.old!.date))) {
      if (c.old && c.new) {
        // 같은 회차를 그 자리에서 고친 것 — 날짜 자체가 바뀐 경우(스케줄 이동)도 포함되므로
        // 날짜를 한쪽만 보여주지 않고 old/new 양쪽 다 온전히 보여준다.
        const oldLoc = c.old.location ? ` · ${escSlack(c.old.location)}` : "";
        const newLoc = c.new.location ? ` · ${escSlack(c.new.location)}` : "";
        lines.push(
          `• ${fmtDate(c.old.date)} ${hhmm(c.old.start_time)}~${hhmm(c.old.end_time)}${oldLoc} → ` +
            `${fmtDate(c.new.date)} ${hhmm(c.new.start_time)}~${hhmm(c.new.end_time)}${newLoc}`,
        );
      } else if (c.new) {
        const loc = c.new.location ? ` · ${escSlack(c.new.location)}` : "";
        lines.push(`• (추가) ${fmtDate(c.new.date)} ${hhmm(c.new.start_time)}~${hhmm(c.new.end_time)}${loc}`);
      } else if (c.old) {
        const loc = c.old.location ? ` · ${escSlack(c.old.location)}` : "";
        lines.push(`• (삭제) ${fmtDate(c.old.date)} ${hhmm(c.old.start_time)}~${hhmm(c.old.end_time)}${loc}`);
      }
    }
    lines.push("", "전체 일정:");
    lines.push(...sessionLines(body.sessions ?? []));
  } else if (body.action === "assigned" || body.action === "changed") {
    if (body.action === "changed") {
      for (const n of body.added ?? []) lines.push(`+ ${escSlack(n)} 추가`);
      for (const n of body.removed ?? []) lines.push(`- ${escSlack(n)} 제외`);
    }
    lines.push("", "전체 일정:");
    lines.push(...sessionLines(body.sessions ?? []));
  } else if (body.action === "deleted") {
    lines.push("전체 일정(삭제 전 마지막 상태):");
    lines.push(...sessionLines(body.sessions ?? []));
  }

  lines.push(body.action === "changed" ? `담당 멘토(현재): ${mentorLabel}` : `담당 멘토: ${mentorLabel}`);
  // 삭제된 프로그램은 program_id가 더 이상 DB에 없어 앱 링크가 무효하므로 안 붙인다.
  if (body.action !== "deleted") lines.push(`🔗 앱에서 확인: ${link}`);
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!SLACK_WEBHOOK_URL) return json({ error: "SLACK_WEBHOOK_URL 미설정" }, 500);
    if (!(await isAdmin(req))) return json({ error: "운영팀만 사용할 수 있어요." }, 403);

    const body = await req.json();
    if (!body?.program_id || !body?.action) return json({ error: "program_id/action이 필요합니다." }, 400);
    if (!["created", "updated", "assigned", "changed", "deleted"].includes(body.action)) {
      return json({ error: "알 수 없는 action입니다." }, 400);
    }
    if (body.action === "created" && !body.sessions?.length) return json({ error: "sessions가 필요합니다." }, 400);
    if (body.action === "updated" && !body.changes?.length) return json({ error: "changes가 필요합니다." }, 400);
    if (body.action === "updated" && !body.sessions?.length) return json({ error: "sessions가 필요합니다." }, 400);
    if (body.action === "changed" && !body.added?.length && !body.removed?.length) {
      return json({ error: "added/removed 중 하나는 필요합니다." }, 400);
    }
    if ((body.action === "assigned" || body.action === "changed" || body.action === "deleted") && !body.sessions?.length) {
      return json({ error: "sessions가 필요합니다." }, 400);
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
