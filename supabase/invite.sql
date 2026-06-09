-- ============================================================================
-- 초대 기반 가입 (additive migration) — 기존 schema.sql 실행 후 추가로 실행
-- 운영팀이 초대한 아이디만 회원가입 가능. 프론트가 아니라 DB 트리거로 강제.
-- 기존 데이터(멘토/세션/배정)는 건드리지 않음. 여러 번 실행해도 안전.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. invites — 초대 목록 (운영팀이 추가, 가입 시 검증용)
-- ----------------------------------------------------------------------------
create table if not exists public.invites (
  email      text primary key,                         -- username@도메인
  username   text not null,                            -- 아이디(표시용)
  name       text not null default '',
  role       text not null default 'mentor' check (role in ('mentor', 'admin')),
  used       boolean not null default false,           -- 가입 완료 여부
  created_by uuid references public.mentors(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.invites enable row level security;

-- 초대 목록은 운영팀만 보고/추가/삭제 가능
drop policy if exists "invites_admin_all" on public.invites;
create policy "invites_admin_all"
  on public.invites for all
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- 2. 이미 가입돼 있는 기존 계정들을 초대목록에 등록(일관성 + 재가입 대비)
-- ----------------------------------------------------------------------------
insert into public.invites (email, username, name, role, used)
select email, split_part(email, '@', 1), name, role, true
from public.mentors
on conflict (email) do nothing;

-- ----------------------------------------------------------------------------
-- 3. 가입 트리거 교체 — 초대된 이메일만 통과. 나머지는 가입 거부.
--    초대 시 지정한 이름/역할을 그대로 프로필에 반영.
-- ----------------------------------------------------------------------------
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

  insert into public.mentors (id, name, email, role)
  values (
    new.id,
    coalesce(nullif(inv.name, ''), new.raw_user_meta_data->>'full_name', ''),
    new.email,
    inv.role
  )
  on conflict (id) do update set name = excluded.name, role = excluded.role;

  update public.invites set used = true where email = new.email;
  return new;
end;
$$;

-- 트리거 재바인딩(존재하면 교체)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
