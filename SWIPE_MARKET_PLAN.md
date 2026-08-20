# Swipe Market — handoff plan

Branch: `swipe-market` (not yet merged, not yet pushed as of this writing).
Nothing in this branch has been committed yet — it's all working-tree changes on
top of `main`.

## What this is

A peer-to-peer meal-swipe marketplace inside LionSwipe, modeled loosely on
[swipemarketcu.com](https://swipemarketcu.com/) but with a redesigned UI matching
the rest of the app, and one important addition swipemarketcu.com doesn't have:
**every listing requires a meeting location and time window**, because Columbia
swipes can only physically change hands by one student swiping another in at a
dining hall entrance — there's no remote/API transfer.

Entry point: a "Swipe Market →" button in the top-left of the header, mirroring
the "See Breakdown →" button's position in the top-right (`index.html`, the
`.headerLeft` div, currently ~line 264). A small nudge line under that button
reads "Buy extra swipes here!" or "Sell extra swipes here!" depending on the
user's projected pace vs. their dining plan (see "Header nudge" below).

## Files touched

- **`schema.sql`** — appended `swipe_listings` table, `swipe_matches` table, and
  the `claim_swipe_listing()` Postgres function (all at the bottom of the file,
  after the existing `daily_menus` table). **This has not been run against the
  real Supabase project yet** — see "Setup required" below.
- **`index.html`** — everything else. This is a single-file app (no build step),
  so all the CSS/HTML/JS for this feature lives inline in this one file. Look for
  `/* ---- Swipe Market page ---- */` (CSS, ~line 195) and
  `/* ---------------- Swipe Market page ---------------- */` (JS, ~line 1500)
  as the main anchors. Everything Swipe-Market-related is grouped under those.

## How it works end to end

### Posting a listing
- Header button → `#marketBtn` click handler → shows `#marketPage`, hides
  `#mainPage` (same show/hide pattern as the existing Breakdown page).
- "+ Post a Listing" opens `#listingOverlay`, a modal styled like the existing
  swipe-logging / spending-goal modals. Fields: I'm Selling / I'm Buying toggle,
  quantity, price per swipe, **payment methods** (multi-select toggle —
  Venmo/PayPal/Cash/Zelle, at least one required), **meeting location** (free
  text — deliberately *not* a dropdown of dining halls, see "Design decisions"
  below), **meeting window start/end** (two `datetime-local` inputs), optional
  note.
- **No contact field.** Contact info is *always* the poster's own account email
  (`currentUser.email`), auto-filled at submit time — never typed in. The modal
  shows a read-only preview ("Your school email (X) is shown automatically").
- Validation (client-side in the `listingSubmit` handler, ~line 1868 in
  `index.html`): quantity > 0, price ≥ 0, location non-empty, both meeting times
  parse, meeting start isn't in the past, **meeting window is at least 15
  minutes** (`meetEnd - meetStart >= 15*60000`). The same 15-minute minimum is
  also enforced at the database level (`swipe_listings` check constraint), so it
  can't be bypassed by calling Supabase directly.
- Inserts a row into `swipe_listings` with `contact_email` set from the session.
  `payment_methods` (`text[]`) is enforced non-empty and restricted to
  `venmo`/`paypal`/`cash`/`zelle` at the DB level too (check constraint), same
  belt-and-suspenders pattern as `contact_email`. It's snapshotted onto the
  `swipe_matches` row at claim time (see `claim_swipe_listing()`) so both
  sides still see it after the listing's quantity/status changes.

### Browsing
- Four tabs: **Buy Swipes** (other people's `sell` listings, cheapest-per-swipe
  first), **Sell Swipes** (other people's `buy` listings — i.e. people who want
  to buy from you — highest-offer first), **My History**, **Matches** (see
  below).
- Listings whose meeting window has already passed (`meeting_end < now`) are
  filtered out of Buy/Sell entirely — not actionable for a browser. They still
  show up under My History with a red "Expired" tag (see "Expiry" below).
