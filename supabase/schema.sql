-- ============================================================================
-- 멘토 일정 관리 — Supabase 스키마 + RLS + 시드
-- 비대칭 공개 모델:
--   · education_sessions (기업 교육 일정)  → 모든 멘토에게 공개(읽기), 운영팀만 쓰기
--   · mentor_blocks      (멘토 개인 일정)  → 본인 + 운영팀만 열람. 멘토끼리 비공개
--   · assignments        (세션 배정)       → 본인 배정 + 운영팀 열람
-- Supabase SQL Editor 에 통째로 붙여넣어 실행.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. 정리(재실행 안전) — 개발 중에만 사용. 운영 데이터가 있으면 주석 처리.
-- ----------------------------------------------------------------------------
drop table if exists public.assignments cascade;
drop table if exists public.mentor_blocks cascade;
drop table if exists public.education_sessions cascade;
drop table if exists public.mentors cascade;
drop function if exists public.is_admin() cascade;
drop function if exists public.handle_new_user() cascade;

-- ----------------------------------------------------------------------------
-- 1. mentors — 사용자 프로필 (id = 구글 로그인 auth.uid())
-- ----------------------------------------------------------------------------
create table public.mentors (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  email      text not null,
  role       text not null default 'mentor' check (role in ('mentor', 'admin')),
  created_at timestamptz not null default now()
);
comment on table public.mentors is '멘토/운영팀 프로필. id 는 auth.users 의 uid.';

-- ----------------------------------------------------------------------------
-- 2. education_sessions — 기업 교육 세션 (운영팀이 생성, 전 멘토 공개)
-- ----------------------------------------------------------------------------
create table public.education_sessions (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  client          text not null default '',          -- 고객사
  date            date not null,
  start_time      time not null,
  end_time        time not null,
  location        text not null default '',
  needed_mentors  int  not null default 1 check (needed_mentors >= 1),
  status          text not null default '모집중' check (status in ('모집중', '확정', '완료', '취소')),
  memo            text not null default '',
  created_by      uuid references public.mentors(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on public.education_sessions (date);

-- ----------------------------------------------------------------------------
-- 3. mentor_blocks — 멘토 개인 일정 (충돌 판단용, 멘토끼리 비공개)
-- ----------------------------------------------------------------------------
create table public.mentor_blocks (
  id         uuid primary key default gen_random_uuid(),
  mentor_id  uuid not null references public.mentors(id) on delete cascade,
  date       date not null,
  start_time time not null,
  end_time   time not null,
  memo       text not null default '',
  created_at timestamptz not null default now()
);
create index on public.mentor_blocks (mentor_id, date);

-- ----------------------------------------------------------------------------
-- 4. assignments — 세션-멘토 배정
-- ----------------------------------------------------------------------------
create table public.assignments (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.education_sessions(id) on delete cascade,
  mentor_id  uuid not null references public.mentors(id) on delete cascade,
  status     text not null default '제안' check (status in ('제안', '수락', '거절', '확정')),
  created_at timestamptz not null default now(),
  unique (session_id, mentor_id)
);
create index on public.assignments (mentor_id);
create index on public.assignments (session_id);

-- ----------------------------------------------------------------------------
-- 5. 헬퍼 — 현재 로그인 사용자가 운영팀(admin)인지
--    RLS 정책 안에서 mentors 를 다시 select 하면 재귀가 생기므로
--    security definer 함수로 우회.
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.mentors
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ----------------------------------------------------------------------------
-- 6. 신규 가입자 자동 프로필 생성 (구글 로그인 → mentors 행 자동 insert)
--    이메일 도메인이 likelion.net 이면 mentor 로, 그 외도 일단 mentor.
--    admin 승격은 아래 9번에서 수동으로.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.mentors (id, name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
    new.email,
    'mentor'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- 7. RLS — Row Level Security
-- ============================================================================
alter table public.mentors            enable row level security;
alter table public.education_sessions enable row level security;
alter table public.mentor_blocks      enable row level security;
alter table public.assignments        enable row level security;

-- ---- mentors ----------------------------------------------------------------
-- 본인 프로필은 누구나 읽기 가능(이름 표시용). 단, role/email 노출은 앱에서 통제.
-- 운영팀은 전체 열람. 본인은 본인 행만 수정(이름).
create policy "mentors_select_all"
  on public.mentors for select
  using (auth.uid() is not null);

create policy "mentors_update_self"
  on public.mentors for update
  using (id = auth.uid());

create policy "mentors_admin_all"
  on public.mentors for all
  using (public.is_admin())
  with check (public.is_admin());

-- ---- education_sessions -----------------------------------------------------
-- 로그인한 모든 멘토 읽기 가능. 쓰기는 운영팀만.
create policy "sessions_select_authed"
  on public.education_sessions for select
  using (auth.uid() is not null);

create policy "sessions_admin_write"
  on public.education_sessions for all
  using (public.is_admin())
  with check (public.is_admin());

-- ---- mentor_blocks (핵심: 멘토끼리 비공개) ----------------------------------
-- 본인 일정만 열람/수정. 운영팀은 전체 열람(충돌 판단용)이되 수정은 본인만.
create policy "blocks_select_own_or_admin"
  on public.mentor_blocks for select
  using (mentor_id = auth.uid() or public.is_admin());

create policy "blocks_insert_own"
  on public.mentor_blocks for insert
  with check (mentor_id = auth.uid());

create policy "blocks_update_own"
  on public.mentor_blocks for update
  using (mentor_id = auth.uid())
  with check (mentor_id = auth.uid());

create policy "blocks_delete_own"
  on public.mentor_blocks for delete
  using (mentor_id = auth.uid());

-- ---- assignments ------------------------------------------------------------
-- 본인 배정 열람 + 운영팀 전체. 생성/삭제는 운영팀.
-- 멘토는 본인 배정의 status(수락/거절)만 변경.
create policy "assignments_select_own_or_admin"
  on public.assignments for select
  using (mentor_id = auth.uid() or public.is_admin());

create policy "assignments_admin_write"
  on public.assignments for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "assignments_mentor_respond"
  on public.assignments for update
  using (mentor_id = auth.uid())
  with check (mentor_id = auth.uid() and status in ('수락', '거절'));

-- ============================================================================
-- 8. 시드 데이터 (선택) — 세션 예시. 멘토/배정은 실제 가입 후 생성.
--    created_by 는 NULL 로 두고, 가입 후 운영팀이 편집.
-- ============================================================================
insert into public.education_sessions (title, client, date, start_time, end_time, location, needed_mentors, status, memo)
values
  ('AI 기초 사내교육',   '삼성전자',   date '2026-06-15', time '10:00', time '13:00', '수원 디지털시티', 2, '모집중', '비전공자 대상'),
  ('파이썬 데이터분석', 'LG화학',     date '2026-06-18', time '14:00', time '18:00', '온라인(Zoom)',   3, '모집중', '중급'),
  ('노코드 워크샵',     '현대모비스', date '2026-06-22', time '09:30', time '12:30', '용인 본사',       1, '확정',   '');

-- ============================================================================
-- 9. 운영팀(admin) 승격 — 가입(구글 로그인 1회) 후 본인 이메일로 실행
--    아래 이메일을 운영팀 계정으로 바꿔 한 줄씩 실행.
-- ============================================================================
-- update public.mentors set role = 'admin' where email = 'seungcheol.hong@likelion.net';
