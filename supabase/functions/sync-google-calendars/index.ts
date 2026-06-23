// ============================================================================
// sync-google-calendars : 구글 캘린더(비공개 iCal) → 앱 개인일정(불가 시간) 동기화
//
// [보안 최우선]
//  · 멘토의 구글 약속에서 "제목/내용/장소" 줄은 ICS 파싱 *이전에* 통째로 삭제한다.
//    → 우리 코드는 제목을 보지도 못하고, DB엔 시간(시작·끝)만 source='google' 로 저장.
//  · 호출 보호 2가지:
//     (a) cron : 헤더 x-sync-secret == SYNC_SECRET  → 모든 연결 동기화
//     (b) 멘토 : Authorization: Bearer <사용자 토큰> → 본인 것만 동기화(테스트/즉시반영)
//    그 외 호출은 401. 배포 시 Verify JWT 는 OFF(위 두 방식으로 자체 인증).
//  · ical_url 은 service_role 로만 읽음(테이블 RLS: 본인만, admin도 못 봄).
//
//  필요 시크릿: SYNC_SECRET  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 자동 주입)
// ============================================================================
import ICAL from "npm:ical.js@1.5.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_SECRET = Deno.env.get("SYNC_SECRET") ?? "";

// 브라우저(멘토 화면)가 직접 호출하므로 CORS 허용 필요
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-sync-secret, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });

