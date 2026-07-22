-- ============================================================================
-- remove-calendar-import.sql : 구글 캘린더 "가져오기" 기능 제거
--
--  제거 대상 — 멘토의 구글 개인 약속을 앱의 불가시간으로 끌어오던 기능
--    · 엣지함수 sync-google-calendars, 테이블 mentor_calendar_links,
--      mentor_blocks.source 컬럼, 3시간 주기 cron.
--
--  ⚠️ 남기는 것 — "구독"(앱 → 내 구글 캘린더)은 별개 기능이라 그대로 둡니다.
--     calendar_feeds 테이블, calendar-feed 엣지함수, my_calendar_token() 등은
--     이 파일에서 일절 건드리지 않습니다.
--
--  실행 전 코드 배포가 끝나 있어야 안전합니다(현재 코드는 source 를 읽지 않음).
--  재실행 안전.
-- ============================================================================

-- [1] cron 먼저 해제 ---------------------------------------------------------
-- 이걸 안 하면 3시간마다 삭제된 함수를 계속 호출합니다(404 누적).
-- 정리 도중 동기화가 끼어드는 것도 막아야 하므로 가장 먼저 실행.
do $$
begin
  perform cron.unschedule('sync-google-calendars');
exception when others then
  raise notice 'cron job 없음 — 통과';
end $$;

-- 확인: select * from cron.job;

-- [2] 가져온 개인일정은 "지우지 않고" 일반 개인일정으로 남깁니다 -------------
-- 이 행들은 멘토가 실제로 시간이 안 되는 구간입니다. 지우면 앱이 그 시간을
-- '가능'으로 판단해 배정 충돌 경고가 사라지고, 이중 배정으로 이어집니다.
-- source 컬럼만 없애면 자동으로 평범한 개인일정이 되고, 멘토가 화면에서
-- 직접 수정·삭제할 수 있습니다(구글 표시일 때는 삭제 버튼이 없었음).
--
-- 참고 — 몇 건이 해당되는지 먼저 보고 싶다면:
--   select count(*) from public.mentor_blocks where source = 'google';

alter table public.mentor_blocks drop constraint if exists mentor_blocks_source_chk;
drop index if exists public.mentor_blocks_source_idx;
alter table public.mentor_blocks drop column if exists source;

-- [3] 연결 정보 테이블 삭제 --------------------------------------------------
-- ical_url(구글 비공개 주소 = 사실상 비밀번호)이 들어있으므로 남겨둘 이유가 없습니다.
drop table if exists public.mentor_calendar_links;

-- ============================================================================
-- [4] 대시보드에서 따로 해야 하는 것 (SQL로는 안 됨)
--   · Edge Functions → sync-google-calendars → Delete
--   · Edge Functions → Secrets → SYNC_SECRET 삭제
-- ============================================================================

-- 확인용
--   select * from cron.job;                              -- sync-google-calendars 없어야 함
--   select column_name from information_schema.columns
--    where table_name = 'mentor_blocks';                 -- source 없어야 함
--   select to_regclass('public.mentor_calendar_links');  -- null 이어야 함
--   select to_regclass('public.calendar_feeds');         -- ★ 이건 남아 있어야 정상(구독 기능)
