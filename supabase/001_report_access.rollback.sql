-- Undo 001_report_access.sql: the five functions exactly as they were on 2026-10-10.

begin;

CREATE OR REPLACE FUNCTION public._can(p_token uuid, p_kind text, p_section text)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce((select (a.perms->p_kind->>p_section)::boolean from _acc_from_token(p_token) a),false);
$function$;

CREATE OR REPLACE FUNCTION public.get_report(p_token uuid, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare a accounts; r scouting_reports;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  select * into r from scouting_reports where key=p_key;
  if r.key is null then return jsonb_build_object('ok',true,'report',null); end if;
  if a.scope='player' and r.share_state<>'published' then return jsonb_build_object('ok',false,'error','Not published'); end if;
  return jsonb_build_object('ok',true,'report',jsonb_build_object(
    'key',r.key,'kind',r.kind,'opponent',r.opponent,'game_date',r.game_date,
    'data',r.data,'html',r.html,'share_state',r.share_state,'updated_by',r.updated_by,'updated_at',r.updated_at));
end; $function$;

CREATE OR REPLACE FUNCTION public.get_reports(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare a accounts;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  if a.scope='player' then
    return jsonb_build_object('ok',true,'reports',(select coalesce(jsonb_agg(jsonb_build_object(
      'key',key,'kind',kind,'opponent',opponent,'game_date',game_date,'share_state',share_state,'updated_at',updated_at) order by game_date),'[]'::jsonb)
      from scouting_reports where share_state='published'));
  end if;
  return jsonb_build_object('ok',true,'reports',(select coalesce(jsonb_agg(jsonb_build_object(
    'key',key,'kind',kind,'opponent',opponent,'game_date',game_date,'share_state',share_state,'updated_at',updated_at) order by game_date),'[]'::jsonb)
    from scouting_reports));
end; $function$;

CREATE OR REPLACE FUNCTION public.save_report(p_token uuid, p_key text, p_kind text, p_opponent text, p_date date, p_data jsonb, p_html text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare a accounts;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  if not _can(p_token,'edit',p_kind) then return jsonb_build_object('ok',false,'error','Sin permiso de edición'); end if;
  insert into scouting_reports(key,kind,opponent,game_date,data,html,updated_by,updated_at)
    values(p_key,p_kind,p_opponent,p_date,coalesce(p_data,'{}'::jsonb),coalesce(p_html,''),a.username,now())
  on conflict (key) do update set
    kind=excluded.kind,
    opponent=coalesce(p_opponent, scouting_reports.opponent),
    game_date=coalesce(p_date, scouting_reports.game_date),
    data=coalesce(p_data, scouting_reports.data),
    html=coalesce(p_html, scouting_reports.html),
    updated_by=a.username, updated_at=now();
  return jsonb_build_object('ok',true,'updated_at',now());
end; $function$;

CREATE OR REPLACE FUNCTION public.set_share(p_token uuid, p_key text, p_state text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare a accounts; r scouting_reports;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  select * into r from scouting_reports where key=p_key;
  if r.key is null then return jsonb_build_object('ok',false,'error','No existe'); end if;
  if not _can(p_token,'edit',r.kind) then return jsonb_build_object('ok',false,'error','Sin permiso'); end if;
  if p_state not in ('private','hidden','published') then return jsonb_build_object('ok',false,'error','Estado inválido'); end if;
  update scouting_reports set share_state=p_state, updated_at=now() where key=p_key;
  return jsonb_build_object('ok',true);
end; $function$;

drop function if exists public._key_class(text);

commit;
