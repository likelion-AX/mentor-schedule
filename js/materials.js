// ============================================================================
// materials.js — 멘토 교육자료 업로드/수정/삭제 (본인+운영팀만, RLS)
//  · 파일은 Storage 버킷 'materials' 의 {내uid}/ 경로에, 메타는 public.materials 에.
//  · 교육(program) + 회차(week_no)로 구분. 분석(요약·QC)은 별도(에이전트)에서 채움.
//  · mentor.js 의 requireAuth 와 별개로 본인 프로필만 받아 독립 동작.
// ============================================================================

const Materials = (() => {
  const BUCKET = "materials";
  const MAX_BYTES = 50 * 1024 * 1024; // 50MB
  const uid = () =>
    crypto.randomUUID ? crypto.randomUUID() : "m-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);

  let me = null;
  let myPrograms = []; // [{ id, label, sessions:[{date,start,end}] }]
  let list = [];

  async function init() {
    me = await Auth.getProfile();
    if (!me) return; // 로그인 가드는 mentor.js 가 처리(리다이렉트)
    document.getElementById("materialForm")?.addEventListener("submit", onUpload);
    document.getElementById("mProgram")?.addEventListener("change", populateWeeks);
    await loadPrograms();
    await refresh();
  }

  /** 내가 볼 수 있는 교육(배정된 것)으로 연결 드롭다운 채우기 (회차 포함) */
  async function loadPrograms() {
    const { data } = await window.sb
      .from("education_sessions")
      .select("program_id, title, client, date, start_time, end_time")
      .order("date");
    const map = new Map();
    (data || []).forEach((s) => {
      if (!map.has(s.program_id)) {
        map.set(s.program_id, {
          id: s.program_id,
          label: s.client && s.title && s.client !== s.title ? `${s.client} — ${s.title}` : (s.client || s.title || "제목 없음"),
          sessions: [],
        });
      }
      map.get(s.program_id).sessions.push({ date: s.date, start: s.start_time, end: s.end_time });
    });
    myPrograms = [...map.values()];
    myPrograms.forEach((p) => p.sessions.sort((a, b) => a.date.localeCompare(b.date)));

    const sel = document.getElementById("mProgram");
    if (sel) {
      sel.innerHTML =
        `<option value="">(교육 연결 안 함)</option>` +
        myPrograms.map((p) => `<option value="${p.id}">${Util.escapeHtml(p.label)}</option>`).join("");
    }
    populateWeeks();
  }

  /** 선택한 교육의 회차 목록으로 '회차' 드롭다운 채우기 */
  function populateWeeks() {
    const sel = document.getElementById("mWeek");
    if (!sel) return;
    const prog = myPrograms.find((p) => p.id === document.getElementById("mProgram").value);
    if (!prog) {
      sel.innerHTML = `<option value="">전체(공통)</option>`;
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML =
      `<option value="">전체(공통)</option>` +
      prog.sessions.map((s, i) => `<option value="${i + 1}">${i + 1}회차 · ${Util.fmtDate(s.date)}</option>`).join("");
  }

  async function refresh() {
    const { data, error } = await window.sb
      .from("materials")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) return Util.toast("자료 로드 실패: " + error.message);
    list = data || [];
    render();
  }

  function programLabel(id) {
    return myPrograms.find((p) => p.id === id)?.label || "";
  }
  function weekLabel(m) {
    if (!m.program_id) return "";
    if (!m.week_no) return " · 공통";
    const s = myPrograms.find((p) => p.id === m.program_id)?.sessions[m.week_no - 1];
    return s ? ` · ${m.week_no}회차(${Util.fmtDate(s.date)})` : ` · ${m.week_no}회차`;
  }

  function fmtSize(bytes) {
    if (!bytes) return "";
    const kb = bytes / 1024;
    return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
  }

  function render() {
    const wrap = document.getElementById("materialList");
    if (!wrap) return;
    if (!list.length) {
      wrap.innerHTML = `<p class="text-caption text-muted">아직 올린 자료가 없습니다.</p>`;
      return;
    }
    wrap.innerHTML = list
      .map((m) => {
        const prog = m.program_id ? programLabel(m.program_id) + weekLabel(m) : "";
        return `
        <div class="card" style="padding: var(--space-3); box-shadow:none; border-color: var(--color-border-weak)">
          <div class="row-between">
            <strong class="text-sm">${Util.escapeHtml(m.title || m.file_name || "제목 없음")}</strong>
            <span class="text-caption text-muted">${fmtSize(m.file_size)}</span>
          </div>
          ${prog ? `<div class="text-caption" style="color:var(--color-fg-assistive)">📚 ${Util.escapeHtml(prog)}</div>` : ""}
          ${m.description ? `<div class="text-caption text-muted">${Util.escapeHtml(m.description)}</div>` : ""}
          ${m.file_name ? `<div class="text-caption text-muted">📄 ${Util.escapeHtml(m.file_name)}</div>` : ""}
          <div class="row mt-4" style="gap: var(--space-2)">
            <button class="btn btn-secondary btn-sm" data-dl="${m.id}">⬇ 다운로드</button>
            <button class="btn btn-ghost btn-sm" data-edit="${m.id}">수정</button>
            <button class="btn btn-ghost btn-sm" data-del="${m.id}" style="color:var(--color-info-negative)">삭제</button>
          </div>
        </div>`;
      })
      .join("");

    wrap.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => download(b.dataset.dl)));
    wrap.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editMeta(b.dataset.edit)));
    wrap.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => remove(b.dataset.del)));
  }

  async function onUpload(e) {
    e.preventDefault();
    const file = document.getElementById("mFile").files[0];
    if (!file) return Util.toast("파일을 선택하세요.");
    if (file.size > MAX_BYTES) return Util.toast("파일이 너무 큽니다 (최대 50MB).");

    const title = document.getElementById("mTitle").value.trim();
    const description = document.getElementById("mDesc").value.trim();
    const program_id = document.getElementById("mProgram").value || null;
    const weekVal = document.getElementById("mWeek").value;
    const week_no = program_id && weekVal ? parseInt(weekVal, 10) : null;

    const btn = document.getElementById("mSubmit");
    btn.disabled = true;
    btn.textContent = "업로드 중…";
    try {
      // Storage 키는 ASCII만 허용(한글·특수문자 → "Invalid key"). 확장자만 살려 uuid로 저장.
      // 원본 파일명은 file_name 컬럼에 그대로 보존 → 화면 표시·다운로드 시 사용.
      const dot = file.name.lastIndexOf(".");
      const ext = dot >= 0 ? file.name.slice(dot).replace(/[^.\w]/g, "") : "";
      const path = `${me.id}/${uid()}${ext}`;
      const up = await window.sb.storage.from(BUCKET).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || undefined,
      });
      if (up.error) throw up.error;

      const ins = await window.sb.from("materials").insert({
        owner_id: me.id,
        program_id,
        week_no,
        title: title || file.name,
        description,
        file_path: path,
        file_name: file.name,
        file_type: file.type || "",
        file_size: file.size,
      });
      if (ins.error) {
        await window.sb.storage.from(BUCKET).remove([path]); // 행 삽입 실패 시 파일 롤백
        throw ins.error;
      }
      Util.toast("자료를 올렸습니다.");
      e.target.reset();
      populateWeeks();
      await refresh();
    } catch (err) {
      Util.toast("업로드 실패: " + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = "자료 올리기";
    }
  }

  async function download(id) {
    const m = list.find((x) => x.id === id);
    if (!m) return;
    // 비공개 버킷이라 서명 URL 발급(60초 유효)
    const { data, error } = await window.sb.storage.from(BUCKET).createSignedUrl(m.file_path, 60);
    if (error) return Util.toast("다운로드 실패: " + error.message);
    // 한글 파일명 보존: blob으로 받아 원본 이름으로 저장 (실패 시 새 탭 폴백)
    try {
      await Util.downloadAs(data.signedUrl, m.file_name);
    } catch (_) {
      window.open(data.signedUrl, "_blank");
    }
  }

  async function editMeta(id) {
    const m = list.find((x) => x.id === id);
    if (!m) return;
    const title = prompt("자료 제목", m.title || "");
    if (title === null) return;
    const description = prompt("설명 (선택)", m.description || "");
    if (description === null) return;
    const { error } = await window.sb
      .from("materials")
      .update({ title: title.trim(), description: description.trim(), updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return Util.toast("수정 실패: " + error.message);
    Util.toast("수정했습니다.");
    await refresh();
  }

  async function remove(id) {
    const m = list.find((x) => x.id === id);
    if (!m) return;
    if (!confirm("이 자료를 삭제할까요?")) return;
    const del = await window.sb.from("materials").delete().eq("id", id);
    if (del.error) return Util.toast("삭제 실패: " + del.error.message);
    await window.sb.storage.from(BUCKET).remove([m.file_path]); // 파일도 정리(실패해도 메타는 삭제됨)
    Util.toast("삭제했습니다.");
    await refresh();
  }

  return { init };
})();

Materials.init();
