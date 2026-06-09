-- ============================================================================
-- restrict.sql : 교육 일정 공개 범위 축소
--  · 기존: 로그인한 모든 멘토가 전체 교육 일정 열람 가능
--  · 변경: 멘토는 "본인이 배정된 교육(program)"의 회차만 열람. 운영팀(admin)은 전체.
--  · program.sql 이후 실행. 재실행 안전.
-- ============================================================================

drop policy if exists "sessions_select_authed" on public.education_sessions;
drop policy if exists "sessions_select_assigned_or_admin" on public.education_sessions;

create policy "sessions_select_assigned_or_admin"
  on public.education_sessions for select
  using (
    public.is_admin()
    or program_id in (
      select a.program_id
      from public.assignments a
      where a.person_email = (auth.jwt() ->> 'email')
    )
  );

-- 쓰기(생성/수정/삭제)는 그대로 운영팀 전용 (sessions_admin_write 유지)