- Each non-own card shows the poster's email, quantity, price, total, note, and
  the meeting location + formatted window. Non-own active/unexpired cards get a
  `.claimable` class and `cursor:pointer` — the whole card is clickable.

### My History
- Originally "My Listings" (just your own posted listings, any status) — renamed
  and expanded so someone who has only ever *claimed* from other people, and
  never posted a listing themselves, still has something meaningful here
  instead of a permanently empty tab.
- `renderHistoryGrid()` (index.html) merges two sources, both already loaded
  client-side (no extra query): `marketListings` filtered to your own
  (`user_id === myId`, rendered by `renderMyListingCard()` — Active/Completed/
  Expired status, Mark Complete/Delete buttons, unchanged from the old "My
  Listings" behavior) and `marketMatches` filtered to ones where you're the
  **claimer** (rendered by `renderMyClaimCard()` — a claim's status here is
  derived, not stored: `cancelled` if the match was cancelled, `Completed` if
  its meeting window has already passed, otherwise `Active Agreement` with the
  same green highlight as the Matches tab). Both sets are merged and sorted by
  `created_at` into one chronological feed.
- Deliberately read-only — no Message/Cancel buttons here even for active
  claims, to avoid duplicating controls that already live on the **Matches**
  tab (which itself covers *both* poster- and claimer-side active/cancelled
  agreements). My History is the ledger; Matches is where you act on it.

### Claiming (the "click to confirm" flow)
- Clicking a claimable card opens `#claimOverlay` — this reuses the exact same
  visual pattern as the existing "log a dining hall swipe" modal (`#swipeOverlay`,
  the `.counter` class with −/+ buttons). If the listing has more than 1 swipe
  available, a counter lets the claimer pick how many to claim (min 1, max
  whatever's left); if it's exactly 1, the counter is hidden and the summary just
  says "1 swipe."
- Confirming calls `supabase.rpc('claim_swipe_listing', { p_listing_id, p_quantity })`.
  That Postgres function (schema.sql, `security definer`, ~line 273):
  1. Looks up the claimer's email from `auth.users` server-side (never trusts a
     client-supplied email).
  2. Row-locks the listing (`for update`) and validates: listing exists, is
     `active`, hasn't expired, isn't the claimer's own listing, and the requested
     quantity doesn't exceed what's left. The row lock is what prevents two
     people from simultaneously claiming more swipes than actually exist.
  3. Inserts one `meal_logs` row (`type='hall'`) for the poster and one for the
     claimer, both `swipes = p_quantity` and dated to the listing's
     `meeting_start` (not claim time) — see "Swipe usage" below for why.
  4. Inserts a row into `swipe_matches` snapshotting both emails, the quantity,
     price, payment methods, location, meeting window, and the two `meal_logs`
     ids from step 3 (`poster_meal_log_id`/`claimer_meal_log_id` — needed so
     `cancel_swipe_match()` can find and delete them again).
  5. If the claim used up all remaining quantity, sets the listing's `status` to
     `'completed'`. Otherwise decrements `quantity` in place (so "quantity" on an
     active listing always means "remaining", not "originally posted").
- On success, the claimer immediately sees a "You're connected!" screen with the
  poster's email, quantity, price, and meeting details. The listing/matches/logs
  are reloaded so the grid and the main dashboard's swipe count both reflect it
  right away.

### Swipe usage
- Both sides of a claim count as "swipes used," not just the buyer: the seller
  physically swipes their card `p_quantity` times at the meetup (those swipes
  are gone from their plan whether or not they personally eat), and the buyer
  gets `p_quantity` meals without touching their own plan's balance at all —
  both are genuine dining-hall visits, so both get logged as one. This is what
  makes Swipe Market activity show up in `usedSemester`/"Swipes Used" on the
  main dashboard and Breakdown page for both people, same as any manually
  logged swipe.
- Logged optimistically at claim time (dated to `meeting_start`, so it lands in
  the right week even though the meetup hasn't happened yet) — same
  eager-commit philosophy as the listing quantity/status update. If the
  agreement is cancelled before the meetup, `cancel_swipe_match()` deletes both
  `meal_logs` rows again via the ids stored on the match, and each acting
  user's own `logs`/dashboard is refreshed immediately (`refreshLogs()` in
  `confirmClaim()`/`cancelAgreement()`, index.html) — the other participant
  sees it next time they load their own data, same no-realtime limitation as
  the rest of the app.
- The log's `name` is `'Swipe Market: ' || meeting_location` so it's
  identifiable if ever surfaced in a log list — though as of this writing
  nothing in index.html actually renders individual `meal_logs` rows by name,
  only aggregates (`usedSemester`, the weekly bar chart), so this is mostly
  for anyone querying the table directly.
- The **poster** finds out by checking the **Matches** tab next time they open
  the app — there is no push notification or email (see "Design decisions").
  Partial claims work the same way as full ones: claiming 3 of a 10-swipe
  listing creates one `swipe_matches` row for those 3 (so that claimer can
  message the poster about their piece — see "Messaging" below) while the
  listing stays live with `quantity=7` for anyone else to claim from.

### Matches tab
- New 4th tab. Queries `swipe_matches` (RLS already restricts results to rows
  where the current user is `poster_id` or `claimer_id`, so no extra filter
  needed client-side). Renders each match as "Selling to X" or "Buying from X"
  depending on whether the current user was the original poster and whether the
  original listing was a `sell` or `buy` — this is why `swipe_matches` stores its
  own `listing_type` column (a snapshot of the original listing's type), since a
  match row on its own doesn't otherwise tell you which side of the trade the
  poster was on.

### Messaging
- Each `swipe_matches` row can have a chat thread, `swipe_messages`
  (`match_id`, `sender_id`, `recipient_id`, `body`, `is_system`, `read_at`).
  Post-claim only — there's no pre-claim negotiation with a poster before
  claiming; you connect by claiming, then talk.
- Every card under **Matches** gets a **Message** button opening
  `#messageOverlay`: a scrollable bubble list (your messages right-aligned in
  navy, theirs left-aligned in the secondary card color, system notices
  centered/muted) plus a text input. No realtime — messages are (re)loaded
  each time the thread is opened, same polling-on-open approach as the rest
  of Swipe Market.
- Unread count (`read_at is null and recipient_id = me`) shows as a small
  badge on the **Matches** tab pill itself; opening a thread marks its
  messages read and clears the count. This is the app's whole notification
  story for messages — still no email/push (see "Design decisions").
- `is_system` messages (currently just the "X cancelled this agreement" note
  — see "Cancelling an agreement") can only be inserted by
  `cancel_swipe_match()` (`security definer`); the regular insert RLS policy
  forces `is_system = false` on anything a user sends directly, so a
  system-styled bubble in the UI is always trustworthy.

### Cancelling an agreement
- Either participant can back out of an active match before the meetup
  happens. Each **Matches** card shows a **Cancel** button (active agreements
  only — cancelled ones show a greyed-out "Cancelled" tag instead) that
  confirms first, then calls `cancel_swipe_match(p_match_id)`.
- That function (`security definer`, schema.sql): checks the caller is
  actually `poster_id` or `claimer_id` and the match is still `'active'`,
  flips `swipe_matches.status` to `'cancelled'`, **restores the claimed
  quantity back onto the listing** (`quantity += match.quantity`) and
  reactivates it (`status = 'active'`) if claiming this match had marked it
  `'completed'` — so those swipes are buyable/sellable by someone else again.
  It's a no-op on the listing side if the poster already deleted it
  (`listing_id` went `null` via `on delete set null`).
- "Both people are notified" by inserting an `is_system` message into their
  shared thread — no email, consistent with the rest of the app (see
  "Design decisions").
- Active/cancelled here is a `swipe_matches`-level concept, separate from
  `swipe_listings.status` (still just `active`/`completed`, see the design
  decision below) — cancelling a match never deletes it, so the chat history
  and the fact it happened stay visible to both people.

### Expiry
- No cron job / server-side status flip. `isExpired(l)` (index.html) just
  compares `meeting_end` to `new Date()` at render time, same lightweight
  approach the rest of the app already uses for pace/projection math.
- If a signed-in user has any of their own **active** listings that are expired,
  a red banner appears at the top of the Swipe Market page (reusing the existing
  `.configWarning` style) telling them how many and to check My History.

### Header nudge ("Buy extra swipes here!" / "Sell extra swipes here!")
- `updateMarketNudge()` (index.html, ~line 1462), called at the end of the
  existing `updateSwipesSummary()` function so it recomputes on every log/plan
  change.
- Logic: once at least a week has elapsed since `SEMESTER_START`, compute the
  user's actual average swipes/week so far, project that pace across the
  remaining weeks, and compare to their plan's `total_swipes`. >5% over
  projected → "Running low — Buy extra swipes here!" (red). >15% under
  projected → "Won't use all your swipes — Sell extra swipes here!" (green).
  Otherwise no nudge. Requires a saved dining plan; shows nothing if none is set.

## Design decisions worth knowing (so you don't redo this thinking)

- **No email/push notification service.** The user (repo owner) asked whether
  emailing the poster was necessary, and we decided against it deliberately: it
  would've required signing up for a third-party service (Resend/SendGrid/etc),
  generating and storing a new API key, and dealing with sender-domain
  verification just to email arbitrary `@columbia.edu` addresses. Since both
  people already have accounts, doing the whole "connect two people" job inside
  Supabase via `swipe_matches` + one RPC function needed zero new infrastructure
  and zero new secrets. The tradeoff is polling instead of push — acceptable
  since the app has no notification system at all elsewhere either. Same call
  applies to messaging and cancellation: new messages surface as an unread
  badge on the Matches tab, and a cancellation surfaces as a system message in
  the thread — both in-app only, no email.
- **Meeting location is free text, not a dropdown of dining halls.** Dining hall
  names in this app come dynamically from `/api/menus` at runtime (there's no
  static `HALLS` constant to reuse), and hand-typing a hardcoded list risked
  being wrong/incomplete. Free text was the safer call; a `<datalist>`
  autocomplete against loaded menu data would be a nice upgrade later but wasn't
  necessary for the ask.
- **`contact_email` is enforced at the DB level too**, not just trusted from the
  client: `check (contact_email ~* '^[^@]+@(columbia|barnard)\.edu$')` on
  `swipe_listings`. Redundant with the fact that `enforce_edu_email` already
  blocks non-school signups, but cheap insurance against ever surfacing an
  emailfrom a non-.edu address.
- **`swipe_listings.quantity` represents *remaining*, not originally posted.**
  There's no `original_quantity` column — partial claims just decrement it in
  place. This matches how "Selling 12 swipes" naturally becomes "Selling 7
  swipes" after 5 get claimed, with no extra bookkeeping.
- **Listing status is only `active`/`completed`**, no `cancelled`. Earlier in
  development a `cancelled` status existed but was removed because nothing in
  the UI ever set it — dead code. If you want an explicit "withdraw without
  fulfilling" action later, that's the value to reintroduce. Note this is
  distinct from `swipe_matches.status` (`active`/`cancelled`), added later for
  the "cancel an agreement" flow — a listing can't be cancelled directly, only
  deleted (if unclaimed) or effectively reopened by cancelling the match that
  had reduced its quantity.
- **Known overlap gap**: if a listing with quantity > 1 gets claimed by multiple
  different people in pieces, every resulting match shares the *same* meeting
  location/window from the original listing (there's no per-claim scheduling).
  Fine for "swipe people in one at a time over a window," but worth knowing.

## Setup required before any of this works for real

1. **Run `schema.sql` in the Supabase SQL editor** (or the standalone
   `swipe_market_schema.sql` extract — kept byte-for-byte in sync with
   schema.sql's Swipe Market section, see its own header). Creates
   `swipe_listings`, `swipe_matches`, `swipe_messages`, and the
   `claim_swipe_listing()` / `cancel_swipe_match()` functions — none of this
   exists in the real project yet. If `swipe_listings` was somehow already
   created from an earlier iteration, don't just re-run the `create table` —
   see the commented-out `alter table` migration block right after it instead.
2. **Turn off the local-preview login bypass.** Near the top of the Swipe Market
   JS block, `index.html` currently has:
   ```js
   const MARKET_SKIP_LOGIN_GATE = true;
   ```
   This was added temporarily so the page (and fake sample listings/matches)
   could be reviewed without a working Supabase login. **Set it to `false`**
   before this ships or gets used with real accounts — everything downstream
   (`MARKET_SAMPLE_LISTINGS`, `MARKET_SAMPLE_MATCHES`, the `preview-user` id
   fallback, the "sample-*" short-circuit in `confirmClaim`) is gated behind this
   one flag and stops mattering once it's `false`. You don't need to delete the
   sample-data code, just flip the flag — though deleting it is fine too if you'd
   rather clean it up.
3. **Test with two real `@columbia.edu`/`@barnard.edu` accounts.** Everything so
   far has only been verified against a static file server with the login bypass
   and fake data — I have not been able to exercise the real
   `claim_swipe_listing()` function, real RLS enforcement, or the real Matches
   tab against live Supabase. Recommended test: Account A posts a sell listing,
   Account B claims part of it, confirm both see the match under Matches with
   correct emails/roles, confirm A's listing shows reduced quantity (or
   "Completed" if fully claimed), confirm B can't claim more than what's left.
4. **Local dev**: use `npm run dev:local` (project's own lightweight dev server,
   `scripts/dev-server.js`), not `vercel dev` — the Vercel project's "Build
   Command" (`node scripts/generate-config.js`) regenerates `config.js` from
   environment variables that aren't scoped to the Development environment in
   Vercel's dashboard, which will silently overwrite a manually-configured
   `config.js` with empty values. `dev:local` serves `config.js` as a static file
   and never touches it. Known gap: `dev:local` doesn't route `/api/chat.js`, so
   "Ask Roarie" chat won't work under it (pre-existing, unrelated to this
   feature) — everything else, including Swipe Market, works fine.

## Not built (explicitly out of scope so far)

- **Editing a listing.** Only Delete exists for an owner's active listing; no
  edit-in-place. Workaround is delete-and-repost.
- **Cancelling a listing directly** (as opposed to cancelling the match formed
  from it, which does exist — see "Cancelling an agreement"). An unclaimed
  listing can still only be deleted, not "cancelled" with a reason/notice.
- **Pre-claim negotiation.** Messaging only exists after a claim creates a
  match; you can't message a poster before claiming to negotiate price or
  quantity first.
- **Any notification beyond in-app** (unread badge for messages, system
  message for cancellations) — still no email, no push.
- **Mobile-narrow-viewport testing** — layout uses flex-wrap and should adapt,
  but hasn't been specifically checked below ~768px.
- **Automated tests** — this repo has no test suite anywhere (consistent with
  the rest of the app, a single-file no-build-step project), so none were added
  here either.

## If you're a fresh Claude session picking this up

Read `index.html`'s Swipe Market CSS block (search `Swipe Market page`, ~line
195) and JS block (search `Swipe Market page`, ~line 1500) top to bottom before
changing anything — it's all co-located and reasonably commented inline. Same
for the bottom third of `schema.sql`. This document should give you the "why"
behind the non-obvious choices; the code comments give you the "what" at each
specific spot.
