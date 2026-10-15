-- 006 · Documents every member of staff may write: the video staff's ticks, the S&C note
--
-- Run once in the Supabase SQL Editor. It adds one function and changes one rule; no
-- table and no row is touched. To undo it:
--   drop function if exists public.save_staff_doc(uuid, text, jsonb);
--   and run the _key_class definition of 001_report_access.sql again.
--
-- What was wrong
--   The video staff's ticks (what is cut, analysed and on MEGA) and the S&C note of the
--   physical coach were stored like reports, and a report may only be written by a coach
--   with "edit" on pre game or post game. Joan Marc, Marc and Pedro have neither, so
--   every tick and every note of theirs was refused and the screen went on saying "late".
--
-- The rule now
--   staff:<anything>   read: staff (coach scope)     write: staff (coach scope)
--   Players never read or write them. Everything else is as before.

begin;

create or replace function public._key_class(p_key text)
 returns text
 language sql
 immutable
as $function$
  select case
    when p_key = 'settings:playerview' then 'playerview'
    when p_key like 'settings:%' then 'settings'
    when p_key like 'staff:%' then 'settings'
    when p_key like 'usage:%' then 'usage'
    when p_key like 'roles:club:%' or p_key like 'keysets:club:%' then 'club'
    else 'report' end;
$function$;

create or replace function public.save_staff_doc(p_token uuid, p_key text, p_data jsonb)
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
  if p_key not like 'staff:%' or length(p_key) > 120 then
    return jsonb_build_object('ok',false,'error','Clave no válida');
  end if;
  insert into scouting_reports(key,kind,opponent,game_date,data,html,updated_by,updated_at)
    values(p_key,'settings','',null,coalesce(p_data,'{}'::jsonb),'',a.username,now())
  on conflict (key) do update set
    kind='settings', data=coalesce(p_data, scouting_reports.data),
    updated_by=a.username, updated_at=now();
  return jsonb_build_object('ok',true,'updated_at',now());
end; $function$;

grant execute on function public.save_staff_doc(uuid, text, jsonb) to anon, authenticated;

commit;
