-- ============================================================================
-- calendar-import-cron.sql : 구글 캘린더 가져오기 "자동 주기 실행"(선택)
--  · 3시간마다 sync-google-calendars 함수를 호출해 모든 연결을 동기화.
--  · 이걸 안 돌려도 멘토 화면의 "지금 동기화" 버튼으로는 즉시 동작함.
--    (자동으로 알아서 갱신되게 하려면 이 cron 을 설정)
--
--  ★ 먼저 할 일 ★
--   1) Edge Functions → Secrets 에 SYNC_SECRET 이름으로 아무 긴 무작위 문자열 저장
--   2) 아래 'PUT_YOUR_SYNC_SECRET_HERE' 를 그 값과 똑같이 바꿔서 실행
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 기존 같은 이름 작업이 있으면 제거(재실행 안전)
do $$
begin
  perform cron.unschedule('sync-google-calendars');
exception when others then null;
end $$;

-- 3시간마다 실행 ('0 */3 * * *')
select cron.schedule(
  'sync-google-calendars',
  '0 */3 * * *',
  $$
    select net.http_post(
      url := 'https://uwuvrvwgylkirwuwzoux.supabase.co/functions/v1/sync-google-calendars',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', 'PUT_YOUR_SYNC_SECRET_HERE'
      ),
      body := '{}'::jsonb
    );
  $$
);

-- 확인: select * from cron.job;
-- 해제하려면: select cron.unschedule('sync-google-calendars');
