# 멘토 일정 관리 — 설치 가이드

운영팀이 멘토 가용 시간을 보고 기업 교육 세션에 배정하고, 멘토 개인 일정과의 충돌을 방지하는 웹앱입니다.

## 핵심 개념 — 비대칭 공개 모델

| 데이터 | 공개 범위 |
|---|---|
| **기업 교육 세션** (운영팀 생성) | 모든 멘토에게 공개 (읽기 전용) |
| **멘토 개인 일정** (본인 등록) | 본인 + 운영팀만 열람. **멘토끼리는 비공개** |
| **세션 배정** | 본인 배정 + 운영팀 |

멘토끼리의 개인 일정 비공개는 Supabase **RLS**(`mentor_id = auth.uid()`)로 서버단에서 차단합니다. 프론트 코드가 아니라 DB가 막으므로 우회 불가합니다.

---

## 폴더 구조

```
mento_date_manage/
├─ index.html          로그인 + 역할 라우팅
├─ mentor.html         멘토: 캘린더(3색) + 개인일정 + 내 배정
├─ admin.html          운영팀: 세션 CRUD + 배정 보드(충돌 자동필터)
├─ SETUP.md
├─ css/
│  ├─ tokens.css       라이언즈 디자인시스템 토큰 (color/spacing/radius/font)
│  └─ app.css          공통 컴포넌트 스타일
├─ js/
│  ├─ config.js        ⚠️ Supabase URL/KEY 입력 필요
│  ├─ auth.js          구글 로그인 / 세션 / 페이지 가드
│  ├─ util.js          날짜·충돌 판정·토스트
│  ├─ mentor.js        멘토 화면 로직
│  └─ admin.js         운영팀 화면 로직
└─ supabase/
   └─ schema.sql       테이블 + RLS + 트리거 + 시드
```

빌드 도구 없음. 정적 파일 + CDN(Supabase JS, FullCalendar, Pretendard)만 사용합니다.

---

## 1. Supabase 프로젝트 만들기

1. <https://supabase.com> 에서 새 프로젝트 생성 (리전: Northeast Asia (Seoul) 권장)
2. **SQL Editor** → New query → [`supabase/schema.sql`](supabase/schema.sql) 전체를 붙여넣고 **Run**
   - 테이블 4개(`mentors`, `education_sessions`, `mentor_blocks`, `assignments`), RLS 정책, 신규가입 트리거, 시드 세션 3건이 생성됩니다.

## 2. 구글 로그인(OAuth) 설정

1. **Google Cloud Console** → OAuth 동의 화면 + OAuth 2.0 클라이언트 ID(웹) 생성
2. 승인된 리디렉션 URI에 Supabase 콜백 추가:
   `https://<프로젝트REF>.supabase.co/auth/v1/callback`
3. Supabase → **Authentication → Providers → Google** 켜고 Client ID/Secret 입력
4. **Authentication → URL Configuration → Site URL / Redirect URLs** 에 배포 도메인과
   로컬 테스트 주소(`http://localhost:5173` 등)를 추가
5. (선택) Workspace 도메인 제한은 앱단에서 `config.js` 의 `ALLOWED_EMAIL_DOMAINS` 로 처리됩니다.

## 3. 앱 설정값 입력

[`js/config.js`](js/config.js) 를 열어 두 값을 채웁니다 (Supabase → Settings → API):

```js
SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",   // anon 키는 공개 안전 (RLS 로 보호)
ALLOWED_EMAIL_DOMAINS: ["likelion.net"],     // 제한 없애려면 []
```

## 4. 로컬 실행

`file://` 로 열면 OAuth 리디렉션이 동작하지 않으므로 정적 서버로 띄웁니다:

```powershell
# 폴더에서
npx serve .
#   또는
python -m http.server 5173
```

브라우저에서 `http://localhost:5173` 접속 → 구글 로그인.

## 5. 운영팀(admin) 계정 지정

처음엔 모두 `mentor` 입니다. 운영팀 담당자가 **한 번 로그인**한 뒤,
Supabase SQL Editor 에서 본인 이메일로 승격합니다:

```sql
update public.mentors set role = 'admin'
where email = 'seungcheol.hong@likelion.net';
```

이후 그 계정으로 로그인하면 `admin.html` 로 자동 이동합니다.

## 6. 배포 (Vercel / Netlify)

정적 사이트로 그대로 올리면 됩니다.

- **Vercel**: `vercel` (빌드 설정 없음, 루트가 그대로 퍼블릭)
- **Netlify**: 폴더 드래그&드롭 또는 `netlify deploy`
- 배포 후 도메인을 Supabase **Redirect URLs / Site URL** 에 추가하는 것을 잊지 마세요.

---

## 사용 흐름

**멘토** (`mentor.html`)
- 좌측에서 개인 일정(가용 불가 시간)을 등록 → 캘린더에 🔒 회색으로 표시
- 캘린더에서 파란색 = 기업 세션, 주황색 = 내가 배정된 세션
- 운영팀이 배정을 제안하면 “내 배정 현황”에서 **수락/거절**

**운영팀** (`admin.html`)
- “+ 새 세션”으로 교육 세션 생성/편집/삭제
- 세션 선택 → 배정 보드에서 멘토별 **가용/충돌** 자동 판정
  - 개인 일정이 겹치면 **충돌**(회색), 안 겹치면 **가능**(초록)이 위로 정렬
  - 충돌 멘토도 확인 후 강제 배정 가능
- 멘토가 수락하면 **확정** 처리

---

## 보안 메모

- `anon` 키는 클라이언트에 노출되어도 안전합니다. 실제 접근 통제는 전부 **RLS 정책**(`schema.sql` 7번)이 담당합니다.
- 멘토 개인 일정은 `blocks_select_own_or_admin` 정책으로 **본인/운영팀 외에는 SELECT 자체가 불가**합니다.
- 멘토는 본인 배정의 상태를 `수락`/`거절`로만 바꿀 수 있고(`assignments_mentor_respond`), `확정`은 운영팀만 가능합니다.
