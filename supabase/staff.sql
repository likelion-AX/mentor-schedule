-- ============================================================================
-- staff.sql : 멘토 + 퍼실리테이터 (명단·배정 분리)
--  · 결정: 둘 다 로그인. 배정은 "운영팀 명단(invites)" 기준 → 미가입자도 배정 가능.
--  · 배정(assignments)을 mentor_id(로그인 uid) → person_email(명단 식별자) 기준으로 재구성.
--  · invite.sql 실행 이후에 추가로 실행. 재실행 안전(가드 포함).
-- ============================================================================

-- 1) 구분(staff_type) 컬럼 — invites / mentors
alter table public.invites
  add column if not exists staff_type text not null default 'mentor'
  check (staff_type in ('mentor', 'facilitator'));
alter table public.mentors
  add column if not exists staff_type text not null default 'mentor'
  check (staff_type in ('mentor', 'facilitator'));

-- 2) 세션에 퍼실리테이터 필요 인원
alter table public.education_sessions
  add column if not exists needed_facilitators int not null default 0;

-- 3) assignments 재구성 (mentor_id → person_email). 기존 데이터 이관. (한 번만)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assignments' and column_name = 'mentor_id'
  ) then
    create table public.assignments_new (
      id          uuid primary key default gen_random_uuid(),
      session_id  uuid not null references public.education_sessions(id) on delete cascade,
      person_email text not null,
      staff_type  text not null default 'mentor' check (staff_type in ('mentor', 'facilitator')),
      status      text not null default '제안' check (status in ('제안', '수락', '거절', '확정')),
      created_at  timestamptz not null default now(),
      unique (session_id, person_email)
    );

    insert into public.assignments_new (id, session_id, person_email, staff_type, status, created_at)
    select a.id, a.session_id, m.email, coalesce(m.staff_type, 'mentor'), a.status, a.created_at
    from public.assignments a
    join public.mentors m on m.id = a.mentor_id
    on conflict do nothing;

    drop table public.assignments cascade;
    alter table public.assignments_new rename to assignments;
  end if;
end $$;

create index if not exists assignments_session_idx on public.assignments (session_id);
create index if not exists assignments_email_idx   on public.assignments (person_email);

-- 4) RLS — 본인(이메일) 또는 운영팀
alter table public.assignments enable row level security;

drop policy if exists "assignments_select_own_or_admin" on public.assignments;
drop policy if exists "assignments_admin_write"         on public.assignments;
drop policy if exists "assignments_mentor_respond"      on public.assignments;
drop policy if exists "assignments_staff_respond"       on public.assignments;

create policy "assignments_select_own_or_admin"
  on public.assignments for select
  using (person_email = (auth.jwt() ->> 'email') or public.is_admin());

create policy "assignments_admin_write"
  on public.assignments for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "assignments_staff_respond"
  on public.assignments for update
  using (person_email = (auth.jwt() ->> 'email'))
  with check (person_email = (auth.jwt() ->> 'email') and status in ('수락', '거절'));

-- 5) 가입 트리거: staff_type 도 함께 반영
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.invites;
begin
  select * into inv from public.invites where email = new.email;
  if inv.email is null then
    raise exception '초대되지 않은 아이디입니다. 운영팀에 문의하세요.';
  end if;
  insert into public.mentors (id, name, email, role, staff_type)
  values (
    new.id,
    coalesce(nullif(inv.name, ''), new.raw_user_meta_data->>'full_name', ''),
    new.email,
    inv.role,
    coalesce(inv.staff_type, 'mentor')
  )
  on conflict (id) do update set name = excluded.name, role = excluded.role, staff_type = excluded.staff_type;
  update public.invites set used = true where email = new.email;
  return new;
end;
$$;
