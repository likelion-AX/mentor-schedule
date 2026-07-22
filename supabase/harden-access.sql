-- ============================================================================
-- harden-access.sql : 가입 차단 + 멘토 명부 열람 제한 (보안 보강)
--  [1] 가입 트리거: 이름매칭(case 1·2)은 그대로 두고, 모르는 사람을 신규로
--      받아주던 case 3 을 "거부"로 변경 → 명단(invites)에 없는 외부인은 가입 불가.
--  [2] mentors SELECT 정책 축소: 로그인했다고 전체 명부를 읽던 것을
--      "본인 + 운영팀(admin)"으로 제한 → 멘토는 자기 행만, 명부/이메일은 admin만.
--
--  ★ 반드시 match.sql 등 다른 트리거 정의 파일들보다 "나중에" 실행하세요.
--    (가장 마지막에 적용된 정의가 최종 동작) — 재실행 안전.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- [1] 가입 트리거 — 명단 외 차단 + 이름매칭 유지
--     · case 1: 이메일이 명단에 있으면 그걸로 연결
--     · case 2: 이름으로 미가입 명단 매칭(띄어쓰기·대소문자 무시)
--     · case 3: 매칭 없음 → 가입 거부 (raise) — 기존엔 신규로 받아줬음
-- ----------------------------------------------------------------------------
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

  -- (3) 매칭 없음 → 가입 거부 (외부인 차단)
  --     운영팀이 명단(명부 관리)에 이름 또는 이메일을 먼저 등록해야 가입 가능.
  raise exception '초대되지 않은 사용자입니다. 운영팀에 이름 등록을 요청하세요.';
end; $func$;

-- 트리거 재바인딩(존재하면 교체) — 함수만 바꿔도 되지만 자체완결성 위해 포함
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- [2] mentors 명부 열람 제한 — 본인 + 운영팀(admin)만
--     · 기존 "mentors_select_all"(auth.uid() is not null = 로그인 전체)을 대체.
--     · 프론트 영향 없음: 멘토는 본인 프로필만 조회(auth.js), 전체 조회는 admin 화면뿐.
--     · is_admin() 은 security definer 라 이 정책과 무관하게 동작(락아웃 없음).
-- ----------------------------------------------------------------------------
drop policy if exists "mentors_select_all"            on public.mentors;
drop policy if exists "mentors_select_self_or_admin"  on public.mentors;

create policy "mentors_select_self_or_admin"
  on public.mentors for select
  using (id = auth.uid() or public.is_admin());

-- (참고) mentors_update_self / mentors_admin_all 정책은 그대로 유지됩니다.
