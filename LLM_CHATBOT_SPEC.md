# Product Requirements Document (for merge PR #1)

## What It Is
A conversational, multi-turn food-recommendation chatbot for LionSwipe. It replaces the
current one-shot "type once, get a list" search (the box under "What do you feel like
eating?") with an ongoing back-and-forth chat, so students can refine what they're
craving and ask follow-ups without retyping everything from scratch — e.g. "something
quick and cheap" → "actually not pizza" → "what's the walk on that one?"

Today's search takes one message and returns a fixed set of cards, with no memory of
what's already been suggested or rejected. This fixes that.

## How It Works

**Trigger:** clicking "Not Appetizing?" reveals two panels side by side, replacing
today's single search section.

**Left panel — "Ask Roarie for ideas"**
- Heading: "What do you feel like eating?"
- Smaller label underneath: "Enter cravings, meal ideas, or what you don't want to eat"
- The input field itself, with floating placeholder text showing an example (e.g.
  "mac and cheese and bbq brisket…")
- Filter buttons (Under $20, Under $30, <5 min walk, <10 min walk), same as today
- The multi-turn chatbot directly underneath the input:
  - Every message, including the first, is part of one ongoing conversation — fully
    replaces today's one-shot search
  - Recommendations render inline as part of the conversation: each bot turn that
    returns results shows as a mini row of 3-4 cards (reusing the existing result-card
    component) directly under the message that prompted it, so scrolling up shows the
    full history of rounds — e.g. "cheap and quick" → 4 cards → "not pizza" → a new 4
    cards
  - Each new message sends the prior conversation history to the model, so it stays
    history-aware instead of stateless; no cap on conversation length for v1
  - A "New chat" / reset button clears the current conversation and starts fresh
    without reloading the page
  - Recommendations stay grounded in real, current restaurant/menu data via web
    search — same standard as today's search, never guessed
  - Roarie has a real persona: replies are written in a distinct Roarie-the-Lion voice,
    not a generic assistant tone

**Right panel — "Enter Your Own Meal"**
- For students who already know where they ate and just want to log it, no chatbot
  needed
- Simple form: where you ate + price paid
- Reuses the existing spend-logging modal/flow directly (same `openSpendModal` logic),
  not a separate duplicated form — guarantees visual and behavioral consistency with
  today's "Log Meal" flow

**Mobile:** the two side-by-side panels stack vertically on small screens — "Ask
Roarie" on top, "Enter Your Own Meal" below.

## Technical Approach (draft)
- New or updated serverless function (e.g. `api/chat.js`) accepting `{ messages: [...] }`
  instead of a single `{ prompt }`, forwarding full history to Claude's Messages API
- Conversation persists via localStorage, the way guest mode does today, so it survives
  page reloads until the student clears it or hits "New chat"
- Guest chat history migrates to the account on sign-in, consistent with how existing
  guest swipe/spend data migrates today
- "Enter Your Own Meal" calls the existing `openSpendModal` flow directly from the right
  panel rather than duplicating its markup/logic

## Open Questions
- Roarie's persona/voice needs an actual system prompt written (tone, personality,
  boundaries) — not yet drafted

## Resolved
- Conversation length is capped at `MAX_HISTORY_MESSAGES` (30, kept in sync between
  `index.html` and `api/chat.js`) before each turn is sent to Claude. The cap is
  intentionally generous rather than aggressive so the message prefix stays stable
  turn-to-turn, which lets Anthropic's prompt cache (`cache_control` on the
  second-to-last message in `api/chat.js`) actually get hits as a session grows.
- Responses stream token-by-token over SSE (`api/chat.js` as a Vercel Edge Function)
  instead of waiting for the full reply + verified menu searches to finish, so the
  "Roarie is asking around campus..." status updates live with the reply text as it's
  generated.
- Identical back-to-back requests (e.g. a double-tapped send) are served from a
  short-lived (20s) in-memory cache in `api/chat.js` instead of re-hitting Claude.
