-- 003 · A report is handed over in parts, and written in parts
--
-- Run once in the Supabase SQL Editor, after 001. It only replaces functions. To undo
-- it, run 001_report_access.sql again (that puts back the functions as 001 left them).
--
-- The pre game, the game plan and the post game of a game are ONE record, under one key,
-- with one share state and one stored kind. 001 treated that record as a single thing:
--
--   * a published report reached a player whole - the written sections, the post-game
--     sections and the staff's scouting sheet included - and it was the browser that
--     left out the parts the admin had unticked;
--   * a coach's "Sees" box was checked against the stored kind, which is whichever
--     screen happened to save the record first, so it could refuse him a record he
--     was meant to read;
--   * saving from the post-game screen a record first saved from the pre-game screen
--     was refused, because the kind did not match.
--
-- What a reader gets now:
--   player   only when published, and then only the parts in settings:playerview
--            (or, with no such document, Pre game with roster positions and roles):
--              written sections   -> block "written" and section "oppscout"
--              positions cards    -> block "positions" or "roles"
--              roles              -> block "roles"
--              post-game sections -> section "teamscout"
--            never the staff scouting sheet (html).
--   staff    everything, always. The "Sees" boxes decide which tabs a coach has in the
--            app; they do not hold a report back from him on the server.
--   admin    everything.
--
-- What a writer may change:
--   the kind sent is the screen being saved from (pregame or postgame) and needs the
--   matching "Edits" box. A coach who cannot edit the other half keeps that half exactly
--   as the server has it, whatever his browser sent. The stored kind of an existing
--   record does not change.

begin;

create or replace function public.get_report(p_token uuid, p_key text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; r scouting_reports; cls text; adm boolean; staff boolean;
        d jsonb; v_html text; pv jsonb; sects jsonb; blocks jsonb;
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
    if r.share_state <> 'published' then
      return jsonb_build_object('ok',false,'error','Not published');
    end if;
    select data into pv from scouting_reports where key='settings:playerview';
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
declare a accounts; adm boolean; staff boolean;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  staff := (a.scope = 'coach');
  adm   := (staff and a.username = 'Oriol');
  return jsonb_build_object('ok',true,'reports',(select coalesce(jsonb_agg(jsonb_build_object(
    'key',key,'kind',kind,'opponent',opponent,'game_date',game_date,'share_state',share_state,'updated_at',updated_at) order by game_date),'[]'::jsonb)
    from scouting_reports
    where adm
       or (_key_class(key) = 'report'
           and (staff or share_state = 'published'))));
end; $function$;

create or replace function public.save_report(p_token uuid, p_key text, p_kind text, p_opponent text, p_date date, p_data jsonb, p_html text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; r scouting_reports; cls text; adm boolean; staff boolean; k text;
        d jsonb; v_html text; epre boolean; epost boolean;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  staff := (a.scope = 'coach');
  adm   := (staff and a.username = 'Oriol');
  cls   := _key_class(p_key);
  select * into r from scouting_reports where key=p_key;

  d := p_data;
  v_html := p_html;
  /* the kind that is stored follows from the key, never from what the browser sent */
  k := case cls when 'usage' then 'usage'
                when 'report' then coalesce(r.kind, p_kind)
                else 'settings' end;

  if adm then
    if cls = 'report' then k := coalesce(r.kind, p_kind, 'pregame'); end if;
  elsif cls = 'usage' then
    if p_key <> 'usage:' || a.username then
      return jsonb_build_object('ok',false,'error','Sin permiso de edición');
    end if;
  elsif not staff then
    return jsonb_build_object('ok',false,'error','Sin permiso de edición');
  elsif cls in ('playerview','settings') then
    return jsonb_build_object('ok',false,'error','Sin permiso de edición');
  elsif cls = 'club' then
    if not coalesce((a.perms->'edit'->>'pregame')::boolean, false) then
      return jsonb_build_object('ok',false,'error','Sin permiso de edición');
    end if;
  else
    if p_kind is null or p_kind not in ('pregame','postgame') then
      return jsonb_build_object('ok',false,'error','Tipo de informe no válido');
    end if;
    epre  := coalesce((a.perms->'edit'->>'pregame')::boolean, false);
    epost := coalesce((a.perms->'edit'->>'postgame')::boolean, false);
    if (p_kind = 'pregame' and not epre) or (p_kind = 'postgame' and not epost) then
      return jsonb_build_object('ok',false,'error','Sin permiso de edición');
    end if;
    if d is not null and not epost then
      d := (d - 'postSections') || case when r.data ? 'postSections'
             then jsonb_build_object('postSections', r.data->'postSections') else '{}'::jsonb end;
    end if;
    if not epre then
      v_html := null;
      if d is not null then
        d := coalesce(r.data,'{}'::jsonb) || case when d ? 'postSections'
               then jsonb_build_object('postSections', d->'postSections') else '{}'::jsonb end;
      end if;
    end if;
  end if;

  insert into scouting_reports(key,kind,opponent,game_date,data,html,updated_by,updated_at)
    values(p_key,k,p_opponent,p_date,coalesce(d,'{}'::jsonb),coalesce(v_html,''),a.username,now())
  on conflict (key) do update set
    kind=excluded.kind,
    opponent=coalesce(p_opponent, scouting_reports.opponent),
    game_date=coalesce(p_date, scouting_reports.game_date),
    data=coalesce(d, scouting_reports.data),
    html=coalesce(v_html, scouting_reports.html),
    updated_by=a.username, updated_at=now();
  return jsonb_build_object('ok',true,'updated_at',now());
end; $function$;

create or replace function public.set_share(p_token uuid, p_key text, p_state text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; r scouting_reports; adm boolean; staff boolean;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  staff := (a.scope = 'coach');
  adm   := (staff and a.username = 'Oriol');
  select * into r from scouting_reports where key=p_key;
  if r.key is null then return jsonb_build_object('ok',false,'error','No existe'); end if;
  if not adm then
    /* only a report is published or hidden, and publishing is showing the pre game to
       the squad, so it goes with the right to edit the pre game */
    if not staff or _key_class(p_key) <> 'report'
       or not coalesce((a.perms->'edit'->>'pregame')::boolean, false) then
      return jsonb_build_object('ok',false,'error','Sin permiso');
    end if;
  end if;
  if p_state not in ('private','hidden','published') then return jsonb_build_object('ok',false,'error','Estado inválido'); end if;
  update scouting_reports set share_state=p_state, updated_at=now() where key=p_key;
  return jsonb_build_object('ok',true);
end; $function$;

commit;
