// ============================================================================
// 공통 유틸 — 날짜/시간 포맷, 충돌 판정, 토스트
// ============================================================================

const Util = {
  /** "2026-06-15" + "10:00:00" → ISO datetime 문자열 (로컬, FullCalendar용) */
  toDateTime(date, time) {
    return `${date}T${(time || "00:00").slice(0, 5)}`;
  },

  /** "10:00:00" → "10:00" */
  hhmm(t) {
    return (t || "").slice(0, 5);
  },

  /** "2026-06-15" → "6월 15일 (월)" */
  fmtDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
  },

  /** "2026-06-15" → 요일 인덱스(0=일) */
  weekday(dateStr) {
    return new Date(dateStr + "T00:00:00").getDay();
  },

  /** 시작/종료 시간 → "3시간", "1시간 30분" 같은 러닝타임 라벨 */
  durationLabel(start, end) {
    const [sh, sm] = this.hhmm(start).split(":").map(Number);
    const [eh, em] = this.hhmm(end).split(":").map(Number);
    let mins = eh * 60 + em - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60;
    const h = Math.floor(mins / 60), m = mins % 60;
    return [h ? `${h}시간` : "", m ? `${m}분` : ""].filter(Boolean).join(" ") || "0분";
  },

  /** 두 시간 구간이 겹치는지 (같은 날짜 가정). [s,e) 반열린 구간. */
  overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  },

  /** 세션이 멘토의 개인일정(blocks) 중 하나와 충돌하는지 */
  sessionConflictsBlocks(session, blocks) {
    return blocks.some(
      (b) =>
        b.date === session.date &&
        this.overlaps(session.start_time, session.end_time, b.start_time, b.end_time)
    );
  },

  toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  },

  escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  /**
   * 원격 URL을 내려받아 '원본 파일명'으로 저장.
   * 한글 파일명이 Content-Disposition 인코딩에서 깨지는 걸 회피하려고,
   * blob(같은 출처)으로 받아 a[download] 로 이름을 직접 지정한다.
   */
  async downloadAs(url, filename) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  },

  // ===================== 캘린더 연동 (오프라인, 백엔드 불필요) =====================

  /** "2026-06-15","10:00:00" → "20260615T100000" (로컬 floating time) */
  _calStamp(date, time) {
    return date.replace(/-/g, "") + "T" + this.hhmm(time).replace(":", "") + "00";
  },

  /** 세션 제목/설명 구성 */
  _calTitle(s) {
    return s.client ? `${s.title} · ${s.client}` : s.title;
  },
  _calDesc(s) {
    const lines = [
      s.client ? `고객사: ${s.client}` : "",
      `필요 멘토: ${s.needed_mentors}명`,
      s.memo ? `메모: ${s.memo}` : "",
      "(멘토 일정 관리에서 추가됨)",
    ].filter(Boolean);
    return lines.join("\n");
  },

  /** 구글 캘린더 "일정 추가" 링크 (클릭 시 구글 캘린더에 미리 채워진 일정 생성) */
  gcalUrl(s) {
    const dates = `${this._calStamp(s.date, s.start_time)}/${this._calStamp(s.date, s.end_time)}`;
    const p = new URLSearchParams({
      action: "TEMPLATE",
      text: this._calTitle(s),
      dates,
      ctz: "Asia/Seoul",
      details: this._calDesc(s),
      location: s.location || "",
    });
    return "https://calendar.google.com/calendar/render?" + p.toString();
  },

  /** .ics 파일 텍스트 (애플/아웃룩 등) */
  icsText(s) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stampUTC =
      now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) +
      "T" + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + "Z";
    const esc = (t) => (t || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//mentor-schedule//KO",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${s.id}@mentor-schedule`,
      `DTSTAMP:${stampUTC}`,
      `DTSTART:${this._calStamp(s.date, s.start_time)}`,
      `DTEND:${this._calStamp(s.date, s.end_time)}`,
      `SUMMARY:${esc(this._calTitle(s))}`,
      `LOCATION:${esc(s.location || "")}`,
      `DESCRIPTION:${esc(this._calDesc(s))}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
  },

  /** 여러 회차(세션 배열)를 한 .ics 로 — 교육 전체 일정 구독용 */
  icsTextMulti(sessions) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stampUTC =
      now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) +
      "T" + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + "Z";
    const esc = (t) => (t || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const head = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//mentor-schedule//KO", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    const events = sessions.map((s) =>
      [
        "BEGIN:VEVENT",
        `UID:${s.id}@mentor-schedule`,
        `DTSTAMP:${stampUTC}`,
        `DTSTART:${this._calStamp(s.date, s.start_time)}`,
        `DTEND:${this._calStamp(s.date, s.end_time)}`,
        `SUMMARY:${esc(this._calTitle(s))}`,
        `LOCATION:${esc(s.location || "")}`,
        `DESCRIPTION:${esc(this._calDesc(s))}`,
        "END:VEVENT",
      ].join("\r\n")
    );
    return [...head, ...events, "END:VCALENDAR"].join("\r\n");
  },

  _download(text, filename) {
    const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename.replace(/[\\/:*?"<>|]/g, "_");
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  /** 단일 세션 .ics 다운로드 */
  downloadIcs(s) {
    this._download(this.icsText(s), `${s.title}_${s.date}.ics`);
  },

  /** 교육 전체 회차 .ics 다운로드 */
  downloadIcsProgram(sessions) {
    const s0 = sessions[0] || {};
    this._download(this.icsTextMulti(sessions), `${s0.client || s0.title || "교육"}_전체일정.ics`);
  },
};

window.Util = Util;
