-- ============================================================================
-- done.sql : 회차별 "수행 완료 표시 + 특이사항" 추가
--  · education_sessions(회차)에 done(완료 여부), note(특이사항) 컬럼 추가.
--  · 기록/수정은 운영팀만 (기존 sessions_admin_write 정책이 그대로 적용).
--  · 멘토는 읽기만 (기존 sessions_select_authed). 별도 정책 변경 불필요.
--  · 재실행 안전.
-- ============================================================================

alter table public.education_sessions
  add column if not exists done boolean not null default false;

alter table public.education_sessions
  add column if not exists note text not null default '';

comment on column public.education_sessions.done is '회차 수행 완료 여부 (운영팀이 교육 진행 후 체크)';
comment on column public.education_sessions.note is '회차 특이사항 (운영팀 기록: 결석·지연·이슈 등)';
