-- One-time catch-up patch: every table in this project was missing its base
-- GRANT for the anon/authenticated Postgres roles (confirmed live via the
-- REST API — 42501 "permission denied for table X", with Postgres's own hint
-- literally suggesting the missing GRANT). RLS policies only restrict *which
-- rows* a role can touch; without this separate, coarser grant, a role can't
-- query the table at all regardless of what its policies say. Tables created
-- via Supabase's Table Editor UI get this automatically; tables created by
-- pasting raw SQL into the SQL editor (how every table in this project was
-- made) do not.
--
-- Safe to run anytime, safe to re-run: GRANT is idempotent, and this only
-- adds privileges — it doesn't touch existing tables, policies, or data.
-- schema.sql/swipe_market_schema.sql now include these same grants inline
-- (right after each table's policies) so a *fresh* setup won't hit this gap,
-- but re-running either of those files here would error on "policy already
-- exists" since your tables already exist. This patch is the fix for that.

grant select, insert, delete on public.meal_logs to authenticated;
grant select, insert, update on public.meal_plans to authenticated;
grant select, insert, update, delete on public.spending_goals to authenticated;
grant select, insert, update, delete on public.roarie_chats to authenticated;
grant select on public.daily_menus to anon, authenticated;
grant select, insert, update, delete on public.swipe_listings to authenticated;
grant select on public.swipe_matches to authenticated;
grant select, insert, update on public.swipe_messages to authenticated;
