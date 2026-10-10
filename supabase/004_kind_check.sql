-- 004 · Let the table hold the documents that are not reports
--
-- Run once in the Supabase SQL Editor. It changes one rule on scouting_reports and
-- touches no row. To undo it (only possible while no 'settings' or 'usage' row exists):
--   alter table public.scouting_reports drop constraint scouting_reports_kind_check;
--   alter table public.scouting_reports add constraint scouting_reports_kind_check
--     check (kind = any (array['pregame'::text, 'postgame'::text]));
--
-- The table only accepted the kinds 'pregame' and 'postgame'. The app also stores three
-- other things in it - the players' view (settings:playerview), the clubs' roles boards
-- and key sets (roles:club:*, keysets:club:*) and the usage summary (usage:<name>) - with
-- the kinds 'settings' and 'usage'. Every one of those writes was refused by this rule,
-- so none of them has ever been saved, whatever the functions allowed.

begin;

alter table public.scouting_reports drop constraint scouting_reports_kind_check;
alter table public.scouting_reports add constraint scouting_reports_kind_check
  check (kind = any (array['pregame'::text, 'postgame'::text, 'settings'::text, 'usage'::text]));

commit;
