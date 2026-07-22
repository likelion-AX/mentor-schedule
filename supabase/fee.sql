-- ============================================================================
-- 강사료 (시간당 단가 기준)
--
-- 설계 메모 — 금액을 어디에 두느냐가 곧 "누가 볼 수 있느냐"다.
--
--  · assignments      : 사람별 실제 강사료. 이 테이블의 기존 RLS가
--                       (person_email = 본인) or is_admin() 이라 본인·운영팀만 읽는다.
--                       따라서 강사료 컬럼을 여기 두면 별도 정책 없이 프라이버시가 지켜진다.
--  · invites          : 사람별 "기본 시급". invites_admin_all 정책이라 운영팀만 읽는다.
--                       배정할 때 이 값을 assignments.fee_per_hour 로 복사(스냅샷)하므로,
--                       나중에 단가 정책이 바뀌어도 이미 끝난 교육의 금액은 흔들리지 않는다.
--  · education_sessions : break_mins(휴게시간)만. 금액이 아니라서 노출 문제가 없다.
--                       이 테이블은 로그인한 멘토 전원이 읽으므로 금액은 절대 넣지 말 것.
--
-- 실행: Supabase SQL Editor에 붙여넣고 Run. 여러 번 실행해도 안전(idempotent).
-- ============================================================================

-- 1) 배정별 실제 강사료 ------------------------------------------------------
alter table public.assignments
  add column if not exists fee_per_hour integer,                   -- 시간당(원). null = 아직 미정
  add column if not exists fee_note     text not null default '';  -- 예: "교통비 별도"

do $$ begin
  alter table public.assignments
    add constraint assignments_fee_per_hour_nonneg check (fee_per_hour is null or fee_per_hour >= 0);
exception when duplicate_object then null;
end $$;

comment on column public.assignments.fee_per_hour is
  '시간당 강사료(원). 배정 시 invites.default_fee_per_hour 를 복사한 스냅샷이며 건별로 수정 가능. null이면 안내 이미지에서 강사료 블록을 생략한다.';

-- 2) 명단의 기본 시급 (운영팀만 조회/수정) -----------------------------------
alter table public.invites
  add column if not exists default_fee_per_hour integer;

do $$ begin
  alter table public.invites
    add constraint invites_default_fee_nonneg check (default_fee_per_hour is null or default_fee_per_hour >= 0);
exception when duplicate_object then null;
end $$;

comment on column public.invites.default_fee_per_hour is
  '이 사람의 기본 시간당 강사료(원). 새 배정의 초기값으로만 쓰이고, 기존 배정 금액에는 소급되지 않는다.';

-- 3) 회차별 휴게시간 ---------------------------------------------------------
-- 시간당 단가로 정산하므로 무급 휴게(점심 등)를 빼지 않으면 금액이 그대로 틀어진다.
-- default 0 이라 기존 회차·화면 동작은 그대로다.
alter table public.education_sessions
  add column if not exists break_mins integer not null default 0;

do $$ begin
  alter table public.education_sessions
    add constraint education_sessions_break_mins_nonneg check (break_mins >= 0);
exception when duplicate_object then null;
end $$;

comment on column public.education_sessions.break_mins is
  '무급 휴게시간(분). 정산 시간 = (종료 - 시작) - break_mins.';

-- 4) RLS 변경 없음 -----------------------------------------------------------
-- assignments / invites 의 기존 정책이 그대로 강사료를 감싼다. 확인용 쿼리:
--   select tablename, policyname, cmd from pg_policies
--    where tablename in ('assignments','invites') order by tablename, policyname;
