-- Incremental patch: makes Swipe Market transactions count toward "swipes
-- used" for both sides (see claim_swipe_listing() below for why), and undoes
-- that if the agreement later gets cancelled. Run this once in the Supabase
-- SQL editor for the LIONSWIPE project.
--
-- Your swipe_matches table already exists (from running swipe_market_schema.sql
-- earlier), so this only adds the two new columns it's missing, then replaces
-- the two functions with their updated versions — both operations are safe to
-- run even if some/all of this has already been applied.

alter table public.swipe_matches add column if not exists poster_meal_log_id uuid references public.meal_logs(id) on delete set null;
alter table public.swipe_matches add column if not exists claimer_meal_log_id uuid references public.meal_logs(id) on delete set null;

-- Atomically claims `p_quantity` swipes from a listing: records a swipe_matches
-- row (so both people can see each other's email + the meetup details in the app,
-- no email/push service involved) and either decrements the listing's remaining
-- quantity or marks it completed if this claim used the last of it. Runs as
-- security definer specifically so it can do both of those writes in one
-- transaction under a row lock (`for update`) — that lock is what stops two
-- students from simultaneously claiming more swipes than a listing actually has.
--
-- Also logs the swipe usage on both sides: the seller's card gets swiped
-- p_quantity times at the meetup (those swipes are gone from their plan
-- whether or not they personally eat), and the buyer gets p_quantity meals
-- without touching their own plan at all — so both get a 'hall' meal_logs row
-- (dated to the listing's meeting_start, not claim time), which is what makes
-- this actually count toward "swipes used" for both of them, same as any
-- other dining hall visit. Logged optimistically at claim time, same as the
-- listing quantity/status update above — if the agreement falls through,
-- cancel_swipe_match() deletes these rows again.
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
  v_poster_log_id uuid;
  v_claimer_log_id uuid;
  v_log_name text;
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

  v_log_name := 'Swipe Market: ' || v_listing.meeting_location;

  insert into public.meal_logs (user_id, ts, type, name, swipes)
  values (v_listing.user_id, v_listing.meeting_start, 'hall', v_log_name, p_quantity)
  returning id into v_poster_log_id;

  insert into public.meal_logs (user_id, ts, type, name, swipes)
  values (auth.uid(), v_listing.meeting_start, 'hall', v_log_name, p_quantity)
  returning id into v_claimer_log_id;

  insert into public.swipe_matches (
    listing_id, listing_type, poster_id, claimer_id, poster_email, claimer_email,
    quantity, price_per_swipe, payment_methods, meeting_location, meeting_start, meeting_end,
    poster_meal_log_id, claimer_meal_log_id
  ) values (
    v_listing.id, v_listing.type, v_listing.user_id, auth.uid(), v_listing.contact_email, v_claimer_email,
    p_quantity, v_listing.price_per_swipe, v_listing.payment_methods, v_listing.meeting_location, v_listing.meeting_start, v_listing.meeting_end,
    v_poster_log_id, v_claimer_log_id
  ) returning * into v_match;

  if p_quantity = v_listing.quantity then
    update public.swipe_listings set status = 'completed', updated_at = now() where id = v_listing.id;
  else
    update public.swipe_listings set quantity = quantity - p_quantity, updated_at = now() where id = v_listing.id;
  end if;

  return v_match;
end;
$$;

-- Cancels an active agreement: either participant can call this. Restores the
-- claimed quantity back onto the listing (and reactivates it if claiming this
-- match had marked it 'completed') so those swipes are buyable/sellable by
-- anyone again — a no-op on the listing side if the poster already deleted it
-- (listing_id went null via the on-delete-set-null above). Also deletes the
-- meal_logs rows claim_swipe_listing() created for both sides, since the
-- swipes never actually changed hands. Notifies both sides by inserting a
-- system message into their shared thread rather than email, consistent with
-- how matches themselves were already designed with no email/push service.
create or replace function public.cancel_swipe_match(p_match_id uuid)
returns public.swipe_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.swipe_matches%rowtype;
  v_canceller_email text;
  v_recipient_id uuid;
begin
  select * into v_match from public.swipe_matches where id = p_match_id for update;
  if not found then
    raise exception 'Agreement not found';
  end if;
  if auth.uid() <> v_match.poster_id and auth.uid() <> v_match.claimer_id then
    raise exception 'Not authorized';
  end if;
  if v_match.status <> 'active' then
    raise exception 'This agreement is already cancelled';
  end if;

  select email into v_canceller_email from auth.users where id = auth.uid();
  v_recipient_id := case when auth.uid() = v_match.poster_id then v_match.claimer_id else v_match.poster_id end;

  update public.swipe_matches set status = 'cancelled', cancelled_at = now()
    where id = p_match_id returning * into v_match;

  update public.swipe_listings
    set quantity = quantity + v_match.quantity, status = 'active', updated_at = now()
    where id = v_match.listing_id;

  delete from public.meal_logs where id in (v_match.poster_meal_log_id, v_match.claimer_meal_log_id);

  insert into public.swipe_messages (match_id, sender_id, recipient_id, body, is_system)
  values (p_match_id, auth.uid(), v_recipient_id, v_canceller_email || ' cancelled this agreement.', true);

  return v_match;
end;
$$;
