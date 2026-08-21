-- Incremental patch: adds the curated_restaurants table Roarie's speed fix
-- depends on (see api/chat.js and scripts/scrape-restaurants.js). Run this
-- once in the Supabase SQL editor for the LIONSWIPE project — safe to run
-- even if it's already been applied (create table/policy use IF NOT EXISTS
-- equivalents where possible; re-running just no-ops or errors harmlessly on
-- the policy/grant lines if they already exist).
--
-- This same block also lives in schema.sql (kept in sync) — this file exists
-- just so it can be run standalone without re-running all of schema.sql.

-- Curated off-campus restaurant pool for Roarie (see scripts/scrape-restaurants.js
-- and api/chat.js). Roarie's live web_search verification per chat turn (real
-- address + real current menu prices, never guessed) is accurate but slow — this
-- table holds the same standard of verified data for a fixed pool of popular
-- Morningside Heights restaurants, refreshed on a schedule instead of once per
-- message, so api/chat.js can usually answer from a fast DB read and only fall
-- back to live search for restaurants outside the pool. `menu_items` is
-- [{item, price}], matching the shape Roarie's JSON reply already uses. Written
-- only by the scraper (service role key, bypasses RLS) — anon/authenticated
-- users can only read.
create table if not exists public.curated_restaurants (
  id text primary key,
  name text not null,
  address text,
  cuisine text,
  walk_minutes int,
  menu_items jsonb not null default '[]'::jsonb,
  note text,
  active boolean not null default true,
  verified_at timestamptz
);

alter table public.curated_restaurants enable row level security;

drop policy if exists "Anyone can read curated restaurants" on public.curated_restaurants;
create policy "Anyone can read curated restaurants"
  on public.curated_restaurants for select
  using (true);

grant select on public.curated_restaurants to anon, authenticated;

-- No insert/update/delete policy for anon/authenticated — only the service role
-- (used by scripts/scrape-restaurants.js, never exposed to the browser) can write here.
