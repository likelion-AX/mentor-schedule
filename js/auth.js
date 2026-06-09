// ============================================================================
// 인증 / 세션 / 역할 — 구글 로그인 + 프로필 로드 + 페이지 가드
// 모든 페이지에서 config.js 다음에 로드.
// ============================================================================

const Auth = {
  /** 구글 OAuth 로그인 시작 — 로그인 후 첫 화면(index)으로 복귀해 역할 분기 */
  async signInWithGoogle() {
    const { error } = await window.sb.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + "/",
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) alert("로그인 실패: " + error.message);
  },

  /** 짧은 아이디를 내부 이메일로 변환. 이미 @가 있으면 그대로 사용. */
  toEmail(idOrEmail) {
    const v = (idOrEmail || "").trim();
    if (v.includes("@")) return v;
    return v + "@" + (window.APP_CONFIG.LOGIN_DOMAIN || "likelion.net");
  },

  /** 이메일+비밀번호 회원가입 (이름은 메타데이터로 전달 → 트리거가 프로필 생성) */
  async signUpWithEmail(email, password, name) {
    const { data, error } = await window.sb.auth.signUp({
      email,
      password,
      options: { data: { full_name: name } },
    });
    return { data, error };
  },

  /** 이메일+비밀번호 로그인 */
  async signInWithEmail(email, password) {
    const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
    return { data, error };
  },

  async signOut() {
    await window.sb.auth.signOut();
    window.location.href = "index.html";
  },

  /** 현재 세션 반환 (없으면 null) */
  async getSession() {
    const { data } = await window.sb.auth.getSession();
    return data.session || null;
  },

  /** mentors 테이블의 내 프로필(역할 포함). 없으면 null */
  async getProfile() {
    const session = await this.getSession();
    if (!session) return null;
    const { data, error } = await window.sb
      .from("mentors")
      .select("id, name, email, role")
      .eq("id", session.user.id)
      .single();
    if (error) {
      console.warn("프로필 로드 실패:", error.message);
      // 트리거 지연으로 아직 행이 없을 수 있음 → 최소 정보로 폴백
      return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.user_metadata?.full_name || "",
        role: "mentor",
      };
    }
    return data;
  },

  /** 허용 도메인 체크 */
  isAllowedEmail(email) {
    const domains = window.APP_CONFIG.ALLOWED_EMAIL_DOMAINS || [];
    if (domains.length === 0) return true;
    return domains.some((d) => (email || "").toLowerCase().endsWith("@" + d));
  },

  /**
   * 페이지 가드. 로그인 필수. 옵션으로 admin 강제.
   * 반환: 프로필 객체. 통과 못하면 리다이렉트 후 never 반환.
   */
  async requireAuth({ admin = false } = {}) {
    const session = await this.getSession();
    if (!session) {
      window.location.href = "index.html";
      return new Promise(() => {}); // 정지
    }
    if (!this.isAllowedEmail(session.user.email)) {
      await this.signOut();
      return new Promise(() => {});
    }
    const profile = await this.getProfile();
    if (admin && profile.role !== "admin") {
      alert("운영팀 전용 페이지입니다.");
      window.location.href = "mentor.html";
      return new Promise(() => {});
    }
    return profile;
  },

  /** 헤더 우측 사용자 영역 렌더 */
  renderUserArea(profile, el) {
    if (!el) return;
    const roleLabel = profile.role === "admin" ? "운영팀" : "멘토";
    el.innerHTML = `
      <span class="badge badge-neutral">${roleLabel}</span>
      <span>${profile.name || profile.email}</span>
      <button class="btn btn-ghost btn-sm" id="signOutBtn">로그아웃</button>
    `;
    el.querySelector("#signOutBtn").addEventListener("click", () => this.signOut());
  },
};

window.Auth = Auth;
