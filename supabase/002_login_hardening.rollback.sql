-- Undo 002_login_hardening.sql: the five functions exactly as they were on 2026-10-10.

begin;

CREATE OR REPLACE FUNCTION public.login(p_scope text, p_username text, p_password text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare a accounts; t uuid;
begin
  select * into a from accounts
   where scope=p_scope and username=p_username and active=true limit 1;
  if a.id is null or a.pass_hash <> crypt(p_password, a.pass_hash) then
    insert into session_log(scope,username,ts) values(p_scope, coalesce(p_username,'?')||' (FAIL)', now());
    return jsonb_build_object('ok',false,'error','Usuario o contraseña incorrectos');
  end if;
  update accounts set last_login=now() where id=a.id;
  insert into sessions(account_id,scope) values(a.id,p_scope) returning token into t;
  insert into session_log(scope,username) values(p_scope,p_username);
  return jsonb_build_object('ok',true,'token',t,'username',a.username,'role',a.role,
    'scope',a.scope,'perms',a.perms,'must_change',a.must_change);
end; $function$;

CREATE OR REPLACE FUNCTION public.admin_add_account(p_token uuid, p_scope text, p_username text, p_role text, p_temp text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not _is_admin(p_token) then return jsonb_build_object('ok',false,'error','Not admin'); end if;
  insert into accounts(scope,username,role,pass_hash,must_change,perms)
    values(p_scope,p_username,coalesce(p_role,'member'),crypt(coalesce(p_temp,'Lowen2026'),gen_salt('bf')),true,'{}'::jsonb)
    on conflict (scope,username) do nothing;
  return jsonb_build_object('ok',true);
end; $function$;

CREATE OR REPLACE FUNCTION public.admin_reset_password(p_token uuid, p_username text, p_temp text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not _is_admin(p_token) then return jsonb_build_object('ok',false,'error','Not admin'); end if;
  update accounts set pass_hash=crypt(coalesce(p_temp,'Lowen2026'), gen_salt('bf')), must_change=true
   where username=p_username;
  return jsonb_build_object('ok',true);
end; $function$;

CREATE OR REPLACE FUNCTION public.admin_remove_account(p_token uuid, p_scope text, p_username text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not _is_admin(p_token) then return jsonb_build_object('ok',false,'error','Not admin'); end if;
  if p_username='Oriol' then return jsonb_build_object('ok',false,'error','Cannot remove Oriol'); end if;
  update accounts set active=false where scope=p_scope and username=p_username;
  return jsonb_build_object('ok',true);
end; $function$;

CREATE OR REPLACE FUNCTION public.change_password(p_token uuid, p_new text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare a accounts;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  if length(coalesce(p_new,'')) < 4 then return jsonb_build_object('ok',false,'error','Min 4 chars'); end if;
  update accounts set pass_hash=crypt(p_new, gen_salt('bf')), must_change=false where id=a.id;
  return jsonb_build_object('ok',true);
end; $function$;

commit;
