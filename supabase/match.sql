-- ============================================================================
-- match.sql : 이름 기반 매칭 가입
--  · 운영팀이 '이름'만으로 멘토 미리 등록 → 멘토가 가입할 때 이름으로 자동 연결
--  · 트리거: ① 이메일 매칭 → ② 이름 매칭(미가입) → ③ 없으면 신규로 받아줌
--  · 기존 미가입자의 (수집 안 된) 가짜 이메일을 placeholder 로 정리
-- ============================================================================

-- 1) 미가입 명단의 가짜 이메일 → placeholder@pending.local (이메일 미정 표시 + 이름매칭용)
do $$
declare r record; ph text;
begin
  for r in select email from public.invites where used = false and email not like '%@pending.local' loop
    ph := 'pending-' || replace(gen_random_uuid()::text, '-', '') || '@pending.local';
    update public.assignments set person_email = ph where person_email = r.email;
    update public.invites set email = ph, username = split_part(ph, '@', 1), notify_email = null where email = r.email;
  end loop;
end $$;

-- 2) 가입 트리거 (이름 매칭)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $func$
declare
  inv public.invites;
  sname text;
begin
  sname := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'full_name', ''), '\s+', '', 'g'));

  -- (1) 이메일이 명단에 이미 있으면 그걸로 매칭
  select * into inv from public.invites where email = new.email;
  if inv.email is not null then
    insert into public.mentors(id, name, email, role, staff_type, notify_email)
      values(new.id, coalesce(nullif(inv.name, ''), new.raw_user_meta_data->>'full_name', ''),
             new.email, inv.role, coalesce(inv.staff_type, 'mentor'), new.email)
      on conflict(id) do update set name=excluded.name, role=excluded.role,
             staff_type=excluded.staff_type, notify_email=excluded.notify_email;
    update public.invites set used = true, notify_email = new.email where email = new.email;
    return new;
  end if;

  -- (2) 이름으로 미가입 명단 매칭 (띄어쓰기·대소문자 무시)
  if sname <> '' then
    select * into inv from public.invites
      where used = false and lower(regexp_replace(name, '\s+', '', 'g')) = sname
      order by created_at limit 1;
    if inv.email is not null then
      update public.assignments set person_email = new.email where person_email = inv.email;
      update public.invites set email = new.email, username = split_part(new.email, '@', 1),
             notify_email = new.email, used = true where email = inv.email;
      insert into public.mentors(id, name, email, role, staff_type, notify_email)
        values(new.id, inv.name, new.email, inv.role, coalesce(inv.staff_type, 'mentor'), new.email)
        on conflict(id) do update set name=excluded.name, role=excluded.role,
               staff_type=excluded.staff_type, notify_email=excluded.notify_email;
      return new;
    end if;
  end if;

  -- (3) 매칭 없음 → 신규 멘토로 받아줌
  insert into public.mentors(id, name, email, role, staff_type, notify_email)
    values(new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email, 'mentor', 'mentor', new.email)
    on conflict(id) do nothing;
  insert into public.invites(email, username, name, role, staff_type, notify_email, used)
    values(new.email, split_part(new.email, '@', 1), coalesce(new.raw_user_meta_data->>'full_name', ''),
           'mentor', 'mentor', new.email, true)
    on conflict(email) do update set used = true;
  return new;
end; $func$;
