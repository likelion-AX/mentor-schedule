-- ============================================================================
-- program.sql : 배정을 "날짜(세션)" → "교육(프로그램)" 단위로 변경
--  · education_sessions 를 program_id 로 묶음(같은 교육의 여러 회차 = 같은 program_id)
--  · assignments 를 session_id → program_id 기준으로 이전
--  · 기존 데이터: (회사·제목·시작·종료) 같은 세션끼리 한 교육으로 묶어 backfill
--  · staff.sql 이후 실행. 재실행 안전.
-- ============================================================================

-- 1) education_sessions.program_id
alter table public.education_sessions add column if not exists program_id uuid;

-- 같은 (회사,제목,시작,종료) 세션을 한 교육으로 묶기
-- 주의: gen_random_uuid() 를 UPDATE SET 에 직접 쓰면 "행마다" 평가돼 그룹이 쪼개진다.
--       그룹마다 uuid 를 변수에 먼저 담아 적용해야 함.
do $$
declare r record; newid uuid;
begin
  for r in
    select client, title, start_time, end_time
    from public.education_sessions
    where program_id is null
    group by client, title, start_time, end_time
  loop
    newid := gen_random_uuid();
    update public.education_sessions
      set program_id = newid
      where program_id is null
        and client = r.client and title = r.title
        and start_time = r.start_time and end_time = r.end_time;
  end loop;
end $$;

update public.education_sessions set program_id = gen_random_uuid() where program_id is null;
alter table public.education_sessions alter column program_id set not null;
create index if not exists sessions_program_idx on public.education_sessions (program_id);

-- 2) assignments: session_id → program_id
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assignments' and column_name = 'session_id'
  ) then
    alter table public.assignments add column if not exists program_id uuid;

    update public.assignments a
      set program_id = s.program_id
      from public.education_sessions s
      where s.id = a.session_id and a.program_id is null;

    -- 같은 교육에 같은 사람이 (날짜별로) 여러 번 배정돼 있던 것 → 하나로 합침
    delete from public.assignments a
      using public.assignments b
      where a.ctid < b.ctid
        and a.program_id = b.program_id
        and a.person_email = b.person_email;

    -- session_id 와 그에 딸린 제약/인덱스 제거
    alter table public.assignments drop column session_id cascade;
    alter table public.assignments alter column program_id set not null;
    alter table public.assignments
      add constraint assignments_program_person_key unique (program_id, person_email);
  end if;
end $$;

create index if not exists assignments_program_idx on public.assignments (program_id);

-- RLS 정책은 person_email / is_admin 기반이라 컬럼 변경과 무관 (그대로 유효)
