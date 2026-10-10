-- Self-test for 003_report_trim.sql. Run it AFTER 003, in the SQL Editor.
--
-- It opens throw-away sessions for a player and two coaches, and reads and writes one
-- document called zztest|trim under different permissions. To do that it changes the two
-- coaches' boxes and the players' view FOR THE LENGTH OF THE TEST and puts them back
-- exactly as they were before it ends; the whole block is one transaction, so nobody
-- else ever sees the values in between, and if anything fails nothing is kept at all.
-- Every row of the result should say "ok".

create temp table if not exists _selftest(n int, que text, esperado text, obtenido text, resultado text);
truncate _selftest;

do $$
declare
  t_adm uuid; t_ed uuid; t_ro uuid; t_pl uuid;
  u_ed text; u_ro text; u_pl text;
  p_ed jsonb; p_ro jsonb; pv_old jsonb; pv_had boolean;
  n int := 0;
  r jsonb; x jsonb;
  doc0 jsonb := '{"sections":["PRE"],"postSections":["POST"],"cards":{"c":1},"roles":{"r":1},"players":["p"],"status":{}}'::jsonb;
begin
  select username, perms into u_ed, p_ed from accounts where scope='coach' and active and username<>'Oriol'
    and coalesce((perms->'edit'->>'pregame')::boolean,false) and coalesce((perms->'edit'->>'postgame')::boolean,false)
    order by username limit 1;
  select username, perms into u_ro, p_ro from accounts where scope='coach' and active and username<>'Oriol'
    and username is distinct from u_ed order by username limit 1;
  select username into u_pl from accounts where scope='player' and active order by username limit 1;
  select data into pv_old from scouting_reports where key='settings:playerview';
  pv_had := found;

  insert into sessions(account_id,scope) select id,'coach' from accounts where scope='coach' and username='Oriol' returning token into t_adm;
  insert into sessions(account_id,scope) select id,'coach' from accounts where scope='coach' and username=u_ed returning token into t_ed;
  insert into sessions(account_id,scope) select id,'coach' from accounts where scope='coach' and username=u_ro returning token into t_ro;
  insert into sessions(account_id,scope) select id,'player' from accounts where scope='player' and username=u_pl returning token into t_pl;

  delete from scouting_reports where key='zztest|trim';
  r := save_report(t_adm,'zztest|trim','pregame','',null,doc0,'SHEET');
  r := set_share(t_adm,'zztest|trim','published');

  -- ---- what a player is handed ----
  r := save_report(t_adm,'settings:playerview','settings','',null,'{"sects":["oppscout"],"blocks":["stats","positions","roles"]}'::jsonb,null);
  x := get_report(t_pl,'zztest|trim')->'report';
  n:=n+1; insert into _selftest values(n,'jugador, vista por defecto: partes recibidas','cards,roles,players,status',
    (select string_agg(k,',' order by array_position(array['sections','postSections','cards','roles','players','status'],k)) from jsonb_object_keys(x->'data') k),'');
  n:=n+1; insert into _selftest values(n,'jugador: hoja del staff (html)','vacía', case when coalesce(x->>'html','')='' then 'vacía' else 'entregada' end,'');

  r := save_report(t_adm,'settings:playerview','settings','',null,'{"sects":["oppscout","teamscout"],"blocks":["written"]}'::jsonb,null);
  x := get_report(t_pl,'zztest|trim')->'report';
  n:=n+1; insert into _selftest values(n,'jugador, con escritas y post game: partes recibidas','sections,postSections,players,status',
    (select string_agg(k,',' order by array_position(array['sections','postSections','cards','roles','players','status'],k)) from jsonb_object_keys(x->'data') k),'');

  -- ---- what a coach is handed ----
  update accounts set perms=jsonb_set(jsonb_set(coalesce(perms,'{}'),'{view,pregame}','true',true),'{view,postgame}','false',true) where scope='coach' and username=u_ro;
  x := get_report(t_ro,'zztest|trim')->'report';
  n:=n+1; insert into _selftest values(n,'coach sin vista de post game: partes recibidas','sections,cards,roles,players,status',
    (select string_agg(k,',' order by array_position(array['sections','postSections','cards','roles','players','status'],k)) from jsonb_object_keys(x->'data') k),'');
  n:=n+1; insert into _selftest values(n,'coach con vista de pre game: hoja del staff','entregada', case when coalesce(x->>'html','')='' then 'vacía' else 'entregada' end,'');

  update accounts set perms=jsonb_set(jsonb_set(coalesce(perms,'{}'),'{view,pregame}','false',true),'{view,postgame}','true',true) where scope='coach' and username=u_ro;
  x := get_report(t_ro,'zztest|trim')->'report';
  n:=n+1; insert into _selftest values(n,'coach sin vista de pre game: partes recibidas','postSections,status',
    (select string_agg(k,',' order by array_position(array['sections','postSections','cards','roles','players','status'],k)) from jsonb_object_keys(x->'data') k),'');
  n:=n+1; insert into _selftest values(n,'coach sin vista de pre game: hoja del staff','vacía', case when coalesce(x->>'html','')='' then 'vacía' else 'entregada' end,'');

  update accounts set perms=jsonb_set(jsonb_set(coalesce(perms,'{}'),'{view,pregame}','false',true),'{view,postgame}','false',true) where scope='coach' and username=u_ro;
  r := get_report(t_ro,'zztest|trim');
  n:=n+1; insert into _selftest values(n,'coach sin ninguna de las dos vistas lee el informe','denegado', case when (r->>'ok')='true' then 'permitido' else 'denegado' end,'');

  -- ---- what a coach may write ----
  r := save_report(t_ed,'zztest|trim','postgame','',null,doc0 || '{"postSections":["POST2"]}'::jsonb,null);
  n:=n+1; insert into _selftest values(n,'coach con ambas ediciones guarda desde post game','permitido', case when (r->>'ok')='true' then 'permitido' else 'denegado' end,'');
  n:=n+1; insert into _selftest values(n,'  y el tipo guardado no cambia','pregame', (select kind from scouting_reports where key='zztest|trim'),'');

  update accounts set perms=jsonb_set(perms,'{edit,postgame}','false',true) where scope='coach' and username=u_ed;
  r := save_report(t_ed,'zztest|trim','postgame','',null,doc0,null);
  n:=n+1; insert into _selftest values(n,'coach sin edición de post game guarda desde post game','denegado', case when (r->>'ok')='true' then 'permitido' else 'denegado' end,'');
  r := save_report(t_ed,'zztest|trim','pregame','',null,'{"sections":["PRE2"],"postSections":["HACK"]}'::jsonb,null);
  select data into x from scouting_reports where key='zztest|trim';
  n:=n+1; insert into _selftest values(n,'  guarda desde pre game: su mitad se escribe','["PRE2"]', (x->'sections')::text,'');
  n:=n+1; insert into _selftest values(n,'  y la mitad de post game queda como estaba','["POST2"]', (x->'postSections')::text,'');

  update accounts set perms=jsonb_set(jsonb_set(perms,'{edit,postgame}','true',true),'{edit,pregame}','false',true) where scope='coach' and username=u_ed;
  r := save_report(t_ed,'zztest|trim','postgame','',null,'{"sections":["HACK"],"postSections":["POST3"]}'::jsonb,'HACKSHEET');
  select data, to_jsonb(html) into x, r from scouting_reports where key='zztest|trim';
  n:=n+1; insert into _selftest values(n,'coach solo de post game guarda: su mitad se escribe','["POST3"]', (x->'postSections')::text,'');
  n:=n+1; insert into _selftest values(n,'  la mitad de pre game queda como estaba','["PRE2"]', (x->'sections')::text,'');
  n:=n+1; insert into _selftest values(n,'  y la hoja del staff queda como estaba','"SHEET"', r::text,'');
  r := set_share(t_ed,'zztest|trim','private');
  n:=n+1; insert into _selftest values(n,'coach sin edición de pre game cambia la publicación','denegado', case when (r->>'ok')='true' then 'permitido' else 'denegado' end,'');

  update _selftest set resultado = case when esperado is not distinct from obtenido then 'ok' else 'FALLO' end;

  -- ---- everything back as it was ----
  update accounts set perms=p_ed where scope='coach' and username=u_ed;
  update accounts set perms=p_ro where scope='coach' and username=u_ro;
  if pv_had then update scouting_reports set data=pv_old where key='settings:playerview';
  else delete from scouting_reports where key='settings:playerview'; end if;
  delete from scouting_reports where key='zztest|trim';
  delete from sessions where token in (t_adm,t_ed,t_ro,t_pl);
end $$;

select n, que, esperado, obtenido, resultado from _selftest order by n;
