-- ============================================================================
-- materials-link.sql : 교육자료에 '링크(URL)' 유형 추가 (additive migration)
--  · link_url 이 있으면 링크형 자료, file_path 가 있으면 파일형 자료.
--  · 링크형은 파일이 없으므로 file_path 를 NULL 허용으로 변경.
--  · materials.sql 이후 실행. 재실행 안전.
-- ============================================================================

alter table public.materials add column if not exists link_url text;
alter table public.materials alter column file_path drop not null;

comment on column public.materials.link_url is '링크형 자료의 URL. NULL이면 파일형(file_path 사용).';
