// ============================================================================
// notify-assignment : 배정 변경 시 메일 알림 (Gmail SMTP, 외부 의존성 0)
//  · 배정 제안(INSERT, status=제안)  → 멘토/퍼실 본인에게
//  · 수락/거절(UPDATE, status 변경)  → 운영팀(ADMIN_EMAIL)에게
//  · DB 트리거(pg_net)가 호출. x-notify-secret 헤더로 보호.
//  시크릿: SMTP_USER, SMTP_PASS, APP_URL, ADMIN_EMAIL, NOTIFY_SECRET
//         (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 주입)
// ============================================================================
const SMTP_USER = Deno.env.get("SMTP_USER")!;
const SMTP_PASS = Deno.env.get("SMTP_PASS")!;
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "";
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const hhmm = (t: string) => (t || "").slice(0, 5);
function fmtDate(d: string) {
  const x = new Date(d + "T00:00:00");
  const w = ["일", "월", "화", "수", "목", "금", "토"];
  return `${x.getMonth() + 1}월 ${x.getDate()}일(${w[x.getDay()]})`;
}
const b64utf8 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function rest(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
  return r.ok ? await r.json() : [];
}

// --- 의존성 없는 최소 SMTP (Gmail, 465 implicit TLS) ---
async function smtpSend(to: string, subject: string, html: string) {
  const conn = await Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const buf = new Uint8Array(8192);
  const read = async () => { const n = await conn.read(buf); return dec.decode(buf.subarray(0, n ?? 0)); };
  const send = async (line: string) => { await conn.write(enc.encode(line + "\r\n")); return await read(); };
  try {
    await read(); // 220 greeting
    await send("EHLO smtp.gmail.com");
    await send("AUTH LOGIN");
    await send(btoa(SMTP_USER));
    const authRes = await send(btoa(SMTP_PASS));
    if (!authRes.startsWith("235")) throw new Error("AUTH 실패: " + authRes.trim());
    await send(`MAIL FROM:<${SMTP_USER}>`);
    await send(`RCPT TO:<${to}>`);
    const dataRes = await send("DATA");
    if (!dataRes.startsWith("354")) throw new Error("DATA 거부: " + dataRes.trim());
    const body = (b64utf8(html).match(/.{1,76}/g) ?? []).join("\r\n");
    const msg = [
      `From: =?UTF-8?B?${b64utf8("멘토 일정 관리")}?= <${SMTP_USER}>`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      body,
    ].join("\r\n");
    await conn.write(enc.encode(msg + "\r\n.\r\n"));
    const sendRes = await read();
    if (!sendRes.startsWith("250")) throw new Error("발송 거부: " + sendRes.trim());
    await send("QUIT");
  } finally {
    try { conn.close(); } catch (_) { /* noop */ }
  }
}

const WRAP = (inner: string) =>
  `<div style="font-family:sans-serif;max-width:520px;line-height:1.6">${inner}` +
  `<p style="margin-top:20px"><a href="${APP_URL}" style="background:#FF6000;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">사이트 열기</a></p>` +
  `<p style="color:#888;font-size:12px;margin-top:16px">멘토 일정 관리 시스템</p></div>`;

Deno.serve(async (req) => {
  try {
    if (NOTIFY_SECRET && req.headers.get("x-notify-secret") !== NOTIFY_SECRET) {
      return new Response("forbidden", { status: 401 });
    }
    const { type, record, old_record } = await req.json();
    if (!record?.program_id) return json({ skip: "no record" });

    const sess = await rest(
      `education_sessions?program_id=eq.${record.program_id}&select=client,title,date,start_time,end_time&order=date`,
    );
    if (!sess.length) return json({ skip: "no program" });
    const p = sess[0];
    const dates = sess.map((s: { date: string }) => fmtDate(s.date)).join(", ");
    const time = `${hhmm(p.start_time)}~${hhmm(p.end_time)}`;
    const label = record.staff_type === "facilitator" ? "퍼실리테이터" : "멘토";

    if (type === "INSERT" && record.status === "제안") {
      await smtpSend(
        record.person_email,
        `[멘토일정] '${p.client}' ${label} 배정 제안`,
        WRAP(`<h2 style="color:#FF6000">${label} 배정 제안 🔔</h2>
          <p><b>${p.client}</b> · ${p.title}</p>
          <p><b>${sess.length}회차</b>: ${dates}<br>시간: ${time}</p>
          <p>사이트에 로그인해서 <b>수락 또는 거절</b>해 주세요.</p>`),
      );
      return json({ sent: "mentor", to: record.person_email });
    }

    if (
      type === "UPDATE" && old_record && old_record.status !== record.status &&
      (record.status === "수락" || record.status === "거절")
    ) {
      if (!ADMIN_EMAIL) return json({ skip: "no admin email" });
      const inv = await rest(`invites?email=eq.${encodeURIComponent(record.person_email)}&select=name`);
      const who = inv[0]?.name || record.person_email.split("@")[0];
      const color = record.status === "수락" ? "#0DA796" : "#E12337";
      await smtpSend(
        ADMIN_EMAIL,
        `[멘토일정] ${who}님이 '${p.client}' ${record.status}`,
        WRAP(`<h2 style="color:${color}">배정 ${record.status}</h2>
          <p><b>${who}</b>님이 <b>${p.client}</b> · ${p.title} (${label}) 배정을 <b>${record.status}</b>했습니다.</p>
          <p>${sess.length}회차 · ${time}</p>`),
      );
      return json({ sent: "admin", to: ADMIN_EMAIL });
    }

    return json({ skip: "no-op", type, status: record.status });
  } catch (e) {
    return json({ error: String(e) });
  }
});
