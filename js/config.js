// ============================================================================
// Supabase 연결 설정
// 1) Supabase 프로젝트 > Settings > API 에서 Project URL 과 anon public 키 복사
// 2) 아래 두 값에 붙여넣기 (anon 키는 공개되어도 안전 — RLS 로 보호됨)
// ============================================================================

window.APP_CONFIG = {
  SUPABASE_URL: "https://uwuvrvwgylkirwuwzoux.supabase.co",
  // 새 publishable 키 (구 anon 키 대체). 공개되어도 안전 — 접근통제는 RLS 담당.
  SUPABASE_ANON_KEY: "sb_publishable_TPbDzZH9I4aJ1M4f1FfkUw_SWbewBA9",

  // 로그인 허용 도메인 (빈 배열이면 제한 없음). 테스트 편의를 위해 우선 제한 없음.
  ALLOWED_EMAIL_DOMAINS: [],

  // 아이디 로그인용 — 짧은 아이디 뒤에 이 도메인을 자동으로 붙여 내부 이메일로 사용.
  // 예: 아이디 "admin" → 내부적으로 "admin@likelion.net"
  LOGIN_DOMAIN: "likelion.net",
};

// Supabase 클라이언트 (supabase-js v2 CDN 전역 `supabase` 사용)
window.sb = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);
