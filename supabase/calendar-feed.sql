-- ============================================================================
-- calendar-feed.sql : 멘토 구글 캘린더 "자동 동기화 구독" 기반
--  · 멘토마다 비밀 구독 토큰 1개 (calendar_feeds.token)
--  · 이 토큰이 들어간 URL을 구글 캘린더에 "URL로 추가"하면 자동 동기화
--  · 토큰은 본인만 읽음(다른 멘토 일정 못 봄). 엣지 함수(calendar-feed)는
--    service_role 로 토큰→멘토→일정 조회 후 .ics 응답.
--  Supabase SQL Editor 에 통째로 붙여넣어 실행. 재실행 안전.
-- ============================================================================

-- 1) 구독 토큰 테이블 (멘토 1명당 1행)
create table if not exists public.calendar_feeds (
  mentor_id  uuid primary key references public.mentors(id) on delete cascade,
  token      uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create unique index if not exists calendar_feeds_token_idx on public.calendar_feeds (token);

-- 2) RLS : 본인 행만 열람/생성. (토큰이 비밀번호 역할이라 남의 토큰은 절대 못 봐야 함)
alter table public.calendar_feeds enable row level security;

drop policy if exists "feeds_select_own" on public.calendar_feeds;
drop policy if exists "feeds_insert_own" on public.calendar_feeds;
drop policy if exists "feeds_admin_all"  on public.calendar_feeds;

create policy "feeds_select_own"
  on public.calendar_feeds for select
  using (mentor_id = auth.uid());

create policy "feeds_insert_own"
  on public.calendar_feeds for insert
  with check (mentor_id = auth.uid());

create policy "feeds_admin_all"
  on public.calendar_feeds for all
  using (public.is_admin())
  with check (public.is_admin());

-- 3) 내 구독 토큰 가져오기(없으면 자동 발급). 화면에서 rpc('my_calendar_token') 로 호출.
create or replace function public.my_calendar_token()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare t uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select token into t from public.calendar_feeds where mentor_id = auth.uid();
  if t is null then
    insert into public.calendar_feeds (mentor_id) values (auth.uid())
      on conflict (mentor_id) do nothing;
    select token into t from public.calendar_feeds where mentor_id = auth.uid();
  end if;
  return t;
end;
$$;

-- 4) 토큰 재발급(기존 구독 URL 무효화). 화면 "재발급" 버튼에서 호출.
create or replace function public.reset_calendar_token()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare t uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into public.calendar_feeds (mentor_id) values (auth.uid())
    on conflict (mentor_id) do update set token = gen_random_uuid()
    returning token into t;
  return t;
end;
$$;

grant execute on function public.my_calendar_token()    to authenticated;
grant execute on function public.reset_calendar_token() to authenticated;
