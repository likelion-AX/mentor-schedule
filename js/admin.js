// ============================================================================
// admin.js — 운영팀 화면 (교육=프로그램 단위 배정)
//  · 같은 교육의 여러 회차(날짜)는 program_id 로 묶임.
//  · 배정(assignments)은 교육(program_id) 단위 → 한 번 배정하면 모든 회차에 적용.
//  · 멘토/퍼실 명단 분리, 명단 기준 배정(미가입자 포함).
// ============================================================================

let me;
let calendar;
let state = {
  sessions: [],
  programs: [],        // 교육 단위로 묶은 목록
  programById: {},
  roster: [],
  rosterByEmail: {},
  mentorsById: {},
  blocksByEmail: {},
  assignments: [],     // {id, program_id, person_email, staff_type, status}
  selectedProgramId: null,
};
const TYPE_LABEL = { mentor: "멘토", facilitator: "퍼실리테이터" };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "p-" + Date.now() + "-" + Math.floor(Math.random() * 1e9));

// 교육(프로그램)마다 고유 색 — 같은 날 여러 교육 구별용
const PROG_COLORS = ["#FF6000", "#2077E5", "#0DA796", "#9855D4", "#D3689F", "#CB9100", "#E12337", "#4A7F05", "#3D94FF", "#005448"];
function progColor(pid) {
  let h = 0;
  for (let i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) >>> 0;
  return PROG_COLORS[h % PROG_COLORS.length];
}

async function init() {
  me = await Auth.requireAuth({ admin: true });
  Auth.renderUserArea(me, document.getElementById("userArea"));

  document.getElementById("newSessionBtn").addEventListener("click", () => openModal());
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
  document.getElementById("sessionForm").addEventListener("submit", saveProgram);
  document.getElementById("deleteSessionBtn").addEventListener("click", deleteProgram);

  document.getElementById("addRowBtn").addEventListener("click", () => addSessionRow());
  document.getElementById("repeatToggleBtn").addEventListener("click", () => {
    document.getElementById("repeatBox").classList.toggle("hidden");
    updateRepeatPreview();
  });
  document.getElementById("repeatFillBtn").addEventListener("click", repeatFill);
  // 기본 장소를 바꾸면 비어있는 회차 칸 안내문(placeholder)도 같이 갱신
  document.getElementById("sLocation").addEventListener("input", () => {
    const ph = sessionLocPlaceholder();
    document.querySelectorAll("#sessionRows .sr-loc").forEach((inp) => { inp.placeholder = ph; });
  });
  ["rStartDate", "sCount"].forEach((id) =>
    document.getElementById(id).addEventListener("input", updateRepeatPreview));
  document.querySelectorAll("#weekdays .wd-btn").forEach((b) =>
    b.addEventListener("click", () => { b.classList.toggle("active"); updateRepeatPreview(); }));

  initSmartAdd();

  const imgSearch = document.getElementById("imgSearch");
  document.getElementById("imgSearchBtn").addEventListener("click", () => callScheduleImage(imgSearch.value.trim()));
  imgSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); callScheduleImage(imgSearch.value.trim()); }
  });
  // 자동완성 목록에서 고르면 바로 이미지 열기
  imgSearch.addEventListener("change", () => {
    const q = imgSearch.value.trim();
    if (q && findProgramsByName(q).length === 1) callScheduleImage(q);
  });

  document.getElementById("shareImgClose").addEventListener("click", closeShareImage);
  document.getElementById("shareImageModal").addEventListener("click", (e) => {
    if (e.target.id === "shareImageModal") closeShareImage();
  });
  document.getElementById("shareImgDownloadBtn").addEventListener("click", downloadShareImage);
  document.getElementById("shareImgCopyBtn").addEventListener("click", copyShareImage);

  document.getElementById("msClose").addEventListener("click", closeMentorSchedule);
  document.getElementById("mentorScheduleModal").addEventListener("click", (e) => {
    if (e.target.id === "mentorScheduleModal") closeMentorSchedule();
  });

  document.querySelectorAll("[data-invite]").forEach((b) =>
    b.addEventListener("click", () => openInviteModal(b.dataset.invite)));
  document.getElementById("cancelInviteBtn").addEventListener("click", closeInviteModal);
  document.getElementById("inviteForm").addEventListener("submit", savePerson);
  document.getElementById("deletePersonBtn").addEventListener("click", () => {
    const email = document.getElementById("iEditEmail").value;
    if (email) { closeInviteModal(); deleteInvite(email); }
  });

  setupCalendar();
  await loadAll();
}

// ---------- 데이터 ----------
async function loadAll() {
  const [sessions, roster, mentors, blocks, assignments] = await Promise.all([
    window.sb.from("education_sessions").select("*").order("date"),
    window.sb.from("invites").select("*").order("created_at"),
    window.sb.from("mentors").select("*"),
    window.sb.from("mentor_blocks").select("*"),
    window.sb.from("assignments").select("*"),
  ]);
  if (sessions.error) return Util.toast("로드 실패: " + sessions.error.message);

  state.sessions = sessions.data || [];
  buildPrograms();

  state.roster = roster.data || [];
  state.rosterByEmail = {};
  state.roster.forEach((r) => (state.rosterByEmail[r.email] = r));

  state.mentorsById = {};
  (mentors.data || []).forEach((m) => (state.mentorsById[m.id] = m));
  state.blocksByEmail = {};
  (blocks.data || []).forEach((b) => {
    const email = state.mentorsById[b.mentor_id]?.email;
    if (email) (state.blocksByEmail[email] ||= []).push(b);
  });

  state.assignments = assignments.data || [];

  renderCalendar();
  renderProgramList();
  renderRosters();
  fillProgramDatalist();
  if (state.selectedProgramId && !state.programById[state.selectedProgramId]) state.selectedProgramId = null;
  renderBoard();

  // URL로 바로 호출: admin.html?img=교육명
  if (!urlImgHandled) {
    urlImgHandled = true;
    const q = new URLSearchParams(location.search).get("img");
    if (q) callScheduleImage(q);
  }
}
let urlImgHandled = false;

function buildPrograms() {
  const map = {};
  state.sessions.forEach((s) => {
    (map[s.program_id] ||= []).push(s);
  });
  state.programs = Object.entries(map).map(([id, sess]) => {
    sess.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
    const r = sess[0];
    const timeVaries = sess.some((s) => s.start_time !== r.start_time || s.end_time !== r.end_time);
    const locationVaries = sess.some((s) => (s.location || "") !== (r.location || ""));
    return {
      id,
      title: r.title, client: r.client, location: r.location, locationVaries,
      needed_mentors: r.needed_mentors, needed_facilitators: r.needed_facilitators,
      status: r.status, memo: r.memo, start_time: r.start_time, end_time: r.end_time, timeVaries,
      sessions: sess, firstDate: sess[0].date, lastDate: sess[sess.length - 1].date,
      doneCount: sess.filter((s) => s.done).length,
    };
  });
  state.programs.sort((a, b) => a.firstDate.localeCompare(b.firstDate));
  state.programById = {};
  state.programs.forEach((p) => (state.programById[p.id] = p));
}

