# PRD: Breakdown Page Redesign

**Branch:** `breakdowndashboard`
**Author:** Evelyn Ding
**Status:** Implemented
**Scope:** `index.html` — `renderBreakdown()`, `#breakdownPage`, and supporting pacing math

## 1. Background

The Breakdown page (`#breakdownPage`, opened via the "See Breakdown" button) currently shows:
- A 4-stat grid: Swipes Used, Swipes Left, Spent This Week, Spent This Month (+ an optional Spend Goal card if one is set)
- A "Meal Swipes Used / Week" bar chart (8 weeks history + up to 4 future target bars, all set to one flat number)
- A "Money Spent / Week" bar chart (8 weeks history only, no future bars)
- A dining-hall-vs-eating-out pie chart

Two things are being redesigned: **layout/content** of the page, and the **pacing math** behind the future-facing bars in both charts.

## 2. Goals

1. Surface the user's dining plan and spending goal (source of truth: the Profile modal, `#planOverlay`) as a lightweight subtitle next to the page heading, so the numbers below are self-explanatory without opening Profile.
2. Reorganize the stat cards to match the metrics users actually care about week-to-week, and add semester-level spend visibility.
3. Make the swipes/week target pace fully dynamic (recomputed from current remaining swipes ÷ weeks remaining) rather than a static snapshot, while keeping it numerically identical to the existing "Swipes/week needed" header stat.
4. Give the Money Spent chart real forward-looking target bars, driven by the user's spending goal, mirroring how the swipe chart already projects targets.
5. Ensure both charts' projected bars roll forward correctly week over week: as a real week completes, it becomes a solid history bar, and a fresh set of 4 projected bars is computed for the following weeks.

## 3. Header subtitle: dining plan / spending goal

Next to the "Your Breakdown" heading, add a small gray subtitle line:

```
dining plan: Plan B  |  spending goal: $50 / week
```

- **Source of data:** pulled from the same state already populated from Profile (`#planOverlay`):
  - Dining plan → `userPlan.plan_name` (falls back to `--` if `userPlan` is null or `plan_name` is empty, matching how `planName` field already behaves elsewhere, e.g. `index.html:1005`)
  - Spending goal → `spendGoal.amount` + `spendGoal.period`, formatted as `$X / {day|week|month|semester}` (falls back to `--` if `spendGoal` is null, matching existing null-handling at `index.html:499`, `1372`)
- **Style:** tiny, gray, non-bold text (reuse `.util` / `--muted` color token already used for `.swipesLine span`, `index.html:80`) — visually secondary to the "Your Breakdown" heading, not a stat card.
- **No new data fetching required** — `userPlan` and `spendGoal` are already loaded into module-level state before `renderBreakdown()` runs.
- Clicking this line is out of scope (no edit-in-place behavior) — it's read-only context. (Open question: confirm this — the existing `#swipesLeftLine` on the main page is clickable-to-edit; happy to make this subtitle clickable too if desired, but default is read-only since Profile is already one tap away via the existing settings entry point.)

## 4. Stat cards

**Row 1 — 4 cards, reordered:**

| Card | Value source |
|---|---|
| Swipes Used | `usedSemester` — unchanged (`index.html:1367`) |
| Swipes/Week Needed | **new location** — now shown here instead of only in the main-page header; uses the dynamic pacing formula in §5 |
| Swipes Left | `swipesLeft` — unchanged (`index.html:1368`) |
| Total Spent Eating Out This Week | `spentWeek` — unchanged (`index.html:1369`) |

This replaces the current row (Swipes Used / Swipes Left / Spent This Week / Spent This Month) — Spent This Month moves down to Row 3 below.

**Below Row 1:** Meal Swipes Used / Week chart (unchanged position, updated math per §5).

**Row 2 — 2 new cards** (placed under the swipes chart):

| Card | Value source |
|---|---|
| Total Spent Eating Out This Month | `spentMonth` — reuses existing `logsThisPeriod('month')` calc (`index.html:1370`), just relocated |
| Total Spent Eating Out This Semester | **new** — `logsThisPeriod('semester')` filtered to `type==='out'`, summed by `amount` (same pattern as `spentWeek`/`spentMonth`, using the existing `periodCutoff('semester')` = `SEMESTER_START`) |

The existing optional Spend Goal card (`index.html:1372-1377`) is superseded by the new header subtitle (§3) and the money chart's target bars (§6) — remove it from the stat grid to avoid redundancy. Money Spent / Week chart and the pie chart stay where they are, below the two new cards.

## 5. Swipes/week target pace — dynamic calculation

**Current behavior:** `targetPerWeek` is computed once per render as a flat number and repeated across all 4 future bars (`index.html:1408-1414`).

**Requested change:** recompute it dynamically — "swipes left divided by weeks left in the semester" — and keep it in sync with the header's "Swipes/week needed" stat.

Concretely, this is already the formula in place:

```js
const remainingSwipes = swipesLeft || 0;
const weeksRemaining = Math.max(1, Math.ceil((SEMESTER_END - now) / weekMs));
const targetPerWeek = Math.max(1, Math.ceil(remainingSwipes / weeksRemaining));
```

— which matches `index.html:1281-1286`'s header math exactly (both already share the same `remainingSwipes / weeksRemaining` shape, per the existing code comment at `index.html:1404-1406` calling this out intentionally).

