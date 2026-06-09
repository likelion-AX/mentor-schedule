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
  ["rStartDate", "sCount"].forEach((id) =>
    document.getElementById(id).addEventListener("input", updateRepeatPreview));
  document.querySelectorAll("#weekdays .wd-btn").forEach((b) =>
    b.addEventListener("click", () => { b.classList.toggle("active"); updateRepeatPreview(); }));

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
  if (state.selectedProgramId && !state.programById[state.selectedProgramId]) state.selectedProgramId = null;
  renderBoard();
}

function buildPrograms() {
  const map = {};
  state.sessions.forEach((s) => {
    (map[s.program_id] ||= []).push(s);
  });
  state.programs = Object.entries(map).map(([id, sess]) => {
    sess.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
    const r = sess[0];
    const timeVaries = sess.some((s) => s.start_time !== r.start_time || s.end_time !== r.end_time);
    return {
      id,
      title: r.title, client: r.client, location: r.location,
      needed_mentors: r.needed_mentors, needed_facilitators: r.needed_facilitators,
      status: r.status, memo: r.memo, start_time: r.start_time, end_time: r.end_time, timeVaries,
      sessions: sess, firstDate: sess[0].date, lastDate: sess[sess.length - 1].date,
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
      state.selectedProgramId = info.event.extendedProps.programId;
      renderBoard();
      renderProgramList();
      document.querySelector(".board-col")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    eventContent: (arg) => {
      const s = arg.event.extendedProps.data;
      const pid = s.program_id;
      const mentors = assignedFor(pid, "mentor").map((c) => c.name).join(", ");
      const facs = assignedFor(pid, "facilitator").map((c) => c.name).join(", ");
      const dur = Util.durationLabel(s.start_time, s.end_time);
      const mc = `${confirmedCount(pid, "mentor")}/${s.needed_mentors}`;
      const fc = s.needed_facilitators ? ` · 퍼실 ${confirmedCount(pid, "facilitator")}/${s.needed_facilitators}` : "";
      return {
        html: `<div class="ev">
          <div class="ev-client">${Util.escapeHtml(s.client || s.title)}</div>
          <div class="ev-meta">${Util.hhmm(s.start_time)}~${Util.hhmm(s.end_time)} · ${dur} · 👥${mc}${fc}</div>
          <div class="ev-mentors ${mentors ? "" : "none"}">${mentors ? "👤 " + Util.escapeHtml(mentors) : "멘토 미배정"}</div>
          ${facs ? `<div class="ev-mentors">🧑‍🏫 ${Util.escapeHtml(facs)}</div>` : ""}
        </div>`,
      };
    },
  });
  document.getElementById("calendar").classList.add("fc-admin");
  calendar.render();
}

function renderCalendar() {
  if (!calendar) return;
  calendar.removeAllEvents();
  state.sessions.forEach((s) => {
    calendar.addEvent({
      id: s.id,
      start: Util.toDateTime(s.date, s.start_time),
      end: Util.toDateTime(s.date, s.end_time),
      classNames: ["s-" + s.status],
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
          <td class="text-sm">${Util.escapeHtml(p.location || "-")}</td>
          <td>
            <div><span class="text-caption text-muted">멘토</span> ${chipsHtml(p.id, "mentor")} <span class="text-caption text-muted">(${confirmedCount(p.id, "mentor")}/${p.needed_mentors})</span></div>
            ${facLine}
          </td>
          <td><span class="badge badge-status-${statusCls}">${p.status}</span></td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn btn-ghost btn-sm" data-edit="${p.id}">편집</button>
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-row]").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit]")) return;
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
    <button class="btn btn-secondary btn-sm" id="editSessionBtn">교육 편집</button>`;
  head.querySelector("#editSessionBtn").addEventListener("click", () => openModal(p));

  board.innerHTML = `
    <div style="margin-bottom: var(--space-5)">
      <div class="row-between" style="margin-bottom: var(--space-2)">
        <span class="text-caption text-muted">회차 ${p.sessions.length}회 — 배정은 모든 회차에 함께 적용</span>
        <span class="text-caption text-muted">회차·시간 변경은 ‘교육 편집’</span>
      </div>
      <div class="mentor-chips">
        ${p.sessions.map((s) => `<span class="badge badge-neutral">${Util.fmtDate(s.date)} ${Util.hhmm(s.start_time)}</span>`).join("")}
      </div>
    </div>
    ${boardSection(p, "mentor", p.needed_mentors)}
    ${boardSection(p, "facilitator", p.needed_facilitators)}`;

  board.querySelectorAll("[data-board-schedule]").forEach((b) =>
    b.addEventListener("click", () => openMentorSchedule(b.dataset.boardSchedule)));
  board.querySelectorAll("[data-assign]").forEach((b) =>
    b.addEventListener("click", () => assignPerson(p.id, b.dataset.assign, b.dataset.type)));
  board.querySelectorAll("[data-unassign]").forEach((b) =>
    b.addEventListener("click", () => unassign(b.dataset.unassign)));
  board.querySelectorAll("[data-confirm]").forEach((b) =>
    b.addEventListener("click", () => setAssignStatus(b.dataset.confirm, "확정")));
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

function addSessionRow(date = "", start = "10:00", end = "13:00") {
  const wrap = document.getElementById("sessionRows");
  const row = document.createElement("div");
  row.className = "row session-row";
  row.style.cssText = "gap:6px; margin-bottom:6px; flex-wrap:nowrap; align-items:center";
  row.innerHTML =
    `<input type="date" class="input sr-date" value="${date}" style="flex:1.3; height:38px; min-width:120px" />` +
    `<input type="time" class="input sr-start" value="${start}" style="height:38px; width:auto" />` +
    `<span class="text-caption">~</span>` +
    `<input type="time" class="input sr-end" value="${end}" style="height:38px; width:auto" />` +
    `<button type="button" class="btn btn-ghost btn-sm sr-del" style="color:var(--color-info-negative)">✕</button>`;
  row.querySelector(".sr-del").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}
function collectSessionRows() {
  const out = [];
  for (const r of document.querySelectorAll("#sessionRows .session-row")) {
    const date = r.querySelector(".sr-date").value;
    const start = r.querySelector(".sr-start").value;
    const end = r.querySelector(".sr-end").value;
    if (!date) continue;
    if (!start || !end || end <= start) return { error: "회차 시간을 확인하세요 (종료가 시작보다 늦어야 함)." };
    out.push({ date, start, end });
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
  dates.forEach((d) => addSessionRow(d, start, end));
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
  if (editing) program.sessions.forEach((s) => addSessionRow(s.date, Util.hhmm(s.start_time), Util.hhmm(s.end_time)));
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
  const sessions = col.rows.map((r) => ({ ...base, date: r.date, start_time: r.start, end_time: r.end, program_id: pid, created_by: me.id }));

  // 삽입(새 회차) → 편집이면 기존 회차 제거 (배정은 program_id 기준이라 유지)
  const ins = await window.sb.from("education_sessions").insert(sessions);
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
