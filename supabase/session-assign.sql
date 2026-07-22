-- ============================================================================
-- session-assign.sql : 한 교육의 "일부 회차만" 참여하는 배정을 표현
--  · program.sql 에서 배정을 회차 → 교육(program_id) 단위로 바꾸면서, 멘토가 일부 회차만
--    참여하는 경우를 표현할 방법이 없어졌다. 강사료가 시급 × 실제 참여 시간이라 이게 곧
--    금액 오차로 이어진다(전 회차 기준으로 계산돼 과다 산정).
--  · assignments 는 그대로 두고(교육 단위 유지), "예외"만 이 테이블에 기록한다.
--
--  ▸ 핵심 규약 — 행이 없으면 "전 회차 참여"
--      assignment_sessions 에 그 배정의 행이 하나도 없으면 = 그 교육의 모든 회차에 참여.
--      행이 하나라도 있으면 = 적힌 회차에만 참여.
--    이 규약 덕분에 기존 배정과 앞으로 만들어질 배정이 지금과 완전히 동일하게 동작하므로,
--    backfill 이 필요 없다(그래서 이 파일에는 데이터 이관이 없다). 회차를 실제로 덜어낸
--    배정만 행을 갖는다.
--    ⚠️ "0회차 참여"는 표현하지 않는다 — 그건 배정 해제(assignments 행 삭제)와 같은 뜻이다.
--
--  · program.sql / fee.sql 이후 실행. 재실행 안전.
-- ============================================================================

create table if not exists public.assignment_sessions (
  assignment_id uuid not null references public.assignments(id)        on delete cascade,
  session_id    uuid not null references public.education_sessions(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (assignment_id, session_id)
);

-- session_id 역방향 조회용 (PK 는 assignment_id 선두라 이쪽을 못 탄다).
-- "이 회차에 실제로 오는 사람" 을 묻는 화면(캘린더 툴팁 등)이 쓴다.
create index if not exists assignment_sessions_session_idx
  on public.assignment_sessions (session_id);

comment on table public.assignment_sessions is
  '배정된 사람이 실제로 참여하는 회차. 행이 없으면 전 회차 참여(session-assign.sql 주석 참고).';

-- ----------------------------------------------------------------------------
-- RLS — assignments 와 "동등한" 열람 범위로 잠근다.
--   강사료는 회차 수에 비례하므로(fee.sql 설계 메모 참고) 이 테이블의 행 수 자체가 금액 정보다.
--   assignments 가 본인+운영팀으로 막혀 있는데 여기가 더 열려 있으면 그 방어가 무의미해진다.
-- ----------------------------------------------------------------------------
alter table public.assignment_sessions enable row level security;

drop policy if exists "assignment_sessions_select_own_or_admin" on public.assignment_sessions;
drop policy if exists "assignment_sessions_admin_write"         on public.assignment_sessions;

create policy "assignment_sessions_select_own_or_admin"
  on public.assignment_sessions for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.assignments a
      where a.id = assignment_id
        and a.person_email = (auth.jwt() ->> 'email')
    )
  );

create policy "assignment_sessions_admin_write"
  on public.assignment_sessions for all
  using (public.is_admin())
  with check (public.is_admin());

-- 멘토에게는 쓰기 정책을 "일부러" 주지 않는다.
--   assignments 에는 본인이 상태를 수락/거절로 바꾸는 assignments_staff_respond 정책이 있고,
--   그래서 secure.sql 의 guard_assignment_update 트리거로 나머지 컬럼을 막아야 했다.
--   여기는 멘토에게 INSERT/UPDATE/DELETE 경로가 아예 없으므로(RLS 기본 거부) 같은 성격의
--   가드 트리거가 필요 없다. 회차를 스스로 지워 정산을 부풀리는 경로도 함께 막힌다.
--   ▸ 나중에 멘토가 회차를 직접 조정하게 만들 일이 생기면, 그때는 반드시
--     guard 트리거(운영팀 확정 후 변경 금지 등)를 함께 넣을 것.

-- ----------------------------------------------------------------------------
-- 확인용 쿼리
-- ----------------------------------------------------------------------------
-- 1) 일부 회차만 참여하는 배정 (행이 있는 것들)
--    select a.person_email, a.program_id,
--           count(x.session_id) as 참여회차,
--           (select count(*) from public.education_sessions s where s.program_id = a.program_id) as 전체회차
--      from public.assignments a
--      join public.assignment_sessions x on x.assignment_id = a.id
--     group by a.id, a.person_email, a.program_id;
--
-- 2) 정책 확인
--    select policyname, cmd from pg_policies where tablename = 'assignment_sessions';
