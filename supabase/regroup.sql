-- ============================================================================
-- regroup.sql : program.sql 의 backfill 버그 보정
--  (gen_random_uuid() 가 행마다 평가돼 같은 교육이 회차별로 쪼개진 것을 재그룹)
--  같은 (회사,제목,시작,종료) 회차를 하나의 program_id 로 통합 + assignments 보정.
-- ============================================================================
do $$
begin
  create temp table _pmap on commit drop as
  select s.program_id as old_pid, gmin.canon
  from public.education_sessions s
  join (
    select client, title, start_time, end_time, min(program_id::text)::uuid as canon
    from public.education_sessions
    group by client, title, start_time, end_time
  ) gmin
    on s.client = gmin.client and s.title = gmin.title
       and s.start_time = gmin.start_time and s.end_time = gmin.end_time
  group by s.program_id, gmin.canon;

  -- 배정 먼저 통합(같은 교육의 회차별 배정 → 교육 단위 하나로)
  update public.assignments a
    set program_id = p.canon
    from _pmap p
    where a.program_id = p.old_pid and a.program_id <> p.canon;

  delete from public.assignments a
    using public.assignments b
    where a.ctid < b.ctid and a.program_id = b.program_id and a.person_email = b.person_email;

  -- 세션(회차) program_id 통합
  update public.education_sessions s
    set program_id = p.canon
    from _pmap p
    where s.program_id = p.old_pid and s.program_id <> p.canon;
end $$;
