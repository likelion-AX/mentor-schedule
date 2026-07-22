// ============================================================================
// mentor.js — 멘토 화면
//  · 캘린더 3색: 기업교육 세션(공통) / 내 배정 / 내 개인일정
//  · 개인일정(mentor_blocks) CRUD (RLS 로 본인 것만)
//  · 내 배정 수락/거절
// ============================================================================

let calendar;
let me; // 프로필
const IS_MOBILE = window.matchMedia("(max-width: 700px)").matches;
let view = { sessions: [], blocks: [], mySessionIds: new Set() };
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
  // 상단 탭: 내 일정 / 개인 일정·구글 / 교육자료 (마지막 탭 기억)
  Util.initTabs({
    list: "#mentorTabs",
    storageKey: "mentorTab",
    onShow: (key) => {
      // 캘린더가 숨은 탭에서 그려지면 크기가 0이 되므로, '내 일정' 탭이 보일 때 재계산
      if (key === "me" && calendar) calendar.updateSize();
    },
  });
  document.getElementById("blockForm").addEventListener("submit", onAddBlock);
  setupCalendarSync();

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
    const assigned = view.mySessionIds.has(s.id);
    cards.push(`
      <div class="card" style="padding: var(--space-3); box-shadow:none; border-color: var(--color-border-weak)">
        <div class="row-between">
          <strong class="text-sm">${Util.escapeHtml(s.client || s.title)}</strong>
          <span class="badge ${assigned ? "badge-assigned" : "badge-session"}">${assigned ? "내 배정" : "공통"}</span>
        </div>
        <div class="text-caption text-muted">${Util.escapeHtml(s.title)} · ${Util.hhmm(s.start_time)}–${Util.hhmm(s.end_time)}${s.location ? " · " + Util.escapeHtml(s.location) : ""}</div>
        ${s.memo ? `<div class="text-caption text-muted">📝 ${Util.escapeHtml(s.memo)}</div>` : ""}
      </div>`);
  });
  blks.forEach((b) => {
    cards.push(`
      <div class="card" style="padding: var(--space-3); box-shadow:none; border-color: var(--color-border-weak)">
        <div class="row-between">
          <strong class="text-sm">🔒 ${Util.escapeHtml(b.memo || "개인 일정")}</strong>
          <button class="btn btn-ghost btn-sm" data-delblock="${b.id}">삭제</button>
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
  const [sessions, assignments, blocks, assignSessions] = await Promise.all([
    window.sb.from("education_sessions").select("*").order("date"),
    window.sb.from("assignments").select("*").eq("person_email", me.email),
    window.sb.from("mentor_blocks").select("*").order("date"),
    window.sb.from("assignment_sessions").select("*"), // RLS가 본인 배정 것만 돌려준다
  ]);

  if (sessions.error) return Util.toast("세션 로드 실패: " + sessions.error.message);

  const sessionList = sessions.data || [];
  const myAssign = assignments.data || [];
  const myBlocks = blocks.data || [];

  // 배정별 참여 회차. session-assign.sql 실행 전이면 조용히 빈 목록 —
  // 그러면 "행 없음 = 전 회차 참여" 규약대로 마이그레이션 전과 동일하게 동작한다.
  const assignSessionIds = {}; // assignment_id → Set(session_id)
  (assignSessions.error ? [] : (assignSessions.data || [])).forEach((x) => {
    (assignSessionIds[x.assignment_id] ||= new Set()).add(x.session_id);
  });

  // 교육(프로그램)별로 회차 묶기
  const sessionsByProgram = {};
  sessionList.forEach((s) => (sessionsByProgram[s.program_id] ||= []).push(s));
  Object.values(sessionsByProgram).forEach((arr) => arr.sort((a, b) => a.date.localeCompare(b.date)));

  // 내가 실제로 가는 회차 id 집합. 배정은 교육 단위지만 참여는 회차 단위일 수 있어서,
  // program_id 로 판단하면 안 가는 날까지 '내 배정'으로 칠해진다.
  const mySessionIds = new Set();
  myAssign.forEach((a) => {
    const ids = assignSessionIds[a.id];
    if (ids && ids.size) ids.forEach((id) => mySessionIds.add(id));
    else (sessionsByProgram[a.program_id] || []).forEach((s) => mySessionIds.add(s.id));
  });

  view = { sessions: sessionList, blocks: myBlocks, mySessionIds };

  renderCalendar(sessionList, mySessionIds, myBlocks);
  renderMyAssignments(myAssign, sessionsByProgram, assignSessionIds);

  if (IS_MOBILE) showDayDetail(todayISO()); // 폰: 기본으로 오늘 일정 표시
}

function renderCalendar(sessions, mySessionIds, blocks) {
  calendar.removeAllEvents();

  // 1) 기업 교육 회차 (내가 가는 회차만 주황으로 강조 — 같은 교육이라도 안 가는 회차는 회색)
  sessions.forEach((s) => {
    const assigned = mySessionIds.has(s.id);
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
      title: "🔒 " + (b.memo || "개인 일정"),
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

function renderMyAssignments(myAssign, sessionsByProgram, assignSessionIds = {}) {
  const wrap = document.getElementById("myAssignments");
  if (!myAssign.length) {
    wrap.innerHTML = `<p class="text-caption text-muted">아직 배정된 교육이 없습니다.</p>`;
    return;
  }
  // 참여 회차를 먼저 확정한다 — 카드 정렬·표시·캘린더가 전부 이 값을 기준으로 움직인다.
  // 행이 없으면 전 회차(session-assign.sql 규약). 행은 있는데 그 회차가 전부 지워졌으면
  // mySess 가 비므로 아래 filter 에서 카드 자체를 빼 rep 이 undefined 가 되는 걸 막는다.
  const items = myAssign
    .map((a) => {
      const sess = sessionsByProgram[a.program_id] || [];
      const myIds = assignSessionIds[a.id];
      return { a, sess, mySess: myIds && myIds.size ? sess.filter((s) => myIds.has(s.id)) : sess };
    })
    .filter((x) => x.mySess.length)
    .sort((x, y) => x.mySess[0].date.localeCompare(y.mySess[0].date));

  const mySessById = {}; // 배정 id → 참여 회차 (아래 .ics 핸들러가 씀)

  wrap.innerHTML = items
    .map(({ a, sess, mySess }) => {
      const canRespond = a.status === "제안";
      const typeLabel = a.staff_type === "facilitator" ? "퍼실리테이터" : "멘토";
      mySessById[a.id] = mySess;
      // 이 카드의 날짜·시간·캘린더는 전부 mySess 기준이어야 한다. sess(교육 전체)를 쓰면
      // "2회차 참여"라고 써놓고 안 가는 날짜를 안내하게 되고, .ics 로 남의 회차까지
      // 본인 캘린더에 넣어버린다. 대표 시간(rep)도 내가 가는 첫 회차여야 함.
      const rep = mySess[0];
      // 강사료 — 본인 배정 행에만 들어있고(RLS), 단가가 정해진 경우에만 보여준다.
      // 반드시 "참여 회차"로만 계산한다 — 교육 전체로 계산하면 일부만 참여하는 사람에게
      // 실제보다 큰 금액이 표시된다.
      const paidMins = mySess.reduce(
        (sum, s) => sum + Math.max(0, Util.durationMins(s.start_time, s.end_time) - (s.break_mins || 0)), 0);
      const partTxt = mySess.length < sess.length ? ` · 전체 ${sess.length}회차 중 ${mySess.length}회차 참여` : "";
      const feeLine = a.fee_per_hour
        ? `<div class="text-caption" style="margin-top:6px; color:var(--color-fg-normal)">
             💰 강사료 <b>${Util.won(Math.round((paidMins / 60) * a.fee_per_hour))}</b>
             <span class="text-muted">(시간당 ${Util.won(a.fee_per_hour)} × ${Util.minsLabel(paidMins)} · 세전${partTxt})</span>
             ${a.fee_note ? `<br><span class="text-muted">${Util.escapeHtml(a.fee_note)}</span>` : ""}
           </div>`
        : "";
      const calBtns = mySess.length === 1
        ? `<a class="btn btn-ghost btn-sm" href="${Util.gcalUrl(rep)}" target="_blank" rel="noopener">📅 구글</a>
           <button class="btn btn-ghost btn-sm" data-ics="${a.id}">⬇ .ics</button>`
        : `<button class="btn btn-ghost btn-sm" data-ics="${a.id}">⬇ .ics (${mySess.length}회)</button>`;
      return `
        <div class="card" style="padding: var(--space-3); box-shadow:none; border-color: var(--color-border-weak)">
          <div class="row-between">
            <strong class="text-sm">${Util.escapeHtml(rep.client || rep.title)}</strong>
            <span class="badge badge-status-${a.status}">${a.status}</span>
          </div>
          <div class="text-caption text-muted">${Util.escapeHtml(rep.title)} · ${typeLabel}</div>
          <div class="text-caption text-muted">${datesSummary(mySess)} · ${Util.hhmm(rep.start_time)}–${Util.hhmm(rep.end_time)}</div>
          ${feeLine}
          ${
            canRespond
              ? `<div class="row mt-4" style="gap: var(--space-2)">
                   <button class="btn btn-primary btn-sm" data-accept="${a.id}">수락</button>
                   <button class="btn btn-danger btn-sm" data-reject="${a.id}">거절</button>
                 </div>`
              : ""
          }
          ${a.status !== "거절"
            ? `<div class="row mt-4" style="gap: var(--space-1); align-items:center">
                 <span class="text-caption text-muted" style="margin-right: 2px">캘린더 추가</span>${calBtns}
               </div>`
            : ""}
        </div>`;
    })
    .join("");

  wrap.querySelectorAll("[data-accept]").forEach((b) =>
    b.addEventListener("click", () => respond(b.dataset.accept, "수락")));
  wrap.querySelectorAll("[data-reject]").forEach((b) =>
    b.addEventListener("click", () => respond(b.dataset.reject, "거절")));
  // 배정 id → 내가 참여하는 회차. program_id 로 찾으면 교육 전체가 나와서
  // 안 가는 회차까지 .ics 에 실린다.
  wrap.querySelectorAll("[data-ics]").forEach((b) =>
    b.addEventListener("click", () => {
      const sess = mySessById[b.dataset.ics] || [];
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

function onEventClick(info) {
  const { data } = info.event.extendedProps;
  // 데스크톱·모바일 공통: 브라우저 alert 대신 '그날 일정' 패널을 열어 상세·삭제를 보여줌
  const dayEl = document.querySelector(`.fc-daygrid-day[data-date="${data.date}"]`);
  selectDay(data.date, dayEl);
  document.getElementById("dayDetail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

init();
