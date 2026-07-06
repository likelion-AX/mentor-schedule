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

## 7. (선택) 스마트 추가 — 캡쳐/텍스트로 교육 자동 입력

관리자 페이지의 **✨ 스마트 추가** 버튼은 공문·카톡 텍스트나 일정표 캡쳐 이미지를
AI로 분석해 '새 교육' 폼을 자동으로 채워줍니다.

- **텍스트만**: AI 미설정이어도 간단한 규칙 기반 분석으로 동작합니다 (날짜·시간 확인 필요).
- **캡쳐 이미지**: 아래처럼 엣지 함수 배포 + AI 키 설정이 필요합니다.

AI 제공자는 둘 중 아무거나 (둘 다 넣으면 Ollama 먼저 시도, 실패 시 Claude):

| 제공자 | 비용 | 시크릿 |
|---|---|---|
| **Ollama Cloud** (권장 시작점) | 무료 티어 (5시간/주간 한도) | `OLLAMA_API_KEY` |
| Anthropic Claude | 유료 (캡쳐 1장 ≈ 수십 원, 더 정확) | `ANTHROPIC_API_KEY` |

### Ollama Cloud로 설정 (무료)

```bash
# 1) https://ollama.com 가입 → https://ollama.com/settings/keys 에서 API 키 생성

# 2) Supabase CLI 로그인 + 프로젝트 연결 (처음 한 번만)
supabase login
supabase link --project-ref <프로젝트REF>

# 3) 시크릿 등록
supabase secrets set OLLAMA_API_KEY=발급받은키

# 4) 함수 배포 (저장소 루트에서)
supabase functions deploy parse-schedule
```

- 기본 모델은 비전 지원 `gemma4:31b` 입니다 (무료 한도 소모 최소, 일정표 추출 검증 완료). 바꾸려면:
  `supabase secrets set OLLAMA_MODEL=모델명` — 이미지 분석을 쓰려면 비전 모델이어야 하고,
  직접 API 호출이라 모델명에 `-cloud` 접미사를 붙이면 안 됩니다.
  (모델 목록: <https://ollama.com/search?c=cloud>)
- 무료 티어 한도(5시간 세션·주간 GPU 시간)를 넘으면 분석이 실패할 수 있어요 —
  잠시 후 재시도하거나 Claude 키를 폴백으로 추가하세요.

### Anthropic Claude로 설정 (선택)

```bash
# https://platform.claude.com 에서 키 발급 (sk-ant-...)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy parse-schedule
```

함수는 호출자의 로그인 토큰으로 **운영팀(admin) 여부를 확인**한 뒤에만 동작하며,
분석 결과는 바로 저장되지 않고 '새 교육' 폼에 채워져 사람이 확인 후 저장합니다.

---

## 8. (선택) 교육 일정 Slack 알림

교육이 새로 확정되거나 일정이 수정될 때 Slack 채널로 알림을 보냅니다. 두 경로 모두에서 동작합니다:
- 운영팀이 `admin.html`에서 직접 "+ 새 교육"으로 등록하거나 편집·저장할 때
- 로컬 `Project_management` 도구가 Pipedrive 확정 일정을 앱에 동기화(push)할 때(별도 저장소, 이 앱과는
  독립적으로 같은 Slack 웹훅을 사용)

둘 다 **실제로 값이 달라졌을 때만** 알리도록 만들어져 있습니다 — 같은 내용을 다시 저장/동기화해도
Slack이 재알림하지 않습니다.

```bash
# 1) Slack 워크스페이스에서 Incoming Webhook 생성 (api.slack.com/apps → Incoming Webhooks)
#    → 알림 받을 채널 선택 → 웹훅 URL 확보

# 2) 시크릿 등록
supabase secrets set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# 3) 함수 배포
supabase functions deploy notify-schedule-slack
```

함수는 호출자의 로그인 토큰으로 **운영팀(admin) 여부를 확인**한 뒤에만 동작합니다(`parse-schedule`과
동일 방식). 메시지에는 회사명·회차별 날짜/시간/장소·담당 멘토, 그리고 그 교육으로 바로 이동하는
앱 링크(`admin.html?program=고유ID`)가 포함됩니다.

로컬 `Project_management` 쪽에서도 알림을 보내려면, 그 저장소의 `.mentorapp.json`에
`slack_webhook_url` 필드로 같은 웹훅 URL을 추가해야 합니다(이 앱의 저장소가 아니므로 별도 설정 필요).

---

## 9. (선택) 교육 합치기 (중복 정리)

회사명 표기 차이(예: "넥센타이어" vs "넥센타이어(주)") 등으로 같은 교육이 두 번 등록되는 걸
막기 위한 안전망입니다. 추가 설정 없이 기본 내장되어 있습니다.

- **교육 목록** 탭 상단에 회사명·시기가 비슷한 교육이 있으면 "⚠️ 중복 의심 교육" 카드가 자동으로 뜹니다.
- **🔀 교육 합치기** 버튼으로 언제든 수동으로도 두 교육을 합칠 수 있습니다.
- 합치면: 원본의 회차 중 대상에 없는 날짜만 옮기고(겹치는 날짜는 대상 것을 유지, 원본은 삭제),
  배정도 마찬가지로 이동·중복 제거됩니다.

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
