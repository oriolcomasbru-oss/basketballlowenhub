-- 008 · The Playbook and Planning are kept, and an old page can no longer write them
--
-- Run once in the Supabase SQL Editor, AFTER the hub with "PLAN_CV" (16/11/2026) is published:
-- from then on the server refuses a copy of staff:planning that does not say it comes from that
-- hub or a newer one. Run before the publish, nobody could save the Playbook or Planning until it.
--
-- Why (Oriol, 16/11/2026: "es posible que hayas borrado parte del playbook, es la segunda vez")
--   The Playbook and the Planning sessions are one staff document, staff:planning, and nothing was
--   kept of what a save replaced: 005 keeps the game reports only. A page left open for days runs
--   the code it was opened with, and an old merge can write an older Playbook over the new one.
--
-- What it does
--   * staff:planning is kept like a report: a copy of the document as it was before a save, at
--     most one every ten minutes - and always when a save takes something off the Playbook (the
--     offense, the defense or the plays shorter by more than a few words) or takes a day off
--     Planning, or when the document shrinks under 70%. The last 80 copies are kept. The hub's
--     Playbook › ⟲ Copies lists them and brings back what is missing.
--   * a save of staff:planning without "cv" 2 or more is refused with "reload": that is every page
--     opened before this hub.
--
-- To undo it:
--   drop trigger if exists trg_staff_planning_guard on scouting_reports;
--   drop function if exists public._staff_planning_guard();
--   and run 005_report_history.sql again (its _report_history keeps the game reports only).

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
declare last_at timestamptz; old_len integer; new_len integer; plan boolean; lost boolean := false;
begin
  plan := old.key = 'staff:planning';
  if _key_class(old.key) <> 'report' and not plan then return new; end if;
  if old.data is not distinct from new.data and old.html is not distinct from new.html then return new; end if;
  old_len := length(coalesce(old.data::text,'')) + length(coalesce(old.html,''));
  new_len := length(coalesce(new.data::text,'')) + length(coalesce(new.html,''));
  if old_len < 200 then return new; end if;           /* an empty report is not worth a copy */
  if plan then
    lost := coalesce(length((old.data->'playbookOff')::text),0) - coalesce(length((new.data->'playbookOff')::text),0) > 40
         or coalesce(length((old.data->'playbookDef')::text),0) - coalesce(length((new.data->'playbookDef')::text),0) > 40
         or coalesce(length((old.data->'plays')::text),0) - coalesce(length((new.data->'plays')::text),0) > 40
         or (select count(*) from jsonb_object_keys(case when jsonb_typeof(old.data->'sessions')='object' then old.data->'sessions' else '{}'::jsonb end))
          > (select count(*) from jsonb_object_keys(case when jsonb_typeof(new.data->'sessions')='object' then new.data->'sessions' else '{}'::jsonb end));
  end if;
  select max(kept_at) into last_at from scouting_reports_history where key = old.key;
  if last_at is null or last_at < now() - interval '10 minutes' or new_len < old_len * 0.7 or lost then
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

/* a copy of staff:planning from a page older than this hub is refused */
create or replace function public._staff_planning_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.key = 'staff:planning'
     and coalesce(case when (new.data->>'cv') ~ '^[0-9]+$' then (new.data->>'cv')::int end, 0) < 2 then
    raise exception 'This page of the hub is out of date: reload it to save the Playbook or Planning';
  end if;
  return new;
end; $function$;

drop trigger if exists trg_staff_planning_guard on scouting_reports;
create trigger trg_staff_planning_guard
  before insert or update on scouting_reports
  for each row execute function public._staff_planning_guard();

/* the copies of one document, newest first - staff only, and without the content (as in 005) */
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

/* one copy, whole - staff only (as in 005) */
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
