// ============================================================================
// mentor.js — 멘토 화면
//  · 캘린더 3색: 기업교육 세션(공통) / 내 배정 / 내 개인일정
//  · 개인일정(mentor_blocks) CRUD (RLS 로 본인 것만)
//  · 내 배정 수락/거절
// ============================================================================

let calendar;
let me; // 프로필
const IS_MOBILE = window.matchMedia("(max-width: 700px)").matches;
let view = { sessions: [], blocks: [], myProgramIds: new Set() };
let selectedDayEl = null;

function todayISO() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function init() {
  me = await Auth.requireAuth();
  Auth.renderUserArea(me, document.getElementById("userArea"));
  // 멘토/퍼실은 갈 곳이 여기뿐이라 상단 메뉴 숨김. 운영팀만 '내 일정/운영팀' 전환 메뉴 노출.
  if (me.role === "admin") document.getElementById("topNav").classList.remove("hidden");

  setupCalendar();
  document.getElementById("blockForm").addEventListener("submit", onAddBlock);
  setupCalendarSync();
  loadGcalImport();

  await refreshAll();
}

// ===================== 구글 캘린더 → 앱 (개인 약속 가져오기) =====================
async function loadGcalImport() {
  const wrap = document.getElementById("gcalImport");
  if (!wrap) return;
  const { data } = await window.sb
    .from("mentor_calendar_links")
    .select("enabled,last_synced_at,last_status,last_count")
    .eq("mentor_id", me.id)
    .maybeSingle();

  if (!data) {
    // 미연결 상태
    wrap.innerHTML = `
      <div class="field">
        <input class="input" type="url" id="gcalUrl" placeholder="구글 비공개 주소 (https://calendar.google.com/.../basic.ics)" />
      </div>
      <button class="btn btn-secondary btn-sm" id="gcalConnect" type="button">연결</button>`;
    document.getElementById("gcalConnect").addEventListener("click", connectGcal);
    return;
  }

  const when = data.last_synced_at ? Util.fmtDate(data.last_synced_at.slice(0, 10)) + " " + data.last_synced_at.slice(11, 16) : "아직 없음";
  const status = data.last_status === "ok"
    ? `<span class="badge badge-status-수락">동기화됨</span> ${data.last_count ?? 0}건`
    : (data.last_status ? `<span class="badge badge-status-거절">오류</span> <span class="text-caption">${Util.escapeHtml(data.last_status)}</span>` : "");
  wrap.innerHTML = `
    <div class="card" style="padding: var(--space-3); box-shadow:none; border-color: var(--color-border-weak)">
      <div class="text-caption">🔗 연결됨 · ${status}</div>
      <div class="text-caption text-muted">마지막 동기화: ${when}</div>
      <div class="row mt-4" style="gap: var(--space-2)">
        <button class="btn btn-secondary btn-sm" id="gcalSync" type="button">지금 동기화</button>
        <button class="btn btn-ghost btn-sm" id="gcalDisconnect" type="button">연결 해제</button>
      </div>
    </div>`;
  document.getElementById("gcalSync").addEventListener("click", syncGcalNow);
  document.getElementById("gcalDisconnect").addEventListener("click", disconnectGcal);
}

async function connectGcal() {
  const url = (document.getElementById("gcalUrl").value || "").trim();
  if (!/^https:\/\/.+/i.test(url)) return Util.toast("https로 시작하는 구글 비공개 주소를 붙여넣어 주세요.");
  if (!/ical|\.ics/i.test(url)) {
    if (!confirm("구글 iCal 주소가 아닌 것 같아요. 그래도 연결할까요?")) return;
  }
  const btn = document.getElementById("gcalConnect");
  btn.disabled = true; btn.textContent = "연결 중…";
  const { error } = await window.sb
    .from("mentor_calendar_links")
    .upsert({ mentor_id: me.id, ical_url: url, enabled: true }, { onConflict: "mentor_id" });
  if (error) { btn.disabled = false; btn.textContent = "연결"; return Util.toast("연결 실패: " + error.message); }
  Util.toast("연결했어요. 가져오는 중…");
  await syncGcalNow(true);
}

