-- 009 · The pre game for the players Oriol picks as soon as the staff mark it finished
--
-- Run once in the Supabase SQL Editor, AFTER the hub of 18/11/2026 is published (an older page
-- that saves the players' view would drop the new tick). It replaces get_report and get_reports
-- as 003 left them, with one rule added, and at the end ticks Ferdi. To undo it, run
-- 003_report_trim.sql again.
--
-- What Oriol asked (18/11/2026)
--   "De manera automática ábrele el scouting a Ferdi (Ferdinand Zylka): solamente lo que les
--   abrimos a los jugadores. Cuando pongo en verde el scouting para el staff, como que está hecho.
--   Solamente para él. Al resto lo activaré con el botón normal de los jugadores."
--
-- The rule now
--   A player reads a game report when it is Published (as before), or - only he - when:
--     * his name is in settings:playerview -> people -> <name> with "scoutready"
--       (Permissions & users > Players > "Pre game when finished · one by one"), and
--     * the pre game of that report is marked finished by the staff (data.status.pre.done).
--   Either way he is handed only the parts every player is given (003's trim): the staff's
--   scouting sheet never, the written sections, the cards and the roles as ticked for players.

begin;

create or replace function public.get_report(p_token uuid, p_key text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; r scouting_reports; cls text; adm boolean; staff boolean;
        d jsonb; v_html text; pv jsonb; sects jsonb; blocks jsonb; early boolean;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  staff := (a.scope = 'coach');
  adm   := (staff and a.username = 'Oriol');
  cls   := _key_class(p_key);

  if not adm then
    if cls = 'usage' and p_key <> 'usage:' || a.username then
      return jsonb_build_object('ok',false,'error','Sin permiso');
    end if;
    if cls = 'settings' and not staff then
      return jsonb_build_object('ok',false,'error','Sin permiso');
    end if;
  end if;

  select * into r from scouting_reports where key=p_key;
  if r.key is null then return jsonb_build_object('ok',true,'report',null); end if;

  d := coalesce(r.data,'{}'::jsonb);
  v_html := r.html;

  /* a coach is handed the whole record; only a player's copy is cut down */
  if cls = 'report' and not staff then
    select data into pv from scouting_reports where key='settings:playerview';
    if r.share_state <> 'published' then
      /* the pre game as soon as it is finished, for the players ticked one by one */
      early := coalesce(d->'status'->'pre'->>'done','') = 'true'
               and jsonb_typeof(pv->'people'->a.username) = 'array'
               and (pv->'people'->a.username) ? 'scoutready';
      if not coalesce(early,false) then
        return jsonb_build_object('ok',false,'error','Not published');
      end if;
    end if;
    sects  := case when jsonb_typeof(pv->'sects')  = 'array' then pv->'sects'  else '["oppscout"]'::jsonb end;
    blocks := case when jsonb_typeof(pv->'blocks') = 'array' then pv->'blocks' else '["stats","positions","roles"]'::jsonb end;
    v_html := '';
    if not (sects ? 'oppscout' and blocks ? 'written') then d := d - 'sections'; end if;
    if not (blocks ? 'positions' or blocks ? 'roles')  then d := d - 'cards'; end if;
    if not (blocks ? 'roles')                          then d := d - 'roles'; end if;
    if not (sects ? 'teamscout')                       then d := d - 'postSections'; end if;
  end if;

  return jsonb_build_object('ok',true,'report',jsonb_build_object(
    'key',r.key,'kind',r.kind,'opponent',r.opponent,'game_date',r.game_date,
    'data',d,'html',v_html,'share_state',r.share_state,'updated_by',r.updated_by,'updated_at',r.updated_at));
end; $function$;

create or replace function public.get_reports(p_token uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; adm boolean; staff boolean; early boolean; pv jsonb;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  staff := (a.scope = 'coach');
  adm   := (staff and a.username = 'Oriol');
  early := false;
  if not staff then
    select data into pv from scouting_reports where key='settings:playerview';
    early := coalesce(jsonb_typeof(pv->'people'->a.username) = 'array'
                      and (pv->'people'->a.username) ? 'scoutready', false);
  end if;
  return jsonb_build_object('ok',true,'reports',(select coalesce(jsonb_agg(jsonb_build_object(
    'key',key,'kind',kind,'opponent',opponent,'game_date',game_date,'share_state',share_state,'updated_at',updated_at) order by game_date),'[]'::jsonb)
    from scouting_reports
    where adm
       or (_key_class(key) = 'report'
           and (staff or share_state = 'published'
                or (early and coalesce(data->'status'->'pre'->>'done','') = 'true')))));
end; $function$;

grant execute on function public.get_report(uuid, text) to anon, authenticated;
grant execute on function public.get_reports(uuid) to anon, authenticated;

-- Ferdi gets the pre game as soon as it is finished (the player account whose name starts with
-- "Ferdi"); what he already had - the Playbook, if ever ticked - is kept
update scouting_reports s
   set data = jsonb_set(coalesce(s.data,'{}'::jsonb), '{people}',
                coalesce(s.data->'people','{}'::jsonb) || jsonb_build_object(f.username,
                  (case when jsonb_typeof(s.data->'people'->f.username) = 'array'
                        then s.data->'people'->f.username else '[]'::jsonb end) || '["scoutready"]'::jsonb))
  from (select username from accounts where scope='player' and username ilike 'ferdi%' order by username limit 1) f
 where s.key='settings:playerview'
   and not coalesce((s.data->'people'->f.username) ? 'scoutready', false);

commit;

-- what the players' view says now: Ferdi's name should be in "people" with "scoutready"
select data->'people' as people from scouting_reports where key='settings:playerview';
