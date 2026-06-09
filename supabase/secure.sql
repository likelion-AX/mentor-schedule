-- ============================================================================
-- secure.sql : 권한 상승 방지 (RLS 보완)
--  · 멘토(비관리자)가 본인 mentors 행의 role/staff_type/email 을 못 바꾸게 막음
--    (RLS update 정책만으론 컬럼 변경을 막지 못해 권한상승 가능 → 트리거로 차단)
--  · 배정도 비관리자는 status 외 필드 고정
-- ============================================================================

create or replace function public.guard_mentor_update()
returns trigger language plpgsql as $$
begin
  if not public.is_admin() then
    new.role := old.role;
    new.staff_type := old.staff_type;
    new.email := old.email;
  end if;
  return new;
end; $$;

drop trigger if exists trg_guard_mentor_update on public.mentors;
create trigger trg_guard_mentor_update before update on public.mentors
  for each row execute function public.guard_mentor_update();

create or replace function public.guard_assignment_update()
returns trigger language plpgsql as $$
begin
  if not public.is_admin() then
    new.program_id := old.program_id;
    new.person_email := old.person_email;
    new.staff_type := old.staff_type;
  end if;
  return new;
end; $$;

drop trigger if exists trg_guard_assignment_update on public.assignments;
create trigger trg_guard_assignment_update before update on public.assignments
  for each row execute function public.guard_assignment_update();
