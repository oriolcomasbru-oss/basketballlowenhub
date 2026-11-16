-- 007 · The Playbook for the players Oriol picks, one by one
--
-- Run once in the Supabase SQL Editor. It adds one function and, at the end, gives Eddy
-- the Playbook; no table is changed and nothing else is touched. To undo it:
--   drop function if exists public.get_playbook(uuid);
--
-- What was wrong
--   The Playbook lives in the staff document staff:planning (006), which players may never
--   read - rightly, it also holds every Planning session. Oriol wants to open the Playbook
--   to some players (16/11/2026: "dale acceso a playbook a Eddy, déjame poder dar acceso a
--   playbook a los jugadores que quiera").
--
-- The rule now
--   get_playbook(token) hands back ONLY the four playbook lists of staff:planning
--   (offense, defense, ATO's, the playbook video) - never the sessions or the plays of
--   Planning - to:
--     staff (coach scope), always;
--     a player whose name is in settings:playerview -> people -> <name> with "playbook",
--     which Oriol ticks in Permissions & users (Players · the Playbook, one by one).
--   Anyone else gets "Sin permiso". Nothing can be written through it.

begin;

create or replace function public.get_playbook(p_token uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; r scouting_reports; pv jsonb; ok boolean;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  if a.scope = 'coach' then
    ok := true;
  else
    select data into pv from scouting_reports where key='settings:playerview';
    ok := jsonb_typeof(pv->'people'->a.username) = 'array'
          and (pv->'people'->a.username) ? 'playbook';
  end if;
  if not coalesce(ok,false) then return jsonb_build_object('ok',false,'error','Sin permiso'); end if;

  select * into r from scouting_reports where key='staff:planning';
  if r.key is null then return jsonb_build_object('ok',true,'playbook',null); end if;
  return jsonb_build_object('ok',true,'updated_at',r.updated_at,'playbook',jsonb_build_object(
    'playbookOff',   r.data->'playbookOff',
    'playbookDef',   r.data->'playbookDef',
    'playbookAto',   r.data->'playbookAto',
    'playbookVideo', r.data->'playbookVideo'));
end; $function$;

grant execute on function public.get_playbook(uuid) to anon, authenticated;

-- Eddy gets the Playbook (the player account whose name starts with "Eddy"; Esli is left out)
update scouting_reports s
   set data = jsonb_set(coalesce(s.data,'{}'::jsonb), '{people}',
                coalesce(s.data->'people','{}'::jsonb) || jsonb_build_object(e.username, '["playbook"]'::jsonb))
  from (select username from accounts where scope='player' and username ilike 'eddy%' order by username limit 1) e
 where s.key='settings:playerview';

commit;

-- what the players' view says now: Eddy's name should be in "people" with "playbook"
select data->'people' as people from scouting_reports where key='settings:playerview';
