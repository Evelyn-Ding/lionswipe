-- Run this in the Supabase SQL editor for your project.

create table if not exists public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ts timestamptz not null default now(),
  type text not null check (type in ('hall','out')),
  name text not null,
  swipes int,        -- set when type = 'hall'
  amount numeric,    -- set when type = 'out'
  created_at timestamptz not null default now()
);

alter table public.meal_logs enable row level security;

create policy "Users can view their own logs"
  on public.meal_logs for select
  using (auth.uid() = user_id);

create policy "Users can insert their own logs"
  on public.meal_logs for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own logs"
  on public.meal_logs for delete
  using (auth.uid() = user_id);

-- Per-user dining plan (set on first login, editable afterward).
-- semester_start/semester_type record which term the plan was saved for, so the
-- app can detect "this plan is stale, a new semester has started" on load and
-- (for Fall -> Spring) roll unused swipes into the new semester's suggested total.
create table if not exists public.meal_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_name text,
  total_swipes int not null,
  weekly_allowance int not null,
  semester_start timestamptz,
  semester_type text check (semester_type in ('fall','spring')),
  updated_at timestamptz not null default now()
);

-- If you already created meal_plans before this update, run these to add the new columns:
-- alter table public.meal_plans add column if not exists plan_name text;
-- alter table public.meal_plans add column if not exists semester_start timestamptz;
-- alter table public.meal_plans add column if not exists semester_type text check (semester_type in ('fall','spring'));

alter table public.meal_plans enable row level security;

create policy "Users can view their own plan"
  on public.meal_plans for select
  using (auth.uid() = user_id);

create policy "Users can insert their own plan"
  on public.meal_plans for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own plan"
  on public.meal_plans for update
  using (auth.uid() = user_id);

-- Optional: restrict signups to @columbia.edu at the database level too
-- (the app already checks this client-side, but this adds a hard backstop).
-- Requires the pg_net/auth hooks setup — simplest is to leave enforcement
-- client-side and rely on Supabase Auth email confirmation.

-- Scraped daily menus (see scripts/scrape-menus.js). One row per calendar day; the
-- `menus` JSON is shaped like { Breakfast: {...}, Lunch: {...}, Dinner: {...},
-- "Late Night": {...} } matching SAMPLE_MENUS in api/menus.js. Written only by the
-- scraper (using the service role key, which bypasses RLS) — anon/authenticated
-- users can only read. api/menus.js falls back to curated sample data if today's
-- row is missing (scraper hasn't run yet, or it failed).
create table if not exists public.daily_menus (
  date date primary key,
  menus jsonb not null,
  scraped_at timestamptz not null default now()
);

alter table public.daily_menus enable row level security;

create policy "Anyone can read today's menus"
  on public.daily_menus for select
  using (true);

-- No insert/update/delete policy for anon/authenticated — only the service role
-- (used by scripts/scrape-menus.js, never exposed to the browser) can write here.
