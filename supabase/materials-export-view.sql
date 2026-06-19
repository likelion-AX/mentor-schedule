-- ============================================================================
-- materials-export-view.sql : 외부 에이전트가 읽기 쉽게 정리한 뷰 (읽기 전용)
--  · materials 에 교육명/회차날짜/업로더명을 조인해 한 줄로. file/link 구분(kind) 포함.
--  · security_invoker=on → 기존 RLS 그대로 적용
--      (service_role 키로는 전체, 일반 로그인은 본인 것만 — 안전).
--  · materials-link.sql 이후 실행. 재실행 안전.
-- ============================================================================

create or replace view public.materials_export
with (security_invoker = true) as
select
  m.id,
  m.created_at,
  m.updated_at,
  m.owner_id,
  own.name                                   as uploader_name,   -- 올린 멘토 이름
  m.program_id,
  prog.client                                as program_client,  -- 교육 고객사
  prog.title                                 as program_title,   -- 교육 제목
  m.week_no,
  sess.date                                  as session_date,    -- week_no 회차의 날짜(NULL=공통)
  case when coalesce(m.link_url, '') <> '' then 'link' else 'file' end as kind, -- 'file' | 'link'
  m.title,
  m.description,
  m.file_path,                                                   -- kind=file: Storage 경로
  m.file_name,
  m.file_type,
  m.file_size,
  m.link_url,                                                    -- kind=link: URL
  m.summary,                                                     -- 에이전트가 채울 분석 결과
  m.qc_result,
  m.tags
from public.materials m
left join public.mentors own on own.id = m.owner_id
left join lateral (
  select client, title
  from public.education_sessions
  where program_id = m.program_id
  order by date
  limit 1
) prog on m.program_id is not null
left join lateral (
  select date
  from public.education_sessions
  where program_id = m.program_id
  order by date
  offset greatest(coalesce(m.week_no, 1) - 1, 0)
  limit 1
) sess on m.program_id is not null and m.week_no is not null;

comment on view public.materials_export is '교육자료 + 교육명/회차날짜/업로더 조인 뷰. 외부 에이전트 추출용(읽기 전용, RLS 상속).';