// ---- service_role REST 헬퍼 ----
async function rest(path: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
  return r.ok ? await r.json() : [];
}
async function restWrite(method: string, path: string, body?: unknown): Promise<Response> {
  return await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SRK,
      Authorization: `Bearer ${SRK}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ============================================================================
// ★ 보안 핵심 ★ : 민감한 속성 줄을 파싱 전에 제거 (제목/내용/장소/참석자 등)
//   ICS 는 줄 단위. 이어지는 줄(접힘)은 공백/탭으로 시작 → 함께 제거.
//   남기는 것: 시간/반복/식별/타임존/상태(BUSY·CANCELLED 판단) 등 일정 구조에 필요한 것만.
// ============================================================================
const DROP_PROPS = [
  "SUMMARY", "DESCRIPTION", "LOCATION", "COMMENT", "CONTACT",
  "ATTENDEE", "ORGANIZER", "URL", "CATEGORIES", "RESOURCES", "GEO",
  "ATTACH", "RELATED-TO", "X-ALT-DESC", "X-TITLE",
];
function stripSensitive(ics: string): string {
  const lines = ics.split(/\r\n|\r|\n/);
  const out: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const isCont = /^[ \t]/.test(line);
    if (isCont) {
      if (!dropping) out.push(line);
      continue;
    }
    dropping = false;
    const name = (line.split(/[:;]/, 1)[0] || "").toUpperCase();
    // 민감 속성 또는 모든 X- 확장 속성은 제거(데이터가 들어있을 수 있음)
    if (DROP_PROPS.includes(name) || name.startsWith("X-")) {
      dropping = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\r\n");
}

// ---- 시간 변환 (절대시각 → KST 날짜/시각) ----
const KST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function toKst(d: Date): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of KST.formatToParts(d)) p[part.type] = part.value;
  const hour = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}
const pad = (n: number) => String(n).padStart(2, "0");
function dateStrOf(t: any): string {
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

type Occ = { date: string; start_time: string; end_time: string };

// 한 인스턴스(시작/끝 ICAL.Time)를 날짜별 불가 블록으로 변환해 Set에 추가
function addInstance(set: Set<string>, startT: any, endT: any) {
  if (startT.isDate) {
    // 종일 일정: DTEND 는 마지막날 +1 (배타적). 하루씩 끊어 막음.
    let day = dateStrOf(startT);
    const endDay = endT && endT.isDate ? dateStrOf(endT) : addDays(day, 1);
    let guard = 0;
    if (endDay <= day) { set.add(`${day}|00:00|23:59`); return; }
    while (day < endDay && guard++ < 60) {
      set.add(`${day}|00:00|23:59`);
      day = addDays(day, 1);
    }
    return;
  }
  const s = toKst(startT.toJSDate());
  const e = toKst(endT.toJSDate());
  if (s.date === e.date && e.time > s.time) {
    set.add(`${s.date}|${s.time}|${e.time}`);
  } else if (s.date === e.date) {
    set.add(`${s.date}|${s.time}|23:59`);
  } else {
    // 자정 넘김: 시작일은 끝까지 막음(충돌 판정 충분)
    set.add(`${s.date}|${s.time}|23:59`);
  }
}

function parseBusy(icsRaw: string): Occ[] {
  const ics = stripSensitive(icsRaw);
  const jcal = ICAL.parse(ics);
  const vcal = new ICAL.Component(jcal);

  // VTIMEZONE 등록 (TZID 해석용)
  for (const vt of vcal.getAllSubcomponents("vtimezone")) {
    try {
      const tz = new ICAL.Timezone(vt);
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz.tzid, tz);
    } catch (_) { /* noop */ }
  }

  const now = Date.now();
  const winStart = new Date(now - 7 * 864e5);   // 지난 7일
  const winEnd = new Date(now + 180 * 864e5);   // 향후 180일
  const set = new Set<string>();
  let total = 0;
  const MAX = 800;

  for (const comp of vcal.getAllSubcomponents("vevent")) {
    if (total >= MAX) break;
    // 취소/한가함(바쁘지 않음)은 제외
    const status = (comp.getFirstPropertyValue("status") || "").toString().toUpperCase();
    const transp = (comp.getFirstPropertyValue("transp") || "").toString().toUpperCase();
    if (status === "CANCELLED" || transp === "TRANSPARENT") continue;

    let ev: any;
    try { ev = new ICAL.Event(comp); } catch (_) { continue; }
    if (!ev.startDate) continue;

    if (ev.isRecurring()) {
      const it = ev.iterator();
      let next: any;
      let guard = 0;
      while ((next = it.next()) && guard++ < 1500) {
        const js = next.toJSDate();
        if (js > winEnd) break;
        if (js < winStart) continue;
        const endT = next.clone();
        try { endT.addDuration(ev.duration); } catch (_) { /* keep start */ }
        addInstance(set, next, endT);
        if (++total >= MAX) break;
      }
    } else {
      const js = ev.startDate.toJSDate();
      if (js >= winStart && js <= winEnd) {
        addInstance(set, ev.startDate, ev.endDate || ev.startDate);
        total++;
      }
    }
  }

  return [...set].map((k) => {
    const [date, start_time, end_time] = k.split("|");
    return { date, start_time, end_time };
  });
}

// 멘토 1명 동기화
async function syncOne(mentorId: string, icalUrl: string): Promise<{ ok: boolean; count: number; error?: string }> {
  let occ: Occ[];
  try {
    const res = await fetch(icalUrl, { headers: { "User-Agent": "mentor-schedule/calendar-sync" } });
    if (!res.ok) throw new Error("fetch " + res.status);
    const text = await res.text();
    occ = parseBusy(text);
  } catch (e) {
    await restWrite("PATCH", `mentor_calendar_links?mentor_id=eq.${mentorId}`, {
      last_synced_at: new Date().toISOString(),
      last_status: "error: " + String(e).slice(0, 200),
    });
    return { ok: false, count: 0, error: String(e) };
  }

  // 기존 구글 블록 제거 후 재삽입 (추가/삭제 자동 반영) — 제목(memo)은 항상 빈값
  await restWrite("DELETE", `mentor_blocks?mentor_id=eq.${mentorId}&source=eq.google`);
  if (occ.length) {
    const rows = occ.map((o) => ({
      mentor_id: mentorId,
      date: o.date,
      start_time: o.start_time,
      end_time: o.end_time,
      memo: "",
      source: "google",
    }));
    const r = await restWrite("POST", "mentor_blocks", rows);
    if (!r.ok) {
      const msg = await r.text();
      await restWrite("PATCH", `mentor_calendar_links?mentor_id=eq.${mentorId}`, {
        last_synced_at: new Date().toISOString(),
        last_status: "error(insert): " + msg.slice(0, 200),
      });
      return { ok: false, count: 0, error: msg };
    }
  }
  await restWrite("PATCH", `mentor_calendar_links?mentor_id=eq.${mentorId}`, {
    last_synced_at: new Date().toISOString(),
    last_status: "ok",
    last_count: occ.length,
  });
  return { ok: true, count: occ.length };
}

// 사용자 토큰 검증 → mentor id
async function userIdFromToken(authHeader: string): Promise<string | null> {
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SRK, Authorization: authHeader },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ?? null;
}

Deno.serve(async (req) => {
  // CORS 사전요청(preflight)
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const secret = req.headers.get("x-sync-secret");
    const auth = req.headers.get("Authorization") || "";

    // (a) cron 모드 — 모든 연결 동기화
    if (SYNC_SECRET && secret === SYNC_SECRET) {
      const links = await rest("mentor_calendar_links?enabled=eq.true&select=mentor_id,ical_url");
      const results = [];
      for (const l of links) results.push(await syncOne(l.mentor_id, l.ical_url));
      return json({ mode: "cron", synced: results.length, results });
    }

    // (b) 멘토 본인 모드 — 본인 것만
    if (auth.startsWith("Bearer ")) {
      const uid = await userIdFromToken(auth);
      if (!uid) return json({ error: "invalid token" }, 401);
      const links = await rest(
        `mentor_calendar_links?mentor_id=eq.${uid}&enabled=eq.true&select=mentor_id,ical_url`,
      );
      if (!links.length) return json({ error: "no link" }, 404);
      const r = await syncOne(links[0].mentor_id, links[0].ical_url);
      return json({ mode: "user", ...r });
    }

    return json({ error: "unauthorized" }, 401);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