function rosterOf(type) { return state.roster.filter((r) => r.staff_type === type); }
function nameOf(email) { return state.rosterByEmail[email]?.name || email.split("@")[0]; }
function assignedFor(programId, type) {
  return state.assignments
    .filter((a) => a.program_id === programId && a.staff_type === type)
    .map((a) => ({ id: a.id, email: a.person_email, status: a.status, name: nameOf(a.person_email) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function confirmedCount(programId, type) {
  return state.assignments.filter(
    (a) => a.program_id === programId && a.staff_type === type && (a.status === "수락" || a.status === "확정")
  ).length;
}
function programConflicts(program, blocks) {
  return program.sessions.some((s) => Util.sessionConflictsBlocks(s, blocks));
}

/** 이 사람이 배정된 '다른 교육'의 회차와 시간이 겹치는지 → 겹치는 교육 객체 반환(없으면 null) */
function assignmentConflict(program, email) {
  const otherIds = state.assignments
    .filter((a) => a.person_email === email && a.program_id !== program.id)
    .map((a) => a.program_id);
  for (const oid of new Set(otherIds)) {
    const other = state.programById[oid];
    if (!other) continue;
    for (const s1 of program.sessions) {
      for (const s2 of other.sessions) {
        if (s1.date === s2.date && Util.overlaps(s1.start_time, s1.end_time, s2.start_time, s2.end_time)) {
          return other;
        }
      }
    }
  }
  return null;
}

// ---------- 캘린더 (회차=날짜로 표시, 배정은 교육 기준) ----------
function setupCalendar() {
  calendar = new FullCalendar.Calendar(document.getElementById("calendar"), {
    initialView: "dayGridMonth",
    locale: "ko",
    height: 760,
    expandRows: true,
    headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,listWeek" },
    buttonText: { today: "오늘", month: "월", week: "주", list: "목록" },
    dayMaxEvents: 4,
    nowIndicator: true,
    selectable: true,
    dateClick: (info) => openModal(null, info.dateStr),
    eventClick: (info) => {
      hideEventTip();
      state.selectedProgramId = info.event.extendedProps.programId;
      renderBoard();
      renderProgramList();
      document.querySelector(".board-col")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    // 기본은 한 줄(회사명 + 시작시간)만. 상세는 마우스 오버 시 떠다니는 카드로.
    eventContent: (arg) => {
      const s = arg.event.extendedProps.data;
      const top = s.client || s.title;
      const color = progColor(s.program_id);
      return {
        html: `<div class="ev ev-compact" style="border-left:3px solid ${color}">
          ${s.done ? `<span class="ev-done-badge">✓</span>` : ""}
          <span class="ev-client">${Util.escapeHtml(top)}</span>
          <span class="ev-time">${Util.hhmm(s.start_time)}</span>
        </div>`,
      };
    },
    eventMouseEnter: (info) => showEventTip(info.event.extendedProps.data, info.el.getBoundingClientRect()),
    eventMouseLeave: hideEventTip,
  });
  document.getElementById("calendar").classList.add("fc-admin");
  calendar.render();
}

// ---------- 캘린더 이벤트 호버 툴팁 (body에 띄워 셀 잘림/레이아웃 밀림 방지) ----------
let evTip = null;
function hideEventTip() {
  if (evTip) { evTip.remove(); evTip = null; }
}
function showEventTip(s, rect) {
  hideEventTip();
  const pid = s.program_id;
  const mentors = assignedFor(pid, "mentor").map((c) => c.name).join(", ");
  const dur = Util.durationLabel(s.start_time, s.end_time);
  const facs = assignedFor(pid, "facilitator").map((c) => c.name).join(", ");
  const mc = `${confirmedCount(pid, "mentor")}/${s.needed_mentors}`;
  const fc = `${confirmedCount(pid, "facilitator")}/${s.needed_facilitators}`;
  const sub = s.client && s.title && s.title !== s.client ? s.title : "";
  const color = progColor(pid);
  evTip = document.createElement("div");
  evTip.className = "ev-tip";
  evTip.innerHTML = `
    <div class="ev-tip-head" style="border-left:4px solid ${color}">
      ${s.done ? `<span class="ev-tip-done">✓ 수행완료</span>` : ""}
      <div class="ev-tip-title">${Util.escapeHtml(s.client || s.title)}</div>
      ${sub ? `<div class="ev-tip-sub">${Util.escapeHtml(sub)}</div>` : ""}
    </div>
    <div class="ev-tip-row">🕒 ${Util.hhmm(s.start_time)}~${Util.hhmm(s.end_time)} · ${dur}</div>
    ${s.location ? `<div class="ev-tip-row">📍 ${Util.escapeHtml(s.location)}</div>` : ""}
    <div class="ev-tip-row">👤 멘토 ${mc} · ${mentors ? Util.escapeHtml(mentors) : "미배정"}</div>
    ${(s.needed_facilitators || facs) ? `<div class="ev-tip-row">🧑‍🏫 퍼실 ${fc} · ${facs ? Util.escapeHtml(facs) : "미배정"}</div>` : ""}
    ${s.note ? `<div class="ev-tip-row ev-tip-note">📝 ${Util.escapeHtml(s.note)}</div>` : ""}`;
  document.body.appendChild(evTip);

  // 위치: 이벤트 아래. 화면 밖이면 위/왼쪽으로 보정.
  const tw = evTip.offsetWidth, th = evTip.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let left = rect.left;
  if (left + tw > vw - 8) left = vw - tw - 8;
  let top = rect.bottom + 6;
  if (top + th > vh - 8) top = rect.top - th - 6; // 아래 공간 없으면 위로
  evTip.style.left = Math.max(8, left) + window.scrollX + "px";
  evTip.style.top = Math.max(8, top) + window.scrollY + "px";
}

function renderCalendar() {
  if (!calendar) return;
  calendar.removeAllEvents();
  state.sessions.forEach((s) => {
    calendar.addEvent({
      id: s.id,
      start: Util.toDateTime(s.date, s.start_time),
      end: Util.toDateTime(s.date, s.end_time),
      classNames: s.done ? ["s-" + s.status, "s-done"] : ["s-" + s.status],
      extendedProps: { data: s, programId: s.program_id },
    });
  });
}

// ---------- 교육 목록 (교육 1개 = 1행) ----------
function chipsHtml(programId, type) {
  const chips = assignedFor(programId, type);
  if (!chips.length) return `<span class="text-caption" style="color:var(--color-info-negative)">미배정</span>`;
  return `<div class="mentor-chips">${chips
    .map((c) => {
      const cls = c.status === "확정" ? "done" : c.status === "제안" ? "pending" : "";
      return `<span class="mentor-chip ${cls}">${Util.escapeHtml(c.name)}<span style="opacity:.7">·${c.status}</span></span>`;
    })
    .join("")}</div>`;
}

function programDatesLabel(p) {
  if (p.sessions.length === 1) return Util.fmtDate(p.firstDate);
  return `${p.sessions.length}회 · ${Util.fmtDate(p.firstDate)} ~ ${Util.fmtDate(p.lastDate)}`;
}

function renderProgramList() {
  const tbody = document.getElementById("sessionList");
  if (!state.programs.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-caption text-muted">교육이 없습니다. “+ 새 교육”으로 추가하세요.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.programs
    .map((p) => {
      const selected = p.id === state.selectedProgramId;
      const statusCls = p.status === "모집중" ? "제안" : p.status === "확정" ? "확정" : p.status === "완료" ? "수락" : "거절";
      const facLine = p.needed_facilitators || assignedFor(p.id, "facilitator").length
        ? `<div style="margin-top:4px"><span class="text-caption text-muted">퍼실</span> ${chipsHtml(p.id, "facilitator")} <span class="text-caption text-muted">(${confirmedCount(p.id, "facilitator")}/${p.needed_facilitators})</span></div>`
        : "";
      return `
        <tr data-row="${p.id}" style="cursor:pointer; ${selected ? "background: var(--color-bg-primary-weak)" : ""}">
          <td class="text-sm" style="white-space:nowrap">${programDatesLabel(p)}</td>
          <td>
            <div class="text-sm" style="font-weight: var(--font-weight-bold)">${Util.escapeHtml(p.client || "-")}</div>
            <div class="text-caption text-muted">${Util.escapeHtml(p.title)}</div>
          </td>
          <td class="text-sm" style="white-space:nowrap">${p.timeVaries ? "<span class='text-caption text-muted'>회차별 상이</span>" : Util.hhmm(p.start_time) + "~" + Util.hhmm(p.end_time)}</td>
          <td>${p.timeVaries ? "<span class='text-caption text-muted'>—</span>" : `<span class="runtime">⏱ ${Util.durationLabel(p.start_time, p.end_time)}</span>`}</td>
          <td class="text-sm">${p.locationVaries ? "<span class='text-caption text-muted'>회차별 상이</span>" : Util.escapeHtml(p.location || "-")}</td>
          <td>
            <div><span class="text-caption text-muted">멘토</span> ${chipsHtml(p.id, "mentor")} <span class="text-caption text-muted">(${confirmedCount(p.id, "mentor")}/${p.needed_mentors})</span></div>
            ${facLine}
          </td>
          <td>
            <span class="badge badge-status-${statusCls}">${p.status}</span>
            ${p.doneCount ? `<div class="text-caption" style="margin-top:4px; color:var(--color-info-positive)">✅ 수행 ${p.doneCount}/${p.sessions.length}</div>` : ""}
          </td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn btn-ghost btn-sm" data-img="${p.id}" title="멘토 공유용 안내 이미지">🖼 이미지</button>
            <button class="btn btn-ghost btn-sm" data-edit="${p.id}">편집</button>
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-row]").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit],[data-img]")) return;
      state.selectedProgramId = tr.dataset.row;
      renderBoard();
      renderProgramList();
      document.querySelector(".board-col")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
  tbody.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = state.programById[b.dataset.edit];
      if (p) openModal(p);
    }));
  tbody.querySelectorAll("[data-img]").forEach((b) =>
    b.addEventListener("click", () => openShareImage(b.dataset.img)));
}

// ---------- 배정 보드 (교육 단위) ----------
function renderBoard() {
  const p = state.programById[state.selectedProgramId];
  const board = document.getElementById("board");
  const head = document.getElementById("boardHead");
  if (!p) {
    head.innerHTML = `<div class="card-title" style="margin:0">배정 보드</div>`;
    board.innerHTML = `<div class="empty-state">캘린더나 목록에서 교육을 선택하세요.</div>`;
    return;
  }
  head.innerHTML = `
    <div>
      <div class="card-title" style="margin:0">${Util.escapeHtml(p.client || p.title)}</div>
      <div class="text-caption text-muted">${Util.escapeHtml(p.title)} · ${p.timeVaries ? p.sessions.length + "회차(시간 상이)" : Util.hhmm(p.start_time) + "~" + Util.hhmm(p.end_time) + " · " + Util.durationLabel(p.start_time, p.end_time)}</div>
    </div>
    <div class="row" style="gap: var(--space-1)">
      <button class="btn btn-secondary btn-sm" id="shareImgBtn" title="멘토 공유용 안내 이미지">🖼 안내 이미지</button>
      <button class="btn btn-secondary btn-sm" id="editSessionBtn">교육 편집</button>
    </div>`;
  head.querySelector("#editSessionBtn").addEventListener("click", () => openModal(p));
  head.querySelector("#shareImgBtn").addEventListener("click", () => openShareImage(p.id));

  board.innerHTML = `
    <div style="margin-bottom: var(--space-5)">
      <div class="row-between" style="margin-bottom: var(--space-2)">
        <strong class="text-sm">회차별 수행</strong>
        <span class="text-caption text-muted">완료 ${p.doneCount}/${p.sessions.length} · 시간 변경은 ‘교육 편집’</span>
      </div>
      <div class="session-runs">
        ${p.sessions.map((s) => sessionRunRow(s)).join("")}
      </div>
    </div>
    ${boardSection(p, "mentor", p.needed_mentors)}
    ${boardSection(p, "facilitator", p.needed_facilitators)}`;

  board.querySelectorAll("[data-done]").forEach((cb) =>
    cb.addEventListener("change", () => setSessionDone(cb.dataset.done, cb.checked)));
  board.querySelectorAll("[data-note]").forEach((inp) =>
    inp.addEventListener("change", () => setSessionNote(inp.dataset.note, inp.value.trim())));
  board.querySelectorAll("[data-board-schedule]").forEach((b) =>
    b.addEventListener("click", () => openMentorSchedule(b.dataset.boardSchedule)));
  board.querySelectorAll("[data-assign]").forEach((b) =>
    b.addEventListener("click", () => assignPerson(p.id, b.dataset.assign, b.dataset.type)));
  board.querySelectorAll("[data-unassign]").forEach((b) =>
    b.addEventListener("click", () => unassign(b.dataset.unassign)));
  board.querySelectorAll("[data-confirm]").forEach((b) =>
    b.addEventListener("click", () => setAssignStatus(b.dataset.confirm, "확정")));
}

// done/note 컬럼이 아직 DB에 없을 때(마이그레이션 전)를 감지 — 미리보기 폴백용.
// SQL(done.sql) 실행 후엔 이 분기를 타지 않고 실제 저장된다.
function isMissingColumn(error) {
  const m = ((error?.message || "") + " " + (error?.code || "")).toLowerCase();
  return error?.code === "PGRST204" || error?.code === "42703" ||
    (m.includes("column") && (m.includes("does not exist") || m.includes("could not find") || m.includes("schema cache")));
}

// 회차 1줄: 완료 체크 + 특이사항 입력 (운영팀이 교육 진행 후 기록)
function sessionRunRow(s) {
  return `
    <div class="run-row ${s.done ? "run-done" : ""}">
      <label class="run-check">
        <input type="checkbox" data-done="${s.id}" ${s.done ? "checked" : ""} />
        <span class="run-date">${Util.fmtDate(s.date)} <span class="text-caption text-muted">${Util.hhmm(s.start_time)}~${Util.hhmm(s.end_time)}</span>${s.location ? `<span class="run-loc text-caption text-muted">📍 ${Util.escapeHtml(s.location)}</span>` : ""}</span>
      </label>
      <input class="input run-note" data-note="${s.id}" value="${Util.escapeHtml(s.note || "")}" placeholder="특이사항 (예: 결석 2명, 장비 지연)" />
    </div>`;
}

async function setSessionDone(sessionId, done) {
  const { error } = await window.sb.from("education_sessions").update({ done }).eq("id", sessionId);
  // 컬럼이 없으면(마이그레이션 전) 화면만 토글하는 미리보기로 동작. 그 외 오류는 진짜 실패.
  if (error && !isMissingColumn(error)) { Util.toast("저장 실패: " + error.message); return loadAll(); }
  const s = state.sessions.find((x) => x.id === sessionId);
  if (s) s.done = done;
  Util.toast(error ? "👀 미리보기 — DB 컬럼 추가 전이라 저장은 안 됩니다" : (done ? "수행 완료로 표시했습니다." : "완료 표시를 해제했습니다."));
  buildPrograms();
  renderCalendar();
  renderProgramList();
  renderBoard();
}

async function setSessionNote(sessionId, note) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || (s.note || "") === note) return; // 변경 없음
  s.note = note; // 로컬 즉시 반영 (재렌더 시 입력값 보존)
  const { error } = await window.sb.from("education_sessions").update({ note }).eq("id", sessionId);
  if (error && !isMissingColumn(error)) return Util.toast("특이사항 저장 실패: " + error.message);
  Util.toast(error ? "👀 미리보기 — DB 컬럼 추가 전이라 저장은 안 됩니다" : "특이사항을 저장했습니다.");
}

function boardSection(program, type, needed) {
  const list = rosterOf(type);
  const rows = list.map((person) => {
    const assign = state.assignments.find(
      (a) => a.program_id === program.id && a.person_email === person.email && a.staff_type === type);
    const blockConflict = person.used ? programConflicts(program, state.blocksByEmail[person.email] || []) : false;
    const dupProgram = assignmentConflict(program, person.email);
    return { person, assign, blockConflict, dupProgram, conflict: blockConflict || !!dupProgram, registered: person.used };
  });
  rows.sort((a, b) => {
    if (a.conflict !== b.conflict) return a.conflict ? 1 : -1;
    if (!!a.assign !== !!b.assign) return a.assign ? -1 : 1;
    return (a.person.name || "").localeCompare(b.person.name || "");
  });
  const confirmed = confirmedCount(program.id, type);
  const body = list.length
    ? rows.map((r) => boardRow(type, r)).join("")
    : `<tr><td colspan="4" class="text-caption text-muted">${TYPE_LABEL[type]} 명단이 비어 있어요. 아래에서 초대하세요.</td></tr>`;
  return `
    <div style="margin-bottom: var(--space-5)">
      <div class="row-between" style="margin-bottom: var(--space-2)">
        <strong class="text-sm">${TYPE_LABEL[type]} 배정</strong>
        <span class="badge badge-neutral">확정 ${confirmed} / 필요 ${needed || 0}</span>
      </div>
      <table class="table">
        <thead><tr><th>${TYPE_LABEL[type]}</th><th>가용</th><th>상태</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function boardRow(type, r) {
  const { person, assign, blockConflict, dupProgram, registered } = r;
  const conflict = blockConflict || !!dupProgram;
  const gray = conflict && !assign ? "color: var(--color-fg-disabled)" : "";
  let avail;
  if (!registered) avail = `<span class="badge badge-neutral">미가입</span>`;
  else if (dupProgram) avail = `<span class="badge badge-status-거절" title="${Util.escapeHtml(dupProgram.client || dupProgram.title)} 시간 겹침">중복배정</span>`;
  else if (blockConflict) avail = `<span class="badge badge-status-거절">개인일정 충돌</span>`;
  else avail = `<span class="badge badge-status-확정">가능</span>`;
  let statusCell = `<span class="text-caption text-muted">—</span>`;
  let actionCell = `<button class="btn btn-secondary btn-sm" data-assign="${Util.escapeHtml(person.email)}" data-type="${type}">배정</button>`;
  if (assign) {
    statusCell = `<span class="badge badge-status-${assign.status}">${assign.status}</span>`;
    const confirmBtn = assign.status === "수락"
      ? `<button class="btn btn-primary btn-sm" data-confirm="${assign.id}">확정</button>` : "";
    actionCell = `<div class="row" style="gap: var(--space-1)">${confirmBtn}<button class="btn btn-ghost btn-sm" data-unassign="${assign.id}">해제</button></div>`;
  }
  return `
    <tr>
      <td style="${gray}">
        <div class="text-sm" data-board-schedule="${Util.escapeHtml(person.email)}" style="font-weight: var(--font-weight-semibold); cursor:pointer; text-decoration:underline; text-decoration-style:dotted">${Util.escapeHtml(person.name)} 📅</div>
        <div class="text-caption text-muted">${person.email.endsWith("@pending.local") ? "이메일 미정" : Util.escapeHtml(person.email)}</div>
      </td>
      <td>${avail}</td>
      <td>${statusCell}</td>
      <td style="text-align:right">${actionCell}</td>
    </tr>`;
}

async function assignPerson(programId, email, type) {
  const p = state.programById[programId];
  const dup = assignmentConflict(p, email);
  const blockConf = state.blocksByEmail[email] && programConflicts(p, state.blocksByEmail[email]);
  if (dup) {
    if (!confirm(`이 사람은 이미 '${dup.client || dup.title}'에 배정돼 시간이 겹칩니다. 그래도 중복 배정할까요?`)) return;
  } else if (blockConf) {
    if (!confirm("이 사람은 일부 회차에서 개인 일정과 충돌합니다. 그래도 배정할까요?")) return;
  }
  const { error } = await window.sb.from("assignments").insert({
    program_id: programId, person_email: email, staff_type: type, status: "제안",
  });
  if (error) return Util.toast("배정 실패: " + error.message);
  Util.toast("배정을 제안했습니다. (모든 회차 적용)");
  loadAll();
}
async function unassign(id) {
  const { error } = await window.sb.from("assignments").delete().eq("id", id);
  if (error) return Util.toast("해제 실패: " + error.message);
  Util.toast("배정을 해제했습니다.");
  loadAll();
}
async function setAssignStatus(id, status) {
  const { error } = await window.sb.from("assignments").update({ status }).eq("id", id);
  if (error) return Util.toast("실패: " + error.message);
  Util.toast(`배정을 ${status}했습니다.`);
  loadAll();
}

// 회차 추가/삭제 (교육 단위)
async function addDate(program, dateStr) {
  if (program.sessions.some((s) => s.date === dateStr)) return Util.toast("이미 있는 회차입니다.");
  const { error } = await window.sb.from("education_sessions").insert({
    program_id: program.id, title: program.title, client: program.client, location: program.location,
    needed_mentors: program.needed_mentors, needed_facilitators: program.needed_facilitators,
    status: program.status, memo: program.memo, start_time: program.start_time, end_time: program.end_time,
    date: dateStr, created_by: me.id,
  });
  if (error) return Util.toast("회차 추가 실패: " + error.message);
  Util.toast("회차를 추가했습니다.");
  loadAll();
}
async function removeDate(sessionId, program) {
  if (program.sessions.length === 1) {
    return Util.toast("마지막 회차예요. 교육 전체를 지우려면 ‘교육 편집 → 삭제’를 쓰세요.");
  }
  if (!confirm("이 회차를 삭제할까요?")) return;
  const { error } = await window.sb.from("education_sessions").delete().eq("id", sessionId);
  if (error) return Util.toast("삭제 실패: " + error.message);
  Util.toast("회차를 삭제했습니다.");
  loadAll();
}

// ---------- 교육 모달 (회차별 날짜·시간 빌더) ----------
function selectedWeekdays() {
  return new Set([...document.querySelectorAll("#weekdays .wd-btn.active")].map((b) => Number(b.dataset.wd)));
}
function generateRecurringDates(startISO, weekdaySet, count) {
  const wds = weekdaySet.size ? weekdaySet : new Set([Util.weekday(startISO)]);
  const out = [];
  const d = new Date(startISO + "T00:00:00");
  let guard = 0;
  const pad = (n) => String(n).padStart(2, "0");
  while (out.length < count && guard < 800) {
    if (wds.has(d.getDay())) out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    d.setDate(d.getDate() + 1);
    guard++;
  }
  return out;
}

// 회차 장소 입력란은 "이 회차만 다른 경우의 override". 비우면 기본 장소를 따른다.
function sessionLocPlaceholder() {
  const baseLoc = (document.getElementById("sLocation")?.value || "").trim();
  return baseLoc ? `비우면 기본 장소(${baseLoc}) 사용` : "📍 이 회차만 다른 장소 (비우면 기본 장소)";
}
function addSessionRow(date = "", start = "10:00", end = "13:00", loc = "") {
  const wrap = document.getElementById("sessionRows");
  const row = document.createElement("div");
  row.className = "row session-row";
  row.style.cssText = "gap:6px; margin-bottom:10px; flex-wrap:wrap; align-items:center";
  row.innerHTML =
    `<input type="date" class="input sr-date" value="${date}" style="flex:1.3; height:38px; min-width:120px" />` +
    `<input type="time" class="input sr-start" value="${start}" style="height:38px; width:auto" />` +
    `<span class="text-caption">~</span>` +
    `<input type="time" class="input sr-end" value="${end}" style="height:38px; width:auto" />` +
    `<button type="button" class="btn btn-ghost btn-sm sr-del" style="color:var(--color-info-negative)">✕</button>` +
    `<input type="text" class="input sr-loc" value="${Util.escapeHtml(loc)}" placeholder="${Util.escapeHtml(sessionLocPlaceholder())}" style="flex:1 1 100%; height:34px" />`;
  row.querySelector(".sr-del").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}
function collectSessionRows() {
  const out = [];
  for (const r of document.querySelectorAll("#sessionRows .session-row")) {
    const date = r.querySelector(".sr-date").value;
    const start = r.querySelector(".sr-start").value;
    const end = r.querySelector(".sr-end").value;
    const loc = r.querySelector(".sr-loc").value.trim();
    if (!date) continue;
    if (!start || !end || end <= start) return { error: "회차 시간을 확인하세요 (종료가 시작보다 늦어야 함)." };
    out.push({ date, start, end, loc });
  }
  return { rows: out };
}
function repeatFill() {
  const startISO = document.getElementById("rStartDate").value;
  const count = parseInt(document.getElementById("sCount").value, 10) || 0;
  const start = document.getElementById("rTimeStart").value;
  const end = document.getElementById("rTimeEnd").value;
  if (!startISO || count < 1) return Util.toast("시작 날짜와 회기 수를 입력하세요.");
  if (end <= start) return Util.toast("종료 시간이 시작보다 늦어야 합니다.");
  const dates = generateRecurringDates(startISO, selectedWeekdays(), count);
  if (!dates.length) return Util.toast("생성할 날짜가 없습니다.");
  dates.forEach((d) => addSessionRow(d, start, end)); // 장소는 비워둠 → 기본 장소 사용
  document.getElementById("repeatBox").classList.add("hidden");
  Util.toast(`${dates.length}개 회차 추가됨. 회차별 시간은 위에서 조정하세요.`);
}
function updateRepeatPreview() {
  const preview = document.getElementById("repeatPreview");
  const startISO = document.getElementById("rStartDate").value;
  const count = parseInt(document.getElementById("sCount").value, 10) || 0;
  if (!startISO || count < 1) { preview.textContent = "시작 날짜·회기 수·요일을 정하세요."; return; }
  const dates = generateRecurringDates(startISO, selectedWeekdays(), count);
  preview.textContent = dates.length
    ? `→ ${dates.slice(0, 3).map(Util.fmtDate).join(", ")}${dates.length > 3 ? " …" : ""} 총 ${dates.length}회`
    : "";
}

function openModal(program, prefillDate) {
  const editing = !!program;
  document.getElementById("modalTitle").textContent = editing ? "교육 편집" : "새 교육";
  document.getElementById("sId").value = program?.id || "";
  document.getElementById("sClient").value = program?.client || "";
  document.getElementById("sTitle").value = program?.title || "";
  document.getElementById("sNeeded").value = program?.needed_mentors ?? 1;
  document.getElementById("sNeededFac").value = program?.needed_facilitators ?? 0;
  document.getElementById("sStatus").value = program?.status || "모집중";
  document.getElementById("sLocation").value = program?.location || "";
  document.getElementById("sMemo").value = program?.memo || "";
  document.getElementById("deleteSessionBtn").style.display = editing ? "" : "none";

  // 회차 행 채우기
  document.getElementById("sessionRows").innerHTML = "";
  // 회차 장소가 기본 장소와 같으면 비워둠(상속) → 나중에 기본 장소만 바꿔도 전 회차 반영.
  // 기본과 다른 회차만 그 값을 채워 override 로 표시.
  if (editing) program.sessions.forEach((s) =>
    addSessionRow(s.date, Util.hhmm(s.start_time), Util.hhmm(s.end_time),
      (s.location || "") === (program.location || "") ? "" : (s.location || "")));
  else addSessionRow(prefillDate || "", "10:00", "13:00");

  // 반복 채우기 박스 초기화
  document.getElementById("repeatBox").classList.add("hidden");
  document.querySelectorAll("#weekdays .wd-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById("sCount").value = 4;
  document.getElementById("rStartDate").value = prefillDate || "";
  document.getElementById("rTimeStart").value = "10:00";
  document.getElementById("rTimeEnd").value = "13:00";
  document.getElementById("repeatPreview").textContent = "";

  document.getElementById("sessionModal").classList.remove("hidden");
}
function closeModal() {
  document.getElementById("sessionModal").classList.add("hidden");
}

async function saveProgram(e) {
  e.preventDefault();
  const id = document.getElementById("sId").value;
  const base = {
    title: document.getElementById("sTitle").value.trim(),
    client: document.getElementById("sClient").value.trim(),
    needed_mentors: parseInt(document.getElementById("sNeeded").value, 10) || 0,
    needed_facilitators: parseInt(document.getElementById("sNeededFac").value, 10) || 0,
    status: document.getElementById("sStatus").value,
    location: document.getElementById("sLocation").value.trim(),
    memo: document.getElementById("sMemo").value.trim(),
  };
  if (!base.client && !base.title) return Util.toast("회사 또는 교육 제목을 입력하세요.");
  const col = collectSessionRows();
  if (col.error) return Util.toast(col.error);
  if (!col.rows.length) return Util.toast("회차를 1개 이상 추가하세요.");
  const pid = id || uuid();
  // 편집 시 회차를 새로 insert 하므로, 같은 날짜의 수행기록(완료·특이사항)은 그대로 이어준다.
  const prevByDate = {};
  (state.programById[id]?.sessions || []).forEach((s) => { prevByDate[s.date] = s; });
  const sessions = col.rows.map((r) => {
    const prev = prevByDate[r.date];
    return {
      ...base, date: r.date, start_time: r.start, end_time: r.end, program_id: pid, created_by: me.id,
      location: r.loc || base.location, // 회차별 장소(비우면 기본 장소)
      done: prev?.done ?? false, note: prev?.note ?? "",
    };
  });

  // 삽입(새 회차) → 편집이면 기존 회차 제거 (배정은 program_id 기준이라 유지)
  let ins = await window.sb.from("education_sessions").insert(sessions);
  if (ins.error && isMissingColumn(ins.error)) {
    // done/note 컬럼이 아직 없으면(마이그레이션 전) 그 키 빼고 재시도 — 교육 저장은 계속 동작.
    const stripped = sessions.map(({ done, note, ...rest }) => rest);
    ins = await window.sb.from("education_sessions").insert(stripped);
  }
  if (ins.error) return Util.toast("저장 실패: " + ins.error.message);
  if (id) {
    const oldIds = (state.programById[id]?.sessions || []).map((s) => s.id);
    if (oldIds.length) await window.sb.from("education_sessions").delete().in("id", oldIds);
  }
  state.selectedProgramId = pid;
  Util.toast(id ? `교육 수정 (${sessions.length}회차)` : `교육 생성 (${sessions.length}회차)`);
  closeModal();
  loadAll();
}

async function deleteProgram() {
  const id = document.getElementById("sId").value;
  if (!id) return;
  if (!confirm("이 교육과 모든 회차·배정을 삭제할까요?")) return;
  await window.sb.from("assignments").delete().eq("program_id", id);
  const { error } = await window.sb.from("education_sessions").delete().eq("program_id", id);
  if (error) return Util.toast("삭제 실패: " + error.message);
  if (state.selectedProgramId === id) state.selectedProgramId = null;
  Util.toast("교육을 삭제했습니다.");
  closeModal();
  loadAll();
}

// ---------- 명단(초대) ----------
function renderRosters() {
  renderRosterTable("mentorRosterList", rosterOf("mentor"));
  renderRosterTable("facRosterList", rosterOf("facilitator"));
}
function renderRosterTable(tbodyId, list) {
  const tbody = document.getElementById(tbodyId);
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-caption text-muted">아직 없습니다. 위 버튼으로 초대하세요.</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map((v) => {
      const statusBadge = v.used
        ? `<span class="badge badge-status-확정">가입완료</span>`
        : `<span class="badge badge-status-제안">가입대기</span>`;
      const adminBadge = v.role === "admin" ? ` <span class="badge badge-neutral">운영팀</span>` : "";
      const emailCell = v.email.endsWith("@pending.local")
        ? `<span class="text-caption" style="color:var(--color-fg-assistive)">이메일 미정 (이름으로 연결)</span>`
        : `<span class="text-caption text-muted">${Util.escapeHtml(v.email)}</span>`;
      return `
        <tr>
          <td class="text-sm" style="font-weight: var(--font-weight-semibold)">${Util.escapeHtml(v.name)}${adminBadge}</td>
          <td>${emailCell}</td>
          <td>${statusBadge}</td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn btn-ghost btn-sm" data-schedule="${Util.escapeHtml(v.email)}">📅 스케줄</button>
            <button class="btn btn-secondary btn-sm" data-edit-invite="${Util.escapeHtml(v.email)}">수정</button>
            <button class="btn btn-ghost btn-sm" data-del-invite="${Util.escapeHtml(v.email)}">삭제</button>
          </td>
        </tr>`;
    })
    .join("");
  tbody.querySelectorAll("[data-schedule]").forEach((b) =>
    b.addEventListener("click", () => openMentorSchedule(b.dataset.schedule)));
  tbody.querySelectorAll("[data-edit-invite]").forEach((b) =>
    b.addEventListener("click", () => openEditPerson(b.dataset.editInvite)));
  tbody.querySelectorAll("[data-del-invite]").forEach((b) =>
    b.addEventListener("click", () => deleteInvite(b.dataset.delInvite)));
}

function openInviteModal(type) {
  document.getElementById("inviteForm").reset();
  document.getElementById("iEditEmail").value = "";
  document.getElementById("iStaffType").value = type;
  document.getElementById("iEmailInput").disabled = false;
  document.getElementById("iEmailHint").textContent = "비워두면 멘토가 본인 이름으로 가입할 때 자동 연결됩니다. 이메일을 알면 넣어도 돼요.";
  document.getElementById("inviteModalTitle").textContent = TYPE_LABEL[type] + " 추가";
  document.getElementById("inviteSubmitBtn").textContent = "추가";
  document.getElementById("deletePersonBtn").style.display = "none";
  document.getElementById("inviteModal").classList.remove("hidden");
}

function openEditPerson(email) {
  const v = state.rosterByEmail[email];
  if (!v) return;
  document.getElementById("inviteForm").reset();
  document.getElementById("iEditEmail").value = email;
  document.getElementById("iName").value = v.name;
  document.getElementById("iEmailInput").value = v.email.endsWith("@pending.local") ? "" : v.email;
  document.getElementById("iStaffType").value = v.staff_type;
  document.getElementById("iAdmin").checked = v.role === "admin";
  // 가입 완료자는 이메일(=로그인 계정) 변경 불가
  document.getElementById("iEmailInput").disabled = !!v.used;
  document.getElementById("iEmailHint").textContent = v.used
    ? "가입 완료된 계정이라 이메일은 변경할 수 없어요. 이름·구분·권한만 수정됩니다."
    : "비워두면 이름으로 연결됩니다. 실제 이메일을 알면 넣어도 돼요.";
  document.getElementById("inviteModalTitle").textContent = "명단 수정";
  document.getElementById("inviteSubmitBtn").textContent = "저장";
  document.getElementById("deletePersonBtn").style.display = "";
  document.getElementById("inviteModal").classList.remove("hidden");
}

function closeInviteModal() {
  document.getElementById("inviteModal").classList.add("hidden");
  document.getElementById("iEmailInput").disabled = false;
}

function genPlaceholder() {
  const rand = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.floor(Math.random() * 1e9)).replace(/-/g, "");
  return `pending-${rand}@pending.local`;
}
const isRealEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !e.endsWith("@pending.local");

async function savePerson(e) {
  e.preventDefault();
  const editEmail = document.getElementById("iEditEmail").value;
  const name = document.getElementById("iName").value.trim();
  const emailRaw = document.getElementById("iEmailInput").value.trim().toLowerCase();
  const staffType = document.getElementById("iStaffType").value;
  const role = document.getElementById("iAdmin").checked ? "admin" : "mentor";
  if (!name) return Util.toast("이름을 입력하세요.");
  if (emailRaw && !isRealEmail(emailRaw)) return Util.toast("올바른 이메일을 입력하거나 비워두세요.");

  // 이메일 결정: 신규+빈칸 → placeholder, 수정+빈칸 → 기존 유지
  let newEmail;
  if (emailRaw) newEmail = emailRaw;
  else if (!editEmail) newEmail = genPlaceholder();
  else newEmail = editEmail;
  const username = newEmail.split("@")[0];
  const notify = newEmail.endsWith("@pending.local") ? null : newEmail;

  // ---- 신규 추가 ----
  if (!editEmail) {
    const { error } = await window.sb.from("invites")
      .insert({ email: newEmail, username, name, role, staff_type: staffType, notify_email: notify, created_by: me.id });
    if (error) {
      if (error.code === "23505") return Util.toast("이미 등록된 이메일입니다.");
      return Util.toast("추가 실패: " + error.message);
    }
    Util.toast(notify ? `${name} 추가 완료 (${notify})` : `${name} 추가 완료. 본인 이름으로 가입하면 연결됩니다.`);
    closeInviteModal();
    return loadAll();
  }

  // ---- 수정 ----
  const orig = state.rosterByEmail[editEmail];
  const emailChanged = newEmail !== editEmail;
  if (orig.used && emailChanged) return Util.toast("가입 완료 계정은 이메일을 바꿀 수 없어요.");

  // 1) invites 갱신
  const upd = await window.sb.from("invites")
    .update({ name, username, role, staff_type: staffType, email: newEmail, notify_email: notify })
    .eq("email", editEmail);
  if (upd.error) {
    if (upd.error.code === "23505") return Util.toast("바꾸려는 이메일이 이미 있어요.");
    return Util.toast("수정 실패: " + upd.error.message);
  }

  // 2) 미가입자 아이디 변경 시 배정의 person_email 도 이전
  if (emailChanged) {
    await window.sb.from("assignments").update({ person_email: newEmail }).eq("person_email", editEmail);
  }
  // 3) 구분(멘토/퍼실) 변경 시 기존 배정의 staff_type 동기화
  if (orig.staff_type !== staffType) {
    await window.sb.from("assignments").update({ staff_type: staffType }).eq("person_email", emailChanged ? newEmail : editEmail);
  }
  // 4) 가입 완료자는 mentors(프로필)도 갱신 — 이름/권한/구분/이메일
  if (orig.used) {
    await window.sb.from("mentors").update({ name, role, staff_type: staffType, notify_email: notify }).eq("email", editEmail);
  }

  Util.toast("수정했습니다.");
  closeInviteModal();
  loadAll();
}
async function deleteInvite(email) {
  if (!confirm("이 초대를 삭제할까요? (이미 가입한 계정은 삭제되지 않습니다)")) return;
  const { error } = await window.sb.from("invites").delete().eq("email", email);
  if (error) return Util.toast("삭제 실패: " + error.message);
  Util.toast("초대를 삭제했습니다.");
  loadAll();
}

// ---------- 스마트 추가 (캡쳐/러프 텍스트 → 새 교육 폼 자동 채우기) ----------
let smartImage = null; // { data: base64(헤더 제외), media_type }

function initSmartAdd() {
  document.getElementById("smartAddBtn").addEventListener("click", openSmartModal);
  document.getElementById("smartCancelBtn").addEventListener("click", closeSmartModal);
  document.getElementById("smartModal").addEventListener("click", (e) => {
    if (e.target.id === "smartModal") closeSmartModal();
  });
  document.getElementById("smartAttachBtn").addEventListener("click", () =>
    document.getElementById("smartFile").click());
  document.getElementById("smartFile").addEventListener("change", (e) => {
    if (e.target.files[0]) setSmartImage(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("smartImgClearBtn").addEventListener("click", clearSmartImage);
  document.getElementById("smartText").addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) { e.preventDefault(); setSmartImage(item.getAsFile()); }
  });
  document.getElementById("smartAnalyzeBtn").addEventListener("click", smartAnalyze);
}

function openSmartModal() {
  document.getElementById("smartText").value = "";
  clearSmartImage();
  document.getElementById("smartModal").classList.remove("hidden");
  document.getElementById("smartText").focus();
}
function closeSmartModal() {
  document.getElementById("smartModal").classList.add("hidden");
}
function clearSmartImage() {
  smartImage = null;
  document.getElementById("smartImgInfo").textContent = "첨부된 이미지 없음";
  document.getElementById("smartImgPreview").innerHTML = "";
  document.getElementById("smartImgClearBtn").classList.add("hidden");
}

/** 캡쳐 이미지를 최대 2000px로 줄여 base64로 보관 (업로드 용량·비용 절약) */
function setSmartImage(file) {
  const img = new Image();
  img.onload = () => {
    const MAX = 2000;
    const scale = Math.min(1, MAX / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    smartImage = { data: dataUrl.split(",")[1], media_type: "image/png" };
    document.getElementById("smartImgInfo").textContent = `이미지 1장 (${canvas.width}×${canvas.height})`;
    document.getElementById("smartImgClearBtn").classList.remove("hidden");
    const preview = new Image();
    preview.src = dataUrl;
    preview.style.cssText = "max-width:100%; border:1px solid var(--color-border-weak); border-radius:8px";
    const box = document.getElementById("smartImgPreview");
    box.innerHTML = "";
    box.appendChild(preview);
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
}

async function smartAnalyze() {
  const text = document.getElementById("smartText").value.trim();
  if (!text && !smartImage) return Util.toast("텍스트를 붙여넣거나 이미지를 첨부하세요.");
  const btn = document.getElementById("smartAnalyzeBtn");
  btn.disabled = true;
  btn.textContent = "분석 중… (수 초 걸려요)";
  try {
    const { data, error } = await window.sb.functions.invoke("parse-schedule", {
      body: { text, image: smartImage },
    });
    if (error) {
      // 함수가 보낸 구체적 오류 메시지를 응답 본문에서 꺼냄
      let detail = error.message;
      try {
        const body = await error.context?.json();
        if (body?.error) detail = body.error;
      } catch (_) { /* 본문 없으면 기본 메시지 사용 */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    applyParsedSchedule(data.result, data.provider === "ollama" ? "Ollama" : "Claude");
  } catch (err) {
    console.error("[스마트 추가] 분석 실패:", err);
    // AI 함수 미배포/오류 시: 텍스트만이라도 규칙 기반으로 파싱
    const local = text ? localParseSchedule(text) : null;
    if (local && local.sessions.length) {
      applyParsedSchedule(local);
      Util.toast("AI 미설정이라 간단 분석으로 채웠어요 — 날짜·시간을 꼭 확인하세요.");
    } else {
      Util.toast("분석 실패: " + (err.message || "알 수 없는 오류"));
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ 분석해서 채우기";
  }
}

/** 분석 결과를 '새 교육' 폼에 채움 — 저장은 사람이 확인 후 */
function applyParsedSchedule(p, providerLabel) {
  closeSmartModal();
  openModal();
  document.getElementById("sClient").value = p.client || "";
  document.getElementById("sTitle").value = p.title || "";
  document.getElementById("sLocation").value = p.location || "";
  document.getElementById("sMemo").value = p.memo || "";
  document.getElementById("sNeeded").value = p.needed_mentors || 1;
  document.getElementById("sNeededFac").value = p.needed_facilitators || 0;
  document.getElementById("sessionRows").innerHTML = "";
  const sessions = p.sessions || [];
  sessions.forEach((s) => addSessionRow(s.date, s.start, s.end));
  if (!sessions.length) addSessionRow();
  Util.toast(`분석 완료${providerLabel ? ` (${providerLabel})` : ""} — ${sessions.length}개 회차를 채웠어요. 확인 후 저장하세요.`);
}

/** AI 없이 동작하는 간단 규칙 파서 (텍스트 전용 폴백) */
function localParseSchedule(text) {
  const out = { client: "", title: "", location: "", memo: "", needed_mentors: 1, needed_facilitators: 0, sessions: [] };
  const pad = (n) => String(n).padStart(2, "0");
  const today = new Date();

  // 시간: 10:00~13:00 / 10시~13시 / 10시-13시 / 오후 2시~5시
  let start = "10:00", end = "13:00";
  const tm = text.match(/(오전|오후)?\s*(\d{1,2})(?::(\d{2})|시)\s*(?:반)?\s*[~\-–부터]+\s*(오전|오후)?\s*(\d{1,2})(?::(\d{2})|시)/);
  if (tm) {
    let sh = parseInt(tm[2], 10), eh = parseInt(tm[5], 10);
    if (tm[1] === "오후" && sh < 12) sh += 12;
    if (tm[4] === "오후" && eh < 12) eh += 12;
    if (!tm[4] && eh < sh) eh += 12; // "10시~1시", "오후 2시~5시" → 종료를 시작 이후로 추정
    start = `${pad(sh)}:${tm[3] || "00"}`;
    end = `${pad(eh)}:${tm[6] || "00"}`;
  }

  // 날짜: 2026-06-15 / 6/15 / 6월 15일 — 모두 수집
  const dates = new Set();
  const re = /(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})|(\d{1,2})\s*[\/월]\s*(\d{1,2})\s*일?/g;
  let m;
  while ((m = re.exec(text))) {
    let y, mo, d;
    if (m[1]) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      mo = +m[4]; d = +m[5];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      y = today.getFullYear();
      // 이미 지난 날짜면 내년으로 추정
      if (new Date(`${y}-${pad(mo)}-${pad(d)}`) < new Date(today.getTime() - 86400000 * 30)) y += 1;
    }
    dates.add(`${y}-${pad(mo)}-${pad(d)}`);
  }
  out.sessions = [...dates].sort().map((date) => ({ date, start, end }));

  const loc = text.match(/장소\s*[:：]\s*([^\n,/]+)/);
  if (loc) out.location = loc[1].trim();
  const nm = text.match(/멘토\s*(\d+)\s*명/);
  if (nm) out.needed_mentors = +nm[1];
  const nf = text.match(/퍼실(?:리테이터)?\s*(\d+)\s*명/);
  if (nf) out.needed_facilitators = +nf[1];

  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l);
  if (firstLine) out.title = firstLine.slice(0, 50);
  return out;
}

// ---------- 교육명으로 일정 이미지 호출 ----------
function normProgName(s) {
  return (s || "").toLowerCase().replace(/[\s—–-]+/g, "");
}
function progLabel(p) {
  return p.client && p.title && p.title !== p.client ? `${p.client} — ${p.title}` : (p.client || p.title);
}
function findProgramsByName(query) {
  const q = normProgName(query);
  if (!q) return [];
  const cands = (p) => [p.client, p.title, `${p.client || ""}${p.title || ""}`].map(normProgName);
  const exact = state.programs.filter((p) => cands(p).includes(q));
  if (exact.length) return exact;
  return state.programs.filter((p) => cands(p).some((c) => c && c.includes(q)));
}
function callScheduleImage(query) {
  if (!query) return Util.toast("교육명(또는 회사명)을 입력하세요.");
  const matches = findProgramsByName(query);
  if (!matches.length) return Util.toast(`'${query}' 교육을 찾지 못했어요.`);
  if (matches.length > 1) Util.toast(`${matches.length}개 교육이 검색돼 첫 번째(${progLabel(matches[0])})를 보여드려요.`);
  state.selectedProgramId = matches[0].id;
  renderBoard();
  renderProgramList();
  openShareImage(matches[0].id);
}
function fillProgramDatalist() {
  const dl = document.getElementById("programNames");
  if (!dl) return;
  dl.innerHTML = state.programs
    .map((p) => `<option value="${Util.escapeHtml(progLabel(p))}">${programDatesLabel(p)}</option>`)
    .join("");
}

// ---------- 일정 안내 이미지 (멘토 공유용 PNG) ----------
let shareCanvas = null;
let shareProgram = null;

const SHARE_FONT = (weight, size) =>
  `${weight} ${size}px Pretendard, "Pretendard Variable", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;

function shareStatusStyle(status) {
  if (status === "모집중") return { bg: "#FFF3D6", fg: "#8A6400" };
  if (status === "확정") return { bg: "#E8F6E3", fg: "#3D6B04" };
  if (status === "완료") return { bg: "#F3F4F6", fg: "#4B5563" };
  return { bg: "#FCE8EA", fg: "#B0192C" }; // 취소
}

/** 한글은 띄어쓰기 단위가 아니라 글자 단위로 줄바꿈 */
function shareWrapText(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const ch of para) {
      if (line && ctx.measureText(line + ch).width > maxWidth) { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

function shareRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) return ctx.roundRect(x, y, w, h, r);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 교육 1개 → 안내 이미지 캔버스 (넉넉한 캔버스에 그린 뒤 실제 높이로 잘라냄) */
function buildScheduleCanvas(p) {
  const W = 1000, PAD = 56, scale = 2, MAXH = 6000;
  const color = progColor(p.id);

  const big = document.createElement("canvas");
  big.width = W * scale;
  big.height = MAXH * scale;
  const ctx = big.getContext("2d");
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, W, MAXH);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, 10);

  let y = 52;

  // 상단 라벨 + 상태 배지
  ctx.fillStyle = color;
  ctx.font = SHARE_FONT(700, 17);
  ctx.fillText("교육 일정 안내", PAD, y);
  const st = shareStatusStyle(p.status);
  const stW = ctx.measureText(p.status).width + 28;
  shareRoundRect(ctx, W - PAD - stW, y - 8, stW, 34, 17);
  ctx.fillStyle = st.bg;
  ctx.fill();
  ctx.fillStyle = st.fg;
  ctx.fillText(p.status, W - PAD - stW + 14, y);
  y += 38;

  // 회사명 / 교육 제목
  ctx.fillStyle = "#111827";
  ctx.font = SHARE_FONT(800, 36);
  ctx.fillText(p.client || p.title, PAD, y);
  y += 52;
  const subTitle = p.client && p.title && p.title !== p.client ? p.title : "";
  if (subTitle) {
    ctx.fillStyle = "#4B5563";
    ctx.font = SHARE_FONT(500, 22);
    ctx.fillText(subTitle, PAD, y);
    y += 38;
  }
  y += 6;
  ctx.strokeStyle = "#E5E7EB";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
  y += 26;

  // 기본 정보 (장소·시간·담당) — 수락/확정자 우선, 없으면 제안 중인 사람이라도 표시
  const names = (type) => {
    const all = assignedFor(p.id, type);
    const ok = all.filter((c) => c.status === "수락" || c.status === "확정");
    return (ok.length ? ok : all).map((c) => c.name);
  };
  const mentorNames = names("mentor");
  const facNames = names("facilitator");
  const infoRows = [["장소", p.locationVaries ? "회차별 상이 (아래 참조)" : (p.location || "미정")]];
  if (!p.timeVaries)
    infoRows.push(["시간", `${Util.hhmm(p.start_time)} ~ ${Util.hhmm(p.end_time)} (${Util.durationLabel(p.start_time, p.end_time)})`]);
  infoRows.push(["멘토", mentorNames.length ? mentorNames.join(", ") : "배정 예정"]);
  if (facNames.length || p.needed_facilitators)
    infoRows.push(["퍼실리테이터", facNames.length ? facNames.join(", ") : "배정 예정"]);
  if (p.memo) infoRows.push(["메모", p.memo]);

  const labelW = 160;
  for (const [label, value] of infoRows) {
    ctx.font = SHARE_FONT(700, 18);
    ctx.fillStyle = "#6B7280";
    ctx.fillText(label, PAD, y + 2);
    ctx.font = SHARE_FONT(500, 21);
    ctx.fillStyle = "#1F2937";
    for (const line of shareWrapText(ctx, value, W - PAD * 2 - labelW)) {
      ctx.fillText(line, PAD + labelW, y);
      y += 32;
    }
    y += 10;
  }
  y += 12;

  // 회차 일정 표
  ctx.fillStyle = "#111827";
  ctx.font = SHARE_FONT(800, 22);
  ctx.fillText("회차 일정", PAD, y);
  ctx.fillStyle = color;
  ctx.font = SHARE_FONT(700, 19);
  ctx.fillText(`총 ${p.sessions.length}회`, PAD + 108, y + 3);
  y += 44;

  const rowH = p.locationVaries ? 78 : 54;
  p.sessions.forEach((s, i) => {
    if (i % 2 === 0) {
      ctx.fillStyle = "#F8F9FB";
      shareRoundRect(ctx, PAD - 14, y, W - (PAD - 14) * 2, rowH, 10);
      ctx.fill();
    }
    const ty = y + 16;
    ctx.fillStyle = color;
    ctx.font = SHARE_FONT(800, 18);
    ctx.fillText(`${i + 1}회차`, PAD, ty);
    ctx.fillStyle = "#111827";
    ctx.font = SHARE_FONT(600, 21);
    ctx.fillText(Util.fmtDate(s.date), PAD + 104, ty - 2);
    ctx.fillStyle = "#374151";
    ctx.font = SHARE_FONT(500, 21);
    ctx.fillText(`${Util.hhmm(s.start_time)} ~ ${Util.hhmm(s.end_time)}`, PAD + 350, ty - 2);
    ctx.fillStyle = "#9CA3AF";
    ctx.font = SHARE_FONT(500, 18);
    const dur = Util.durationLabel(s.start_time, s.end_time);
    ctx.fillText(dur, W - PAD - ctx.measureText(dur).width, ty);
    // 회차별 장소가 다를 때만 각 줄에 장소 표기
    if (p.locationVaries && s.location) {
      ctx.fillStyle = "#6B7280";
      ctx.font = SHARE_FONT(500, 18);
      ctx.fillText("장소 · " + s.location, PAD + 104, ty + 28);
    }
    y += rowH;
  });

  // 푸터
  y += 26;
  ctx.strokeStyle = "#E5E7EB";
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
  y += 18;
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  ctx.fillStyle = "#9CA3AF";
  ctx.font = SHARE_FONT(500, 15);
  ctx.fillText(`멘토 일정 관리 · ${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())} 기준`, PAD, y);
  y += 46;

  // 실제 사용한 높이만큼 잘라서 반환
  const out = document.createElement("canvas");
  out.width = W * scale;
  out.height = Math.min(y, MAXH) * scale;
  out.getContext("2d").drawImage(big, 0, 0);
  return out;
}

function openShareImage(programId) {
  const p = state.programById[programId];
  if (!p) return;
  shareProgram = p;
  shareCanvas = buildScheduleCanvas(p);
  const box = document.getElementById("shareImgPreview");
  box.innerHTML = "";
  const img = new Image();
  img.src = shareCanvas.toDataURL("image/png");
  img.style.cssText = "width:100%; display:block";
  box.appendChild(img);
  document.getElementById("shareImageModal").classList.remove("hidden");
}
function closeShareImage() {
  document.getElementById("shareImageModal").classList.add("hidden");
  shareCanvas = null;
  shareProgram = null;
}
function downloadShareImage() {
  if (!shareCanvas || !shareProgram) return;
  const name = `${shareProgram.client || shareProgram.title}_일정안내.png`.replace(/[\\/:*?"<>|]/g, "_");
  shareCanvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    Util.toast("PNG를 저장했어요.");
  }, "image/png");
}
async function copyShareImage() {
  if (!shareCanvas) return;
  try {
    const blob = await new Promise((res) => shareCanvas.toBlob(res, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    Util.toast("이미지를 복사했어요. 카톡·슬랙에 붙여넣기(Ctrl+V) 하세요.");
  } catch (err) {
    Util.toast("이 브라우저에선 복사가 안 돼요 — PNG 다운로드를 이용하세요.");
  }
}

// ---------- 멘토 스케줄 보기 (배정 교육 + 개인 일정) ----------
let mentorCal = null;
function openMentorSchedule(email) {
  const person = state.rosterByEmail[email];
  if (!person) return;
  const myAssign = state.assignments.filter((a) => a.person_email === email);
  const progIds = [...new Set(myAssign.map((a) => a.program_id))];
  const blocks = state.blocksByEmail[email] || [];

  document.getElementById("msTitle").textContent = `${person.name} 스케줄`;
  const pendNote = person.email.endsWith("@pending.local")
    ? ` · <span style="color:var(--color-fg-assistive)">미가입(개인일정 미등록)</span>` : "";
  document.getElementById("msSummary").innerHTML =
    `배정 교육 <b>${progIds.length}</b>개 · 개인 일정 <b>${blocks.length}</b>건${pendNote}`;

  document.getElementById("mentorScheduleModal").classList.remove("hidden");

  if (mentorCal) { mentorCal.destroy(); mentorCal = null; }
  const allDates = [];
  myAssign.forEach((a) => state.programById[a.program_id]?.sessions.forEach((s) => allDates.push(s.date)));
  blocks.forEach((b) => allDates.push(b.date));
  const initialDate = allDates.length ? allDates.sort()[0] : undefined;

  mentorCal = new FullCalendar.Calendar(document.getElementById("msCalendar"), {
    initialView: "dayGridMonth",
    locale: "ko",
    height: 540,
    initialDate,
    headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,listMonth" },
    buttonText: { today: "오늘", month: "월", list: "목록" },
  });
  myAssign.forEach((a) => {
    const p = state.programById[a.program_id];
    if (!p) return;
    p.sessions.forEach((s) => mentorCal.addEvent({
      title: `${p.client || p.title} · ${a.status}`,
      start: Util.toDateTime(s.date, s.start_time),
      end: Util.toDateTime(s.date, s.end_time),
      classNames: ["cal-assigned"],
    }));
  });
  blocks.forEach((b) => mentorCal.addEvent({
    title: `🔒 ${b.memo || "개인 일정"}`,
    start: Util.toDateTime(b.date, b.start_time),
    end: Util.toDateTime(b.date, b.end_time),
    classNames: ["cal-block"],
  }));
  mentorCal.render();
}
function closeMentorSchedule() {
  document.getElementById("mentorScheduleModal").classList.add("hidden");
  if (mentorCal) { mentorCal.destroy(); mentorCal = null; }
}

init();
