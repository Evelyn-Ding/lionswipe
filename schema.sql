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

-- Swipe Market (see the "Swipe Market" page in index.html, modeled loosely on
-- swipemarketcu.com). Signed-in students post "selling N swipes" or "buying N
-- swipes" listings with a price; other students browse and claim them (see
-- claim_swipe_listing() below) to arrange the actual exchange — there's no in-app
-- payment or swipe transfer, since Columbia doesn't expose an API for that, and
-- swipes can only change hands by physically swiping the other person in.
-- Restricted to authenticated users end-to-end (no guest/localStorage mode like
-- meal_logs has) since a listing is only useful if it can be matched with a real
-- person to meet.
-- meeting_location/meeting_start/meeting_end exist because that meetup has to be
-- scheduled up front — meeting_end/meeting_start are compared client-side against
-- "now" (index.html) to mark a listing "Expired" once the window has passed,
-- rather than a cron job flipping status server-side.
-- contact_email is always the poster's own account email (set client-side from
-- the logged-in session, never typed in) — auth.users enforces @columbia.edu /
-- @barnard.edu at signup already (enforce_edu_email above), so the check here is
-- just a second guarantee that only a school email is ever shown to other users.
create table if not exists public.swipe_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('sell','buy')),
  quantity int not null check (quantity > 0),
  price_per_swipe numeric not null check (price_per_swipe >= 0),
  note text,
  contact_email text not null check (contact_email ~* '^[^@]+@(columbia|barnard)\.edu$'),
  meeting_location text not null,
  meeting_start timestamptz not null,
  meeting_end timestamptz not null check (meeting_end >= meeting_start + interval '15 minutes'),
  status text not null default 'active' check (status in ('active','completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- If you already created swipe_listings before this update, run these instead of
-- the create table above (existing rows get NULL contact_email/meeting fields
-- until edited — there's no sane default to backfill):
-- alter table public.swipe_listings rename column contact to contact_email;
-- alter table public.swipe_listings add constraint swipe_listings_contact_email_check check (contact_email ~* '^[^@]+@(columbia|barnard)\.edu$');
-- alter table public.swipe_listings add column if not exists meeting_location text;
-- alter table public.swipe_listings add column if not exists meeting_start timestamptz;
-- alter table public.swipe_listings add column if not exists meeting_end timestamptz;
-- alter table public.swipe_listings add constraint swipe_listings_meeting_window_check check (meeting_end >= meeting_start + interval '15 minutes');

alter table public.swipe_listings enable row level security;

-- Active listings are visible to any signed-in student (that's the whole point of
-- a marketplace); a poster can also see their own completed listings so
-- their "My Listings" tab shows full history.
create policy "Signed-in users can view active listings and their own"
  on public.swipe_listings for select
  to authenticated
  using (status = 'active' or auth.uid() = user_id);

create policy "Users can insert their own listings"
  on public.swipe_listings for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own listings"
  on public.swipe_listings for update
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can delete their own listings"
  on public.swipe_listings for delete
  to authenticated
  using (auth.uid() = user_id);

-- A confirmed match between a listing's poster and whoever claimed it (see
-- claim_swipe_listing() below), snapshotting everything both people need to meet
-- up: each other's email, how many swipes, the price, and the location/time from
-- the listing at the moment of claiming. Only ever written by that function
-- (security definer, so it bypasses RLS) — regular users never insert/update/
-- delete rows here directly, only read the ones they're part of.
-- listing_type snapshots the *original* listing's type ('sell' = poster was
-- selling, claimer is buying; 'buy' = poster wanted to buy, claimer is selling to
-- them) — needed because index.html has no other way to tell which side of the
-- trade the poster was on once a match row exists on its own.
create table if not exists public.swipe_matches (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.swipe_listings(id) on delete set null,
  listing_type text not null check (listing_type in ('sell','buy')),
  poster_id uuid not null references auth.users(id) on delete cascade,
  claimer_id uuid not null references auth.users(id) on delete cascade,
  poster_email text not null,
  claimer_email text not null,
  quantity int not null check (quantity > 0),
  price_per_swipe numeric not null check (price_per_swipe >= 0),
  meeting_location text not null,
  meeting_start timestamptz not null,
  meeting_end timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.swipe_matches enable row level security;

create policy "Participants can view their own matches"
  on public.swipe_matches for select
  to authenticated
  using (auth.uid() = poster_id or auth.uid() = claimer_id);

-- Atomically claims `p_quantity` swipes from a listing: records a swipe_matches
-- row (so both people can see each other's email + the meetup details in the app,
-- no email/push service involved) and either decrements the listing's remaining
-- quantity or marks it completed if this claim used the last of it. Runs as
-- security definer specifically so it can do both of those writes in one
-- transaction under a row lock (`for update`) — that lock is what stops two
-- students from simultaneously claiming more swipes than a listing actually has.
create or replace function public.claim_swipe_listing(p_listing_id uuid, p_quantity int)
returns public.swipe_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing public.swipe_listings%rowtype;
  v_claimer_email text;
  v_match public.swipe_matches%rowtype;
begin
  select email into v_claimer_email from auth.users where id = auth.uid();
  if v_claimer_email is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_listing from public.swipe_listings where id = p_listing_id for update;
  if not found then
    raise exception 'Listing not found';
  end if;
  if v_listing.status <> 'active' then
    raise exception 'This listing is no longer active';
  end if;
  if v_listing.meeting_end < now() then
    raise exception 'This listing''s meeting window has already passed';
  end if;
  if v_listing.user_id = auth.uid() then
    raise exception 'You can''t claim your own listing';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > v_listing.quantity then
    raise exception 'Invalid quantity';
  end if;

  insert into public.swipe_matches (
    listing_id, listing_type, poster_id, claimer_id, poster_email, claimer_email,
    quantity, price_per_swipe, meeting_location, meeting_start, meeting_end
  ) values (
    v_listing.id, v_listing.type, v_listing.user_id, auth.uid(), v_listing.contact_email, v_claimer_email,
    p_quantity, v_listing.price_per_swipe, v_listing.meeting_location, v_listing.meeting_start, v_listing.meeting_end
  ) returning * into v_match;

  if p_quantity = v_listing.quantity then
    update public.swipe_listings set status = 'completed', updated_at = now() where id = v_listing.id;
  else
    update public.swipe_listings set quantity = quantity - p_quantity, updated_at = now() where id = v_listing.id;
  end if;

  return v_match;
end;
$$;

grant execute on function public.claim_swipe_listing(uuid, int) to authenticated;
