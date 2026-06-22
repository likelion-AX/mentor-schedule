-- ============================================================================
-- calendar-import.sql : 구글 캘린더 → 앱 (개인 약속을 '불가 시간'으로 자동 가져오기)
--  [보안 최우선 설계]
--   · 멘토의 구글 "비공개 주소(iCal)"는 전용 테이블에 보관 + 본인만 접근(RLS).
--     → 다른 멘토는 물론 운영팀(admin)도 이 주소를 못 읽음. 동기화는 service_role 만.
--   · 가져온 일정은 mentor_blocks 에 source='google' 로 저장하되 memo(제목)는 항상 빈값.
--     → 제목은 DB에 저장조차 안 됨(엣지 함수가 받기 전에 제거). 운영팀엔 시간만 보임.
--  Supabase SQL Editor 에 통째로 붙여넣어 실행. 재실행 안전.
-- ============================================================================

-- 1) 멘토별 구글 캘린더 연결 (비공개 iCal 주소 보관) — 본인만 접근
create table if not exists public.mentor_calendar_links (
  mentor_id      uuid primary key references public.mentors(id) on delete cascade,
  ical_url       text not null,
  enabled        boolean not null default true,
  last_synced_at timestamptz,
  last_status    text,
  last_count     int,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.mentor_calendar_links enable row level security;

-- 본인 행만 열람/생성/수정/삭제. (admin 정책 없음 = 운영팀도 주소 못 봄)
drop policy if exists "links_all_own" on public.mentor_calendar_links;
create policy "links_all_own"
  on public.mentor_calendar_links for all
  using (mentor_id = auth.uid())
  with check (mentor_id = auth.uid());

-- 2) mentor_blocks 출처 구분 (manual=직접입력 / google=구글에서 가져옴)
alter table public.mentor_blocks add column if not exists source text not null default 'manual';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mentor_blocks_source_chk'
  ) then
    alter table public.mentor_blocks
      add constraint mentor_blocks_source_chk check (source in ('manual', 'google'));
  end if;
end $$;

create index if not exists mentor_blocks_source_idx on public.mentor_blocks (mentor_id, source);

comment on column public.mentor_blocks.source is
  'manual=멘토 직접입력, google=구글 캘린더 동기화(제목 미저장, 시간만)';
