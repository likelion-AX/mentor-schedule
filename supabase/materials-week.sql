-- ============================================================================
-- materials-week.sql : 교육자료에 '주차/회차' 구분 추가 (additive migration)
--  · week_no: NULL = 교육 전체(공통자료), 1+ = N주차(회차 순번).
--  · program_id 와 함께 (교육, 주차) 단위로 식별 → 외부 에이전트 추출/정리용.
--  · materials.sql 이후 실행. 재실행 안전.
-- ============================================================================

alter table public.materials add column if not exists week_no int;
comment on column public.materials.week_no is '주차/회차 순번(1-based). NULL=교육 전체 공통자료. program_id와 함께 식별.';

create index if not exists materials_program_week_idx on public.materials (program_id, week_no);
