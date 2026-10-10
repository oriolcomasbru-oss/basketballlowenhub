-- 002 · Sign-in hardening
--
-- Run once in the Supabase SQL Editor, AFTER the site has deployed the matching version
-- of index.html (the one that makes up a starting password per account). It only
-- replaces functions. To undo it, run 002_login_hardening.rollback.sql.
--
-- What was wrong
--   * login could be tried without limit, and the names are on the cover.
--   * a new or reset account fell back to the password 'Lowen2026', which is written in
--     the site's own source.
--   * a password could be four characters long.
--
-- What changes
--   * login: after 8 wrong passwords for one account in 15 minutes, that account is
--     refused for the rest of the 15 minutes, right password or not. Sessions already
--     open are not affected.
--   * admin_add_account / admin_reset_password: the starting password must be given,
--     must be 8 characters or more and may not be 'Lowen2026'. A reset also closes the
--     sessions that account had open.
--   * admin_add_account says whether it really created the account ('created').
--   * change_password: 8 characters or more, and not 'Lowen2026'.
--   * admin_remove_account closes the sessions of the account it deactivates.

begin;

create or replace function public.login(p_scope text, p_username text, p_password text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts; t uuid; fails int;
begin
  select count(*) into fails from session_log
   where scope=p_scope and username=coalesce(p_username,'?')||' (FAIL)'
     and ts > now() - interval '15 minutes';
  if fails >= 8 then
    return jsonb_build_object('ok',false,'error','Demasiados intentos. Espera 15 minutos.');
  end if;

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

create or replace function public.admin_add_account(p_token uuid, p_scope text, p_username text, p_role text, p_temp text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare n int;
begin
  if not _is_admin(p_token) then return jsonb_build_object('ok',false,'error','Not admin'); end if;
  if p_scope not in ('coach','player') then return jsonb_build_object('ok',false,'error','Bad scope'); end if;
  if length(trim(coalesce(p_username,''))) = 0 then return jsonb_build_object('ok',false,'error','Username required'); end if;
  if length(coalesce(p_temp,'')) < 8 or p_temp = 'Lowen2026' then
    return jsonb_build_object('ok',false,'error','Starting password: 8 characters or more');
  end if;
  insert into accounts(scope,username,role,pass_hash,must_change,perms)
    values(p_scope,p_username,coalesce(p_role,'member'),crypt(p_temp,gen_salt('bf')),true,'{}'::jsonb)
    on conflict (scope,username) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok',true,'created',n > 0);
end; $function$;

create or replace function public.admin_reset_password(p_token uuid, p_username text, p_temp text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _is_admin(p_token) then return jsonb_build_object('ok',false,'error','Not admin'); end if;
  if length(coalesce(p_temp,'')) < 8 or p_temp = 'Lowen2026' then
    return jsonb_build_object('ok',false,'error','Temporary password: 8 characters or more');
  end if;
  update accounts set pass_hash=crypt(p_temp, gen_salt('bf')), must_change=true
   where username=p_username;
  /* whoever was signed in with the old password is signed out - except the admin's own
     session, so resetting your own password does not close the panel you are in */
  delete from sessions
   where account_id in (select id from accounts where username=p_username)
     and token <> p_token;
  return jsonb_build_object('ok',true);
end; $function$;

create or replace function public.admin_remove_account(p_token uuid, p_scope text, p_username text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _is_admin(p_token) then return jsonb_build_object('ok',false,'error','Not admin'); end if;
  if p_username='Oriol' then return jsonb_build_object('ok',false,'error','Cannot remove Oriol'); end if;
  update accounts set active=false where scope=p_scope and username=p_username;
  delete from sessions
   where account_id in (select id from accounts where scope=p_scope and username=p_username);
  return jsonb_build_object('ok',true);
end; $function$;

create or replace function public.change_password(p_token uuid, p_new text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a accounts;
begin
  select * into a from _acc_from_token(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','No session'); end if;
  if length(coalesce(p_new,'')) < 8 then return jsonb_build_object('ok',false,'error','Min 8 chars'); end if;
  if p_new = 'Lowen2026' then return jsonb_build_object('ok',false,'error','Choose a different password'); end if;
  update accounts set pass_hash=crypt(p_new, gen_salt('bf')), must_change=false where id=a.id;
  return jsonb_build_object('ok',true);
end; $function$;

commit;

-- Which accounts are still on the old shared password. Each of these is open to anyone
-- who knows a name from the cover; give them a new starting password with "Reset pass".
select scope, username, must_change, last_login
from accounts
where active and pass_hash = crypt('Lowen2026', pass_hash)
order by scope, username;
