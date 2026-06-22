// ============================================================================
// calendar-feed : 멘토 구글 캘린더 자동 동기화 구독 피드 (.ics)
//  · 멘토별 비밀 토큰(?token=...)으로 본인 일정만 노출
//  · 응답: text/calendar — 구글 캘린더 "URL로 추가" 가 주기적으로 가져감
//  · 포함 일정: 본인이 배정된 교육의 모든 회차 + 본인 개인일정(mentor_blocks)
//  · 인증 헤더가 없는 공개 호출이므로 배포 시 "Verify JWT" 를 꺼야 함.
//  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 주입)
// ============================================================================
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Session = {
  id: string;
  program_id: string;
  title: string;
  client: string;
  date: string;
  start_time: string;
  end_time: string;
  location: string;
  needed_mentors: number;
  memo: string;
};
type Block = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  memo: string;
};

async function rest(path: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
  return r.ok ? await r.json() : [];
}

const hhmm = (t: string) => (t || "").slice(0, 5);

// "2026-06-15" + "10:00:00" → "20260615T100000" (TZID=Asia/Seoul 와 함께 사용)
function localStamp(date: string, time: string): string {
  return date.replace(/-/g, "") + "T" + hhmm(time).replace(":", "") + "00";
}

// 지금 시각 UTC → "YYYYMMDDTHHMMSSZ"
function utcStamp(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    now.getUTCFullYear() + p(now.getUTCMonth() + 1) + p(now.getUTCDate()) +
    "T" + p(now.getUTCHours()) + p(now.getUTCMinutes()) + p(now.getUTCSeconds()) + "Z"
  );
}

const esc = (t: string) =>
  (t || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

// ICS 75옥텟 줄 접기 — 멀티바이트 안전하게 코드포인트 70자 기준으로만 접음
function fold(line: string): string {
  if ([...line].length <= 72) return line;
  const chars = [...line];
  let out = chars.slice(0, 72).join("");
  let rest = chars.slice(72);
  while (rest.length) {
    out += "\r\n " + rest.slice(0, 71).join("");
    rest = rest.slice(71);
  }
  return out;
}

function vevent(opts: {
  uid: string;
  start: string;
  end: string;
  summary: string;
  location?: string;
  description?: string;
  stamp: string;
}): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `DTSTAMP:${opts.stamp}`,
    fold(`DTSTART;TZID=Asia/Seoul:${opts.start}`),
    fold(`DTEND;TZID=Asia/Seoul:${opts.end}`),
    fold(`SUMMARY:${esc(opts.summary)}`),
    fold(`LOCATION:${esc(opts.location || "")}`),
    fold(`DESCRIPTION:${esc(opts.description || "")}`),
    "END:VEVENT",
  ];
}

function buildIcs(sessions: Session[], blocks: Block[], name: string): string {
  const stamp = utcStamp();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//mentor-schedule//calendar-feed//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    fold(`X-WR-CALNAME:멘토 일정${name ? " (" + name + ")" : ""}`),
    "X-WR-TIMEZONE:Asia/Seoul",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    // 한국 표준시(KST, 고정 +09:00, 서머타임 없음)
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Seoul",
    "X-LIC-LOCATION:Asia/Seoul",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0900",
    "TZOFFSETTO:+0900",
    "TZNAME:KST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  for (const s of sessions) {
    const summary = s.client ? `${s.client} · ${s.title}` : s.title;
    const desc = [
      s.client ? `고객사: ${s.client}` : "",
      s.title ? `교육: ${s.title}` : "",
      s.memo ? `메모: ${s.memo}` : "",
      "(멘토 일정 관리 — 배정 교육)",
    ].filter(Boolean).join("\n");
    lines.push(...vevent({
      uid: `sess-${s.id}@mentor-schedule`,
      start: localStamp(s.date, s.start_time),
      end: localStamp(s.date, s.end_time),
      summary,
      location: s.location,
      description: desc,
      stamp,
    }));
  }

  for (const b of blocks) {
    lines.push(...vevent({
      uid: `block-${b.id}@mentor-schedule`,
      start: localStamp(b.date, b.start_time),
      end: localStamp(b.date, b.end_time),
      summary: `🔒 ${b.memo || "개인 일정"}`,
      description: "(멘토 일정 관리 — 개인 일정)",
      stamp,
    }));
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("missing token", { status: 400 });
  }

  // 토큰 → 멘토
  const feeds = await rest(`calendar_feeds?token=eq.${encodeURIComponent(token)}&select=mentor_id`);
  if (!feeds.length) {
    return new Response("invalid token", { status: 404 });
  }
  const mentorId = feeds[0].mentor_id as string;

  const mentors = await rest(`mentors?id=eq.${mentorId}&select=email,name`);
  const me = mentors[0] || { email: "", name: "" };

  // 배정된 교육(program_id) — 본인 이메일 기준 (멘토/퍼실 모두)
  let sessions: Session[] = [];
  if (me.email) {
    const assigns = await rest(
      `assignments?person_email=eq.${encodeURIComponent(me.email)}&select=program_id`,
    );
    const programIds = [...new Set(assigns.map((a: any) => a.program_id))].filter(Boolean);
    if (programIds.length) {
      const inList = programIds.map((p) => `"${p}"`).join(",");
      sessions = await rest(
        `education_sessions?program_id=in.(${inList})` +
          `&select=id,program_id,title,client,date,start_time,end_time,location,needed_mentors,memo` +
          `&order=date`,
      ) as Session[];
    }
  }

  // 본인 개인일정
  const blocks = await rest(
    `mentor_blocks?mentor_id=eq.${mentorId}&select=id,date,start_time,end_time,memo&order=date`,
  ) as Block[];

  const ics = buildIcs(sessions, blocks, me.name || "");

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="mentor-schedule.ics"',
      "Cache-Control": "public, max-age=900",
    },
  });
});
