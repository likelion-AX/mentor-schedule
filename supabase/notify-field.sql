-- ============================================================================
-- notify-field.sql : 알림용 실제 이메일 컬럼 추가
--  · 로그인 아이디(username@도메인)는 가짜일 수 있어, 알림이 닿을 진짜 메일을 따로 저장.
--  · invites/mentors 에 notify_email 추가 + 가입 트리거가 함께 복사.
-- ============================================================================

alter table public.invites add column if not exists notify_email text;
alter table public.mentors add column if not exists notify_email text;

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
  insert into public.mentors (id, name, email, role, staff_type, notify_email)
  values (
    new.id,
    coalesce(nullif(inv.name, ''), new.raw_user_meta_data->>'full_name', ''),
    new.email,
    inv.role,
    coalesce(inv.staff_type, 'mentor'),
    inv.notify_email
  )
  on conflict (id) do update set
    name = excluded.name, role = excluded.role,
    staff_type = excluded.staff_type, notify_email = excluded.notify_email;
  update public.invites set used = true where email = new.email;
  return new;
end;
$$;