**What actually needs to change:** since `renderBreakdown()` already re-runs this calculation fresh on every call (`swipesLeft` and `now` are recomputed each time), the number is *already* dynamic in the sense of "always reflects current state." The gap is:
- Confirm `renderBreakdown()` is re-invoked whenever swipes are logged (not just on page open) — currently it's called on `breakdownBtn` click (`index.html:1336`) and via the polling check at `index.html:464`. Verify this stays wired up so the Swipes/Week Needed stat card (§4, Row 1) and the chart's target bars never go stale while the page is open.
- Move `weekNeeded`/`targetPerWeek` computation into a single shared helper (e.g. `swipesPerWeekNeeded()`) used by both the header stat (`index.html:1281-1286`), the new Row 1 stat card, and the chart's future bars — eliminating the current duplication across two near-identical code blocks, which is the actual risk to "always agrees."

No change to the underlying formula itself — it already does "swipes left ÷ weeks left." This section is about consolidating to one source of truth and confirming refresh triggers, not changing the math.

## 6. Money Spent / Week — new target bars

**Current behavior:** only draws history bars, no future projection (`index.html:1429-1439`).

**Requested change:** add 4 future target bars, where each bar = the amount you'd need to spend that week so your **overall average spend-per-period** (across the whole semester, actuals-so-far + projected future) lands on the spending goal.

Only applicable when `spendGoal` is set — if the user hasn't set a spending goal, show no target bars (matching how swipe target bars only render meaningfully off `userPlan`).

**Proposed formula**, normalized to a weekly goal regardless of `spendGoal.period`:

```js
// normalize the goal to a $/week figure
const weeksPerPeriod = { day: 1/7, week: 1, month: 4.33, semester: SEMESTER_WEEKS }[spendGoal.period];
const weeklyGoalAmount = spendGoal.amount / weeksPerPeriod;

// total budget for the whole semester at that weekly rate
const totalSemesterWeeks = Math.ceil((SEMESTER_END - SEMESTER_START) / weekMs);
const semesterBudget = weeklyGoalAmount * totalSemesterWeeks;

// what's already been spent eating out, semester-to-date
const spentSemesterSoFar = logsThisPeriod('semester').filter(l=>l.type==='out').reduce((s,l)=>s+l.amount,0);

// remaining budget spread over remaining weeks = the target each future bar shows
const weeksRemaining = Math.max(1, Math.ceil((SEMESTER_END - now) / weekMs));
const remainingBudget = Math.max(0, semesterBudget - spentSemesterSoFar);
const targetSpendPerWeek = remainingBudget / weeksRemaining;
```

This mirrors the swipes chart's shape (remaining ÷ weeks remaining) but for dollars, and ensures that if you're currently under/over pace, the future bars adjust up/down so hitting them for the rest of the semester brings your *overall* average back to the goal — not just "spend the goal amount every week from now on."

Same rendering pattern as the swipe chart: 4 future bars appended after history, styled with the existing `.bar.target` class, capped at `weeksRemaining` if fewer than 4 weeks remain.

## 7. Weekly bar rollover behavior

**Requirement:** at the start of the semester, show 4 projected/target bars (no history yet). As each week completes, it becomes one solid actual bar, and the projection recomputes to still show 4 target bars for the following weeks.

This is mostly already how the swipe chart works structurally (`index.html:1399-1415`):
- `historyWeeks = 8` fixed lookback window generates solid bars for weeks that have passed (empty `{swipes:0, money:0}` for weeks before the semester started or before signup — reads as zero, not "no data yet")
- `futureWeeksToShow = Math.min(4, weeksRemaining)` future bars always follow, recalculated fresh every render

**Gap to close:** at the very start of the semester, the fixed 8-week history lookback will render 7-8 bars of zeros before the real semester start date, which reads as "8 weeks of empty history" rather than "no history yet, just projections." Since the ask is specifically "at the beginning of the semester, the user should see the 4 projected bars" (implying little/no empty history clutter), history bars should be clipped to not extend before `SEMESTER_START` — i.e., `historyWeeks` should be `Math.min(8, weeksSinceStart)` rather than a fixed 8, so a brand-new semester shows just the current (possibly partial) week plus 4 projected weeks, growing to the full 8-week scrollback as the semester progresses.

Apply the same clipping logic to the Money Spent chart once it gains future bars (§6), so both charts roll forward consistently.

## 8. Out of scope / explicitly unchanged

- Pie chart (Dining Hall vs. Eating Out) — no changes requested.
- Profile modal (`#planOverlay`) itself — this PRD only reads from it, doesn't change how plan/goal are entered.
- Backend/Supabase schema — no new fields needed; semester-total spend is derived client-side from existing `logs`.
- Main page header stats (`index.html:1273-1313`) — "Swipes/week needed" stays there too; only the *shared calculation* is being consolidated (§5), not removed from the header.

## 9. Open questions — resolved

1. **Subtitle click behavior:** read-only, no edit-in-place. *(confirmed)*
2. **Money chart average-matching:** semester-to-date-inclusive — future targets correct for past over/underspend so the overall average lands on the goal by semester end, not a flat repeat of the goal amount. *(confirmed)*
3. **`weeksPerPeriod` approximation:** kept as drafted — 4.33 weeks/month, `SEMESTER_WEEKS = 15` for a semester goal. *(confirmed)*

## 10. Post-implementation notes

- Also fixed an unrelated pre-existing bug surfaced during testing: guest-mode data (`logs`, `userPlan`, `spendGoal`, Roarie chat) was only ever rehydrated from `localStorage` inside the `if(supabase){...}` auth bootstrap (`index.html:1240`) — so with no Supabase project configured, none of it survived a page reload despite being saved correctly. Added an `else` branch that hydrates straight from `localStorage` when `supabase` is null.
- Labels in the header subtitle were changed to all-caps (`DINING PLAN: … | SPENDING GOAL: …`) per follow-up request.
- Added a small color-key legend under each chart heading explaining solid vs. striped (target) bars.