async function syncGcalNow(silent) {
  if (!silent) Util.toast("구글에서 가져오는 중…");
  try {
    const { data: { session } } = await window.sb.auth.getSession();
    const res = await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/sync-google-calendars`, {
      method: "POST",
      headers: {
        apikey: window.APP_CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) Util.toast("동기화 실패: " + (out.error || res.status));
    else Util.toast(`가져왔어요 · ${out.count ?? 0}건`);
  } catch (e) {
    Util.toast("동기화 실패: " + e.message);
  }
  await loadGcalImport();
  await refreshAll();
}

async function disconnectGcal() {
  if (!confirm("연결을 해제하면 구글에서 가져온 일정이 모두 삭제됩니다.\n계속할까요? (직접 등록한 개인 일정은 유지)")) return;
  await window.sb.from("mentor_calendar_links").delete().eq("mentor_id", me.id);
  await window.sb.from("mentor_blocks").delete().eq("mentor_id", me.id).eq("source", "google");
  Util.toast("연결을 해제하고 가져온 일정을 삭제했어요.");
  await loadGcalImport();
  await refreshAll();
}

// ===================== 구글 캘린더 자동 동기화 (구독 피드) =====================
function feedUrlFor(token) {
  return `${window.APP_CONFIG.SUPABASE_URL}/functions/v1/calendar-feed?token=${token}`;
}

async function setupCalendarSync() {
  const input = document.getElementById("feedUrl");
  if (!input) return;

  const { data: token, error } = await window.sb.rpc("my_calendar_token");
  if (error || !token) {
    input.value = "주소를 불러오지 못했어요. 새로고침해 주세요.";
    return;
  }
  input.value = feedUrlFor(token);

  document.getElementById("copyFeed")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      Util.toast("구독 주소를 복사했어요.");
    } catch {
      input.select();
      Util.toast("주소를 길게 눌러 직접 복사해 주세요.");
    }
  });

  document.getElementById("resetFeed")?.addEventListener("click", async () => {
    if (!confirm("주소를 재발급하면 기존 주소로 등록한 구독은 더 이상 갱신되지 않습니다.\n계속할까요?")) return;
    const { data: nt, error: e2 } = await window.sb.rpc("reset_calendar_token");
    if (e2 || !nt) return Util.toast("재발급 실패: " + (e2?.message || ""));
    input.value = feedUrlFor(nt);
    Util.toast("새 주소를 발급했어요. 구글 캘린더에 다시 등록해 주세요.");
  });
}

function setupCalendar() {
  const el = document.getElementById("calendar");
  calendar = new FullCalendar.Calendar(el, {
    initialView: "dayGridMonth",
    locale: "ko",
    height: "auto",
    headerToolbar: IS_MOBILE
      ? { left: "prev,next", center: "title", right: "today" }
      : { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek" },
    buttonText: { today: "오늘", month: "월", week: "주" },
    // 모바일: 칸엔 색 점만(긴 제목 세로쪼개짐 방지), 날짜 탭 → 아래에 그날 일정
    eventDisplay: IS_MOBILE ? "list-item" : "auto",
    dayMaxEvents: IS_MOBILE ? 4 : false,
    dateClick: (info) => { if (IS_MOBILE) selectDay(info.dateStr, info.dayEl); },
    nowIndicator: true,
    eventClick: onEventClick,
  });
  if (IS_MOBILE) el.classList.add("fc-mobile");
  calendar.render();
  // 모바일: 칸 어디를 눌러도 그날 일정 패널이 열리도록 직접 위임
  if (IS_MOBILE) {
    el.addEventListener("click", (e) => {
      const cell = e.target.closest(".fc-daygrid-day");
      if (cell && cell.dataset.date) selectDay(cell.dataset.date, cell);
    });
  }
}

/** 모바일: 날짜 선택 → 강조 + 그날 일정 패널 */
function selectDay(dateStr, dayEl) {
  if (selectedDayEl) selectedDayEl.classList.remove("dd-selected");
  if (dayEl) { dayEl.classList.add("dd-selected"); selectedDayEl = dayEl; }
  showDayDetail(dateStr);
}

function showDayDetail(dateStr) {
  const wrap = document.getElementById("dayDetail");
  if (!wrap) return;
  const sess = view.sessions
    .filter((s) => s.date === dateStr)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  const blks = view.blocks.filter((b) => b.date === dateStr);

  const cards = [];
  sess.forEach((s) => {
    const assigned = view.myProgramIds.has(s.program_id);
    cards.push(`
      <div class="card" style="padding: var(--space-3); box-shadow:none; border-color: var(--color-border-weak)">
        <div class="row-between">
          <strong class="text-sm">${Util.escapeHtml(s.client || s.title)}</strong>
          <span class="badge ${assigned ? "badge-assigned" : "badge-session"}">${assigned ? "내 배정" : "공통"}</span>
        </div>
        <div class="text-caption text-muted">${Util.escapeHtml(s.title)} · ${Util.hhmm(s.start_time)}–${Util.hhmm(s.end_time)}${s.location ? " · " + Util.escapeHtml(s.location) : ""}</div>
      </div>`);
  });
  blks.forEach((b) => {
    const isG = b.source === "google";
    cards.push(`
      <div class="card" style="padding: var(--space-3); box-shadow:none; border-color: var(--color-border-weak)">
        <div class="row-between">
          <strong class="text-sm">🔒 ${isG ? "개인 일정 (구글)" : Util.escapeHtml(b.memo || "개인 일정")}</strong>
          ${isG ? `<span class="text-caption text-muted">구글</span>` : `<button class="btn btn-ghost btn-sm" data-delblock="${b.id}">삭제</button>`}
        </div>
        <div class="text-caption text-muted">${Util.hhmm(b.start_time)}–${Util.hhmm(b.end_time)}</div>
      </div>`);
  });

  wrap.innerHTML =
    `<div class="dd-title">${Util.fmtDate(dateStr)} 일정</div>` +
    (cards.length ? `<div class="stack">${cards.join("")}</div>` : `<p class="text-caption text-muted">이 날은 일정이 없어요.</p>`);

  wrap.querySelectorAll("[data-delblock]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("개인 일정을 삭제할까요?")) return;
      const { error } = await window.sb.from("mentor_blocks").delete().eq("id", btn.dataset.delblock);
      if (error) return Util.toast("삭제 실패: " + error.message);
      Util.toast("삭제했습니다.");
      refreshAll();
    }));
}

async function refreshAll() {
  const [sessions, assignments, blocks] = await Promise.all([
    window.sb.from("education_sessions").select("*").order("date"),
    window.sb.from("assignments").select("*").eq("person_email", me.email),
    window.sb.from("mentor_blocks").select("*").order("date"),
  ]);

  if (sessions.error) return Util.toast("세션 로드 실패: " + sessions.error.message);

  const sessionList = sessions.data || [];
  const myAssign = assignments.data || [];
  const myBlocks = blocks.data || [];
  const myProgramIds = new Set(myAssign.map((a) => a.program_id));

  // 교육(프로그램)별로 회차 묶기
  const sessionsByProgram = {};
  sessionList.forEach((s) => (sessionsByProgram[s.program_id] ||= []).push(s));
  Object.values(sessionsByProgram).forEach((arr) => arr.sort((a, b) => a.date.localeCompare(b.date)));

  view = { sessions: sessionList, blocks: myBlocks, myProgramIds };

  renderCalendar(sessionList, myProgramIds, myBlocks);
  renderMyAssignments(myAssign, sessionsByProgram);

  if (IS_MOBILE) showDayDetail(todayISO()); // 폰: 기본으로 오늘 일정 표시
}

function renderCalendar(sessions, myProgramIds, blocks) {
  calendar.removeAllEvents();

  // 1) 기업 교육 회차 (내가 배정된 교육이면 모든 회차 주황으로 강조)
  sessions.forEach((s) => {
    const assigned = myProgramIds.has(s.program_id);
    calendar.addEvent({
      id: "session-" + s.id,
      title: `${s.client || s.title}`,
      start: Util.toDateTime(s.date, s.start_time),
      end: Util.toDateTime(s.date, s.end_time),
      classNames: [assigned ? "cal-assigned" : "cal-session"],
      extendedProps: { kind: "session", data: s },
    });
  });

  // 2) 내 개인 일정
  blocks.forEach((b) => {
    calendar.addEvent({
      id: "block-" + b.id,
      title: "🔒 " + (b.source === "google" ? "개인 일정 (구글)" : (b.memo || "개인 일정")),
      start: Util.toDateTime(b.date, b.start_time),
      end: Util.toDateTime(b.date, b.end_time),
      classNames: ["cal-block"],
      extendedProps: { kind: "block", data: b },
    });
  });
}

function datesSummary(sess) {
  if (sess.length === 1) return Util.fmtDate(sess[0].date);
  const head = sess.slice(0, 4).map((s) => Util.fmtDate(s.date)).join(", ");
  return `${sess.length}회 · ${head}${sess.length > 4 ? " …" : ""}`;
}

function renderMyAssignments(myAssign, sessionsByProgram) {
  const wrap = document.getElementById("myAssignments");
  if (!myAssign.length) {
    wrap.innerHTML = `<p class="text-caption text-muted">아직 배정된 교육이 없습니다.</p>`;
    return;
  }
  const items = myAssign
    .map((a) => ({ a, sess: sessionsByProgram[a.program_id] || [] }))
    .filter((x) => x.sess.length)
    .sort((x, y) => x.sess[0].date.localeCompare(y.sess[0].date));

  wrap.innerHTML = items
    .map(({ a, sess }) => {
      const rep = sess[0];
      const canRespond = a.status === "제안";
      const typeLabel = a.staff_type === "facilitator" ? "퍼실리테이터" : "멘토";
      const calBtns = sess.length === 1
        ? `<a class="btn btn-secondary btn-sm" href="${Util.gcalUrl(rep)}" target="_blank" rel="noopener">📅 구글 캘린더</a>
           <button class="btn btn-ghost btn-sm" data-ics="${a.program_id}">⬇ .ics</button>`
        : `<button class="btn btn-secondary btn-sm" data-ics="${a.program_id}">⬇ .ics 전체회차(${sess.length})</button>`;
      return `
        <div class="card" style="padding: var(--space-3); box-shadow:none; border-color: var(--color-border-weak)">
          <div class="row-between">
            <strong class="text-sm">${Util.escapeHtml(rep.client || rep.title)}</strong>
            <span class="badge badge-status-${a.status}">${a.status}</span>
          </div>
          <div class="text-caption text-muted">${Util.escapeHtml(rep.title)} · ${typeLabel}</div>
          <div class="text-caption text-muted">${datesSummary(sess)} · ${Util.hhmm(rep.start_time)}–${Util.hhmm(rep.end_time)}</div>
          ${
            canRespond
              ? `<div class="row mt-4" style="gap: var(--space-2)">
                   <button class="btn btn-primary btn-sm" data-accept="${a.id}">수락</button>
                   <button class="btn btn-danger btn-sm" data-reject="${a.id}">거절</button>
                 </div>`
              : ""
          }
          <div class="row mt-4" style="gap: var(--space-2)">${calBtns}</div>
        </div>`;
    })
    .join("");

  wrap.querySelectorAll("[data-accept]").forEach((b) =>
    b.addEventListener("click", () => respond(b.dataset.accept, "수락")));
  wrap.querySelectorAll("[data-reject]").forEach((b) =>
    b.addEventListener("click", () => respond(b.dataset.reject, "거절")));
  wrap.querySelectorAll("[data-ics]").forEach((b) =>
    b.addEventListener("click", () => {
      const sess = sessionsByProgram[b.dataset.ics] || [];
      if (sess.length === 1) Util.downloadIcs(sess[0]);
      else if (sess.length) Util.downloadIcsProgram(sess);
    }));
}

async function respond(assignmentId, status) {
  const { error } = await window.sb
    .from("assignments")
    .update({ status })
    .eq("id", assignmentId);
  if (error) return Util.toast("실패: " + error.message);
  Util.toast(`배정을 ${status}했습니다.`);
  refreshAll();
}

async function onAddBlock(e) {
  e.preventDefault();
  const date = document.getElementById("bDate").value;
  const start = document.getElementById("bStart").value;
  const end = document.getElementById("bEnd").value;
  const memo = document.getElementById("bMemo").value.trim();
  if (!date || !start || !end) return;
  if (end <= start) return Util.toast("종료 시간이 시작보다 늦어야 합니다.");

  const { error } = await window.sb.from("mentor_blocks").insert({
    mentor_id: me.id,
    date,
    start_time: start,
    end_time: end,
    memo,
  });
  if (error) return Util.toast("추가 실패: " + error.message);
  Util.toast("개인 일정을 추가했습니다.");
  e.target.reset();
  document.getElementById("bStart").value = "09:00";
  document.getElementById("bEnd").value = "18:00";
  refreshAll();
}

async function onEventClick(info) {
  const { kind, data } = info.event.extendedProps;
  // 모바일: 점을 탭해도 그날 일정 패널을 열어줌(일관성)
  if (IS_MOBILE) {
    const dayEl = document.querySelector(`.fc-daygrid-day[data-date="${data.date}"]`);
    selectDay(data.date, dayEl);
    document.getElementById("dayDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (kind === "block") {
    if (data.source === "google") {
      alert(`구글 캘린더에서 가져온 일정입니다.\n${Util.fmtDate(data.date)} ${Util.hhmm(data.start_time)}–${Util.hhmm(data.end_time)}\n\n수정/삭제는 구글 캘린더에서 하면 다음 동기화 때 반영됩니다.`);
      return;
    }
    if (confirm(`개인 일정을 삭제할까요?\n${Util.fmtDate(data.date)} ${Util.hhmm(data.start_time)}–${Util.hhmm(data.end_time)}`)) {
      const { error } = await window.sb.from("mentor_blocks").delete().eq("id", data.id);
      if (error) return Util.toast("삭제 실패: " + error.message);
      Util.toast("삭제했습니다.");
      refreshAll();
    }
  } else if (kind === "session") {
    alert(
      `${data.title}\n고객사: ${data.client}\n${Util.fmtDate(data.date)} ${Util.hhmm(data.start_time)}–${Util.hhmm(data.end_time)}\n장소: ${data.location || "-"}\n필요 멘토: ${data.needed_mentors}명\n상태: ${data.status}\n${data.memo || ""}`
    );
  }
}

init();
