-- Self-test for 001_report_access.sql. Run it AFTER 001, in the SQL Editor.
--
-- It opens four throw-away sessions (the admin, a coach who edits Pre game, a coach who
-- does not, and a player), tries what each one should and should not be able to do
-- against a document called zztest|access, and then deletes the sessions and the
-- document. Nothing real is read or changed. Every row of the result should say "ok".

create temp table if not exists _selftest(n int, que text, esperado text, obtenido text, resultado text);
truncate _selftest;

do $$
declare
  t_adm uuid; t_ed uuid; t_ro uuid; t_pl uuid;
  u_ed text; u_ro text; u_pl text;
  n int := 0;
  r jsonb;
begin
  select username into u_ed from accounts where scope='coach' and active and username<>'Oriol'
    and coalesce((perms->'edit'->>'pregame')::boolean,false) order by username limit 1;
  select username into u_ro from accounts where scope='coach' and active and username<>'Oriol'
    and not coalesce((perms->'edit'->>'pregame')::boolean,false) order by username limit 1;
  select username into u_pl from accounts where scope='player' and active order by username limit 1;

  insert into sessions(account_id,scope) select id,'coach' from accounts where scope='coach' and username='Oriol' returning token into t_adm;
  insert into sessions(account_id,scope) select id,'coach' from accounts where scope='coach' and username=u_ed returning token into t_ed;
  insert into sessions(account_id,scope) select id,'coach' from accounts where scope='coach' and username=u_ro returning token into t_ro;
  insert into sessions(account_id,scope) select id,'player' from accounts where scope='player' and username=u_pl returning token into t_pl;

  delete from scouting_reports where key='zztest|access';

  -- each line: what is tried, whether it should be allowed, what came back
  r := save_report(t_ro,'zztest|access','pregame','',null,'{}'::jsonb,null);
  n:=n+1; insert into _selftest values(n,'coach sin edición crea un informe pregame','denegado', r->>'ok', '');
  r := save_report(t_pl,'zztest|access','pregame','',null,'{}'::jsonb,null);
  n:=n+1; insert into _selftest values(n,'jugador crea un informe','denegado', r->>'ok', '');
  r := save_report(t_ed,'zztest|access','pregame','',null,'{"a":1}'::jsonb,null);
  n:=n+1; insert into _selftest values(n,'coach con edición crea un informe pregame','permitido', r->>'ok', '');
  r := save_report(t_ed,'zztest|access','settings','',null,'{"a":2}'::jsonb,null);
  n:=n+1; insert into _selftest values(n,'coach cambia el tipo de un informe existente','denegado', r->>'ok', '');
  r := get_report(t_ro,'zztest|access');
  n:=n+1; insert into _selftest values(n,'coach con vista lee el informe','permitido', r->>'ok', '');
  r := get_report(t_pl,'zztest|access');
  n:=n+1; insert into _selftest values(n,'jugador lee un informe sin publicar','denegado', r->>'ok', '');
  r := set_share(t_pl,'zztest|access','published');
  n:=n+1; insert into _selftest values(n,'jugador publica un informe','denegado', r->>'ok', '');
  r := set_share(t_ro,'zztest|access','published');
  n:=n+1; insert into _selftest values(n,'coach sin edición publica un informe','denegado', r->>'ok', '');
  r := set_share(t_ed,'zztest|access','published');
  n:=n+1; insert into _selftest values(n,'coach con edición publica el informe','permitido', r->>'ok', '');
  r := get_report(t_pl,'zztest|access');
  n:=n+1; insert into _selftest values(n,'jugador lee el informe publicado','permitido', r->>'ok', '');

  r := save_report(t_ed,'settings:playerview','pregame','',null,'{"sects":[],"blocks":[]}'::jsonb,null);
  n:=n+1; insert into _selftest values(n,'coach escribe la vista de jugadores','denegado', r->>'ok', '');
  r := save_report(t_pl,'settings:playerview','settings','',null,'{"sects":[],"blocks":[]}'::jsonb,null);
  n:=n+1; insert into _selftest values(n,'jugador escribe la vista de jugadores','denegado', r->>'ok', '');
  r := get_report(t_pl,'settings:playerview');
  n:=n+1; insert into _selftest values(n,'jugador lee la vista de jugadores','permitido', r->>'ok', '');
  r := get_report(t_pl,'usage:Oriol');
  n:=n+1; insert into _selftest values(n,'jugador lee el uso de otra cuenta','denegado', r->>'ok', '');
  r := get_report(t_ro,'usage:Oriol');
  n:=n+1; insert into _selftest values(n,'coach lee el uso de otra cuenta','denegado', r->>'ok', '');
  r := save_report(t_ro,'usage:Oriol','usage','',null,'{}'::jsonb,null);
  n:=n+1; insert into _selftest values(n,'coach escribe el uso de otra cuenta','denegado', r->>'ok', '');
  r := get_report(t_adm,'usage:'||u_pl);
  n:=n+1; insert into _selftest values(n,'admin lee el uso de cualquier cuenta','permitido', r->>'ok', '');
  r := get_report(t_pl,'usage:'||u_pl);
  n:=n+1; insert into _selftest values(n,'jugador lee su propio uso','permitido', r->>'ok', '');
  r := get_report('00000000-0000-0000-0000-000000000000','zztest|access');
  n:=n+1; insert into _selftest values(n,'sin sesión','denegado', r->>'ok', '');

  update _selftest set
    obtenido = case when obtenido='true' then 'permitido' else 'denegado' end;
  update _selftest set resultado = case when esperado=obtenido then 'ok' else 'FALLO' end;

  delete from scouting_reports where key='zztest|access';
  delete from sessions where token in (t_adm,t_ed,t_ro,t_pl);
end $$;

select n, que, esperado, obtenido, resultado from _selftest order by n;
