-- 005 · A report that is overwritten is kept
--
-- Run once in the Supabase SQL Editor, after 003. It adds one table, one trigger and two
-- functions, and changes nothing that already exists. To undo it:
--   drop trigger if exists trg_report_history on scouting_reports;
--   drop function if exists public._report_history();
--   drop function if exists public.report_versions(uuid, text);
--   drop function if exists public.report_version(uuid, bigint);
--   drop table if exists scouting_reports_history;
--
-- A report is one row, and saving it replaces the row. Until now nothing was kept of what
-- it replaced: a save that wrote less than there was - a rebuild, an undo too far, a page
-- that opened empty - left no way back on the server.
--
-- From here on, whenever a game report is about to be replaced by different content, the
-- row as it was is copied into scouting_reports_history first:
--   * at most one copy every ten minutes while somebody is typing, so an afternoon of
--     autosaves is a handful of copies and not thousands;
--   * always, whatever the clock says, when the new content is much smaller than the old
--     (under 70% of it) - that is the case that matters;
--   * the last 80 copies of each report are kept, and none older than 120 days beyond
--     the newest 10.
-- Only game reports are kept this way; the usage counters and the settings are not.
-- Staff can list the copies of a report and read one back; players cannot.

begin;

create table if not exists scouting_reports_history (
  id         bigserial primary key,
  key        text not null,
  kind       text,
  opponent   text,
  game_date  date,
  data       jsonb,
  html       text,
  saved_by   text,
  saved_at   timestamptz,
  kept_at    timestamptz not null default now(),
  size       integer
);
create index if not exists scouting_reports_history_key on scouting_reports_history(key, kept_at desc);

alter table scouting_reports_history enable row level security;
revoke all on scouting_reports_history from anon, authenticated;

create or replace function public._report_history()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare last_at timestamptz; old_len integer; new_len integer;
begin
  if _key_class(old.key) <> 'report' then return new; end if;
  if old.data is not distinct from new.data and old.html is not distinct from new.html then return new; end if;
  old_len := length(coalesce(old.data::text,'')) + length(coalesce(old.html,''));
  new_len := length(coalesce(new.data::text,'')) + length(coalesce(new.html,''));
  if old_len < 200 then return new; end if;           /* an empty report is not worth a copy */
  select max(kept_at) into last_at from scouting_reports_history where key = old.key;
  if last_at is null or last_at < now() - interval '10 minutes' or new_len < old_len * 0.7 then
    insert into scouting_reports_history(key,kind,opponent,game_date,data,html,saved_by,saved_at,size)
      values(old.key,old.kind,old.opponent,old.game_date,old.data,old.html,old.updated_by,old.updated_at,old_len);
    delete from scouting_reports_history h
      where h.key = old.key
        and h.id not in (select id from scouting_reports_history where key = old.key order by kept_at desc limit 80);
    delete from scouting_reports_history h
      where h.key = old.key and h.kept_at < now() - interval '120 days'
        and h.id not in (select id from scouting_reports_history where key = old.key order by kept_at desc limit 10);
  end if;
  return new;
end; $function$;

drop trigger if exists trg_report_history on scouting_reports;
create trigger trg_report_history
  before update on scouting_reports
  for each row execute function public._report_history();

/* the copies of one report, newest first - staff only, and without the content */
create or replace function public.report_versions(p_token uuid, p_key text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  if a.scope <> 'coach' then return jsonb_build_object('ok',false,'error','Sin permiso'); end if;
  return jsonb_build_object('ok',true,'versions',(select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'saved_by',saved_by,'saved_at',saved_at,'kept_at',kept_at,'size',size) order by kept_at desc),'[]'::jsonb)
    from scouting_reports_history where key = p_key));
end; $function$;

/* one copy, whole - staff only */
create or replace function public.report_version(p_token uuid, p_id bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; r scouting_reports_history;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  if a.scope <> 'coach' then return jsonb_build_object('ok',false,'error','Sin permiso'); end if;
  select * into r from scouting_reports_history where id = p_id;
  if r.id is null then return jsonb_build_object('ok',false,'error','No such copy'); end if;
  return jsonb_build_object('ok',true,'version',jsonb_build_object(
    'id',r.id,'key',r.key,'data',r.data,'html',r.html,'saved_by',r.saved_by,'saved_at',r.saved_at,'kept_at',r.kept_at));
end; $function$;

grant execute on function public.report_versions(uuid, text) to anon, authenticated;
grant execute on function public.report_version(uuid, bigint) to anon, authenticated;

commit;
