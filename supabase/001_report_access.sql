-- 001 · Who may read and write what in scouting_reports
--
-- Run once in the Supabase SQL Editor. It only replaces functions; no table and no row
-- is touched. To undo it, run 001_report_access.rollback.sql.
--
-- What was wrong
--   * get_report told a player from a coach and nothing else: a coach whose "Pre game"
--     box was unticked could still read every pre-game report.
--   * save_report checked the edit right against the kind the BROWSER sent, not the kind
--     of the document being written, so the right to edit one section was the right to
--     overwrite anything, the settings included.
--   * _can had no exception for the admin, and nobody has an "edit settings" or "edit
--     usage" box. So the three things stored as settings/usage - the players' view, the
--     usage summary and the clubs' roles boards - were refused every time and have never
--     reached the server.
--
-- The rule now, decided by the document's KEY:
--   settings:playerview    read: anyone signed in      write: admin
--   settings:<other>       read: staff                 write: admin
--   usage:<name>           read: that account, admin   write: that account
--   roles:club:<id>        read: anyone signed in      write: staff who edit Pre game
--   keysets:club:<id>      (same as roles:club)
--   anything else          a report, kind pregame or postgame
--                          read:  player -> only when published
--                                 staff  -> unless "view <kind>" is explicitly off
--                          write: staff with "edit <kind>", and the kind of an existing
--                                 report cannot be changed
--   The admin (Oriol, coach scope) reads and writes everything.

begin;

create or replace function public._key_class(p_key text)
 returns text
 language sql
 immutable
as $function$
  select case
    when p_key = 'settings:playerview' then 'playerview'
    when p_key like 'settings:%' then 'settings'
    when p_key like 'usage:%' then 'usage'
    when p_key like 'roles:club:%' or p_key like 'keysets:club:%' then 'club'
    else 'report' end;
$function$;

create or replace function public._can(p_token uuid, p_kind text, p_section text)
 returns boolean
 language sql
 security definer
 set search_path to 'public', 'extensions'
as $function$
  select _is_admin(p_token)
      or coalesce((select (a.perms->p_kind->>p_section)::boolean from _acc_from_token(p_token) a),false);
$function$;

create or replace function public.get_report(p_token uuid, p_key text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; r scouting_reports; cls text; adm boolean; staff boolean;
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

  if cls = 'report' and not adm then
    if not staff then
      if r.share_state <> 'published' then
        return jsonb_build_object('ok',false,'error','Not published');
      end if;
    elsif coalesce((a.perms->'view'->>r.kind)::boolean, true) = false then
      return jsonb_build_object('ok',false,'error','Sin permiso');
    end if;
  end if;

  return jsonb_build_object('ok',true,'report',jsonb_build_object(
    'key',r.key,'kind',r.kind,'opponent',r.opponent,'game_date',r.game_date,
    'data',r.data,'html',r.html,'share_state',r.share_state,'updated_by',r.updated_by,'updated_at',r.updated_at));
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
           and case when staff then coalesce((a.perms->'view'->>kind)::boolean, true)
                    else share_state = 'published' end)));
end; $function$;

create or replace function public.save_report(p_token uuid, p_key text, p_kind text, p_opponent text, p_date date, p_data jsonb, p_html text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; r scouting_reports; cls text; adm boolean; staff boolean; k text;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  staff := (a.scope = 'coach');
  adm   := (staff and a.username = 'Oriol');
  cls   := _key_class(p_key);
  select * into r from scouting_reports where key=p_key;

  /* the kind that is stored follows from the key, never from what the browser sent */
  k := case cls when 'usage' then 'usage'
                when 'report' then coalesce(r.kind, p_kind)
                else 'settings' end;

  if adm then
    if cls = 'report' then k := coalesce(p_kind, r.kind); end if;
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
    if k is null or k not in ('pregame','postgame') or p_kind is distinct from k then
      return jsonb_build_object('ok',false,'error','Tipo de informe no válido');
    end if;
    if not coalesce((a.perms->'edit'->>k)::boolean, false) then
      return jsonb_build_object('ok',false,'error','Sin permiso de edición');
    end if;
  end if;

  insert into scouting_reports(key,kind,opponent,game_date,data,html,updated_by,updated_at)
    values(p_key,k,p_opponent,p_date,coalesce(p_data,'{}'::jsonb),coalesce(p_html,''),a.username,now())
  on conflict (key) do update set
    kind=excluded.kind,
    opponent=coalesce(p_opponent, scouting_reports.opponent),
    game_date=coalesce(p_date, scouting_reports.game_date),
    data=coalesce(p_data, scouting_reports.data),
    html=coalesce(p_html, scouting_reports.html),
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
    /* only a report is published or hidden; the other documents follow the key rules */
    if not staff or _key_class(p_key) <> 'report'
       or not coalesce((a.perms->'edit'->>r.kind)::boolean, false) then
      return jsonb_build_object('ok',false,'error','Sin permiso');
    end if;
  end if;
  if p_state not in ('private','hidden','published') then return jsonb_build_object('ok',false,'error','Estado inválido'); end if;
  update scouting_reports set share_state=p_state, updated_at=now() where key=p_key;
  return jsonb_build_object('ok',true);
end; $function$;

commit;
