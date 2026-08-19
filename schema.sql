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

-- Per-user spending goal (fully optional, set/edited from the Settings modal's
-- "Spending Goal" tab — never prompted on signup like meal_plans is). One row per
-- user; no row simply means no goal is set. `period` controls which window
-- index.html compares actual spend against ("today"/"this week"/etc).
create table if not exists public.spending_goals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  amount numeric not null,
  period text not null check (period in ('day','week','month','semester')),
  updated_at timestamptz not null default now()
);

alter table public.spending_goals enable row level security;

create policy "Users can view their own spending goal"
  on public.spending_goals for select
  using (auth.uid() = user_id);

create policy "Users can insert their own spending goal"
  on public.spending_goals for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own spending goal"
  on public.spending_goals for update
  using (auth.uid() = user_id);

create policy "Users can delete their own spending goal"
  on public.spending_goals for delete
  using (auth.uid() = user_id);

-- Server-side backstop for the @columbia.edu / @barnard.edu restriction the app
-- already checks client-side (index.html) — blocks signup even if someone bypasses
-- the UI (devtools, a direct call to the Supabase Auth API, etc). Same trigger
-- mechanism Supabase's own docs use for auto-populating a profile row on signup,
-- just validating instead of inserting: https://supabase.com/docs/guides/auth/managing-user-data
create or replace function public.enforce_edu_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email !~* '^[^@]+@(columbia|barnard)\.edu$' then
    raise exception 'Signups are restricted to @columbia.edu and @barnard.edu addresses';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_edu_email_trigger on auth.users;
create trigger enforce_edu_email_trigger
  before insert on auth.users
  for each row
  execute function public.enforce_edu_email();

-- Ask Roarie conversation history (see the "Ask Roarie for ideas" panel in index.html).
-- One row per user, mirroring meal_plans/spending_goals — `messages` is the raw
-- Anthropic-format array ([{role, content}, ...]) so it can be replayed straight back
-- into /api/chat.js on the next turn with no reshaping. Guest conversations live in
-- localStorage and migrate here on sign-in, same as guest logs/plan/spending goal.
create table if not exists public.roarie_chats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  messages jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.roarie_chats enable row level security;

create policy "Users can view their own Roarie chat"
  on public.roarie_chats for select
  using (auth.uid() = user_id);

create policy "Users can insert their own Roarie chat"
  on public.roarie_chats for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own Roarie chat"
  on public.roarie_chats for update
  using (auth.uid() = user_id);

create policy "Users can delete their own Roarie chat"
  on public.roarie_chats for delete
  using (auth.uid() = user_id);

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
