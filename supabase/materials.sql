-- ============================================================================
-- materials.sql : 멘토 교육자료 업로드/보관 (additive migration)
--  · 공개 범위: 본인(업로더) + 운영팀(admin)만. 멘토끼리는 비공개 — mentor_blocks 와 동일.
--  · 파일은 Storage 버킷 'materials' 에, 메타데이터는 public.materials 테이블에.
--  · program_id(교육)에 선택적으로 연결 (없어도 됨).
--  · 분석(요약·QC 등)은 나중에 summary/qc_result/tags 컬럼에 채움 — 지금은 빈 값.
--  · staff.sql / program.sql 이후 실행. 재실행 안전.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. materials — 자료 메타데이터
-- ----------------------------------------------------------------------------
create table if not exists public.materials (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.mentors(id) on delete cascade,
  program_id  uuid,                                       -- 연결 교육(선택). education_sessions.program_id 와 같은 값
  title       text not null default '',
  description text not null default '',
  file_path   text not null,                              -- Storage 버킷 내 경로: {owner_id}/{uuid}_{파일명}
  file_name   text not null default '',                   -- 원본 파일명(표시용)
  file_type   text not null default '',                   -- MIME 타입
  file_size   bigint not null default 0,
  summary     text not null default '',                   -- (분석용) 자동 요약
  qc_result   jsonb,                                       -- (분석용) QC 점검 결과
  tags        text[] not null default '{}',                -- (분석용) 자동 태그
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists materials_owner_idx   on public.materials (owner_id);
create index if not exists materials_program_idx on public.materials (program_id);

comment on table public.materials is '멘토 교육자료. 본인+운영팀만 열람(RLS). 파일은 Storage 버킷 materials.';

-- ----------------------------------------------------------------------------
-- 2. RLS — 본인 또는 운영팀
-- ----------------------------------------------------------------------------
alter table public.materials enable row level security;

drop policy if exists "materials_select_own_or_admin" on public.materials;
drop policy if exists "materials_insert_own"          on public.materials;
drop policy if exists "materials_update_own"          on public.materials;
drop policy if exists "materials_delete_own"          on public.materials;
drop policy if exists "materials_admin_all"           on public.materials;

create policy "materials_select_own_or_admin"
  on public.materials for select
  using (owner_id = auth.uid() or public.is_admin());

create policy "materials_insert_own"
  on public.materials for insert
  with check (owner_id = auth.uid());

create policy "materials_update_own"
  on public.materials for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "materials_delete_own"
  on public.materials for delete
  using (owner_id = auth.uid());

-- 운영팀은 전체 관리(열람·수정·삭제)
create policy "materials_admin_all"
  on public.materials for all
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- 3. Storage 버킷 + 정책 (비공개 버킷, 50MB 제한)
--    경로 규칙: '{owner_id}/...' → 첫 폴더명이 곧 소유자 uid.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('materials', 'materials', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "materials_obj_read"   on storage.objects;
drop policy if exists "materials_obj_insert" on storage.objects;
drop policy if exists "materials_obj_update" on storage.objects;
drop policy if exists "materials_obj_delete" on storage.objects;

create policy "materials_obj_read"
  on storage.objects for select
  using (
    bucket_id = 'materials'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

create policy "materials_obj_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'materials'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "materials_obj_update"
  on storage.objects for update
  using (
    bucket_id = 'materials'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "materials_obj_delete"
  on storage.objects for delete
  using (
    bucket_id = 'materials'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );
