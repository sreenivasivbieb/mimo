# Mimo — design

A chat agent with one tool, **web search**, built to answer questions about time correctly: "since Monday", "what did I ask on 3 November", "last Tuesday".

## Design principle

**The model writes; code decides.** Dates, memory lookups, citations, numbers and change verdicts are computed by plain code. The model receives the results as text and writes the answer around them.

The one place a model sits in front of the code is reading time: a fast model works out the exact dates a message refers to, and code checks them against the plain date rules, which also take over if the model fails.

## Turn flow

Every message runs through one LangGraph state graph (`src/graph.ts`):

```
ingest → resolve_dates → recall → router ─┬─ smalltalk | clarify | search | memory_only ─→ synthesize
                                          └─ recheck → searcher ×1 or ×N (Send) → verdicts ─→ synthesize
synthesize → guards → store (reply done) → extract_claims
```

## Components

| Component | File | Role |
|---|---|---|
| Time | `src/time.ts` | Date rules (phrase → window + candidate days, in the user's time zone) and the checks on the time model's dates |
| Recall | `src/recall.ts` | Finds earlier turns across all of a user's chats |
| Turn graph | `src/graph.ts` | Router, searchers, verdicts, writer, claim extraction |
| Guards | `src/guards.ts` | No-record reply, citations, number check, verdict checks |
| Prompts | `src/prompts.ts` | System prompts and the per-turn context block |
| Models | `src/models.ts` | Anthropic adapter (Claude) |
| Search | `src/search.ts` | `web_search` on Tavily (Brave optional) |
| Store | `src/store.ts` | Postgres (`turns`, `claims`); in-memory copy for tests |
| Server | `src/server.ts` | HTTP + Server-Sent Events, turn IDs, cancellation |
| Chat page | `public/index.html` | Sends user ID, time zone and locale; renders links |

## Key points

### Time (`resolve_dates` in `src/graph.ts`, rules in `src/time.ts`)

**How the dates are worked out**
1. **A fast model works out the exact dates.** Claude Haiku 5.5 (effort `low`) gets today's date and weekday in the user's time zone, how the user writes numeric dates (3/11), the previous exchange, and the message.
2. **It answers in the same shape the rules produce**, so recall, the router, the recheck baseline and the writer use it unchanged:

   | Message (asked Wed 11 Nov) | Model's answer |
   |---|---|
   | "Last Monday you shortlisted CRM tools…" | `about: conversation`, words "Last Monday", window 9 Nov, candidates 9 Nov → 2 Nov |
   | "what does monday.com cost?" | `about: none`, no window |
   | "AI news from last week" | `about: world`, window 29 Oct – 4 Nov |

3. **Code checks the dates** (`resolvedFromModel`): they must be real, a past conversation can't be in the future, a window can't span over a year or start 3+ years back, and candidate days must be near the window. The words must appear in the message.
4. **`time.ts` double-checks the arithmetic.** Where the rules understand the model's words, they recompute the dates, and **the rules' dates win on a disagreement**. In testing, a model put "last weekend" on a Thursday–Friday; the rules corrected it.
5. **Fallback to rules.** On a model error or refusal, no answer within **4 seconds**, or an answer that fails the checks, the rules run on the whole message.

**When the model is skipped:** greetings, messages with no time words, and memory questions whose date the rules already read ("what did I ask on 3 November?"). These stay fast and model-free.

**What this gives over rules alone**
- Phrases the rules can't read get exact dates: "two Mondays ago", "in 2025", "since the 1st".
- Non-dates stay non-dates: `monday.com`, `after 3.11`, "before a job interview", "march" the verb.
- **Conversation vs world time:** "news from last week" limits the web search but doesn't trigger a memory lookup.
- A short reply like "3 November" is read in the context of the question it answers.
- The time words are removed from the topic before recall, so "two Tuesdays ago" isn't searched for as a topic.

**The date rules (`time.ts`)**, which the model's prompt follows and code checks against:
- "Today" is the user's local day, from the browser's IANA time zone.
- A bare weekday or date in the future means the past one. "Last Tuesday" keeps two candidates: the most recent, then the week before.
- `3/11` follows the browser locale, states the assumption, and asks if both readings have messages.
- "In August" = whole month; "this week" = last 7 days; "last week" = 13 to 7 days ago; "last weekend" = the last finished Saturday + Sunday; "a month ago" = about 30 days back, ±7, flagged vague.
- Vague phrases get a wide window; "before the holidays" is never guessed.
- `24/7` and "I sat down" are not dates. Relative ages ("8 days ago") are computed in code.

### Recall
- Memory spans every chat of one user (browser-held user ID; no login).
- Date question → exact day lookup. Topic question → TF-IDF ranking inside the window.
- Every candidate day is tried before the window widens (day → week → month, at most 3 times).
- A turn must share a topic word to count; near-ties ask "which one?".
- On a recheck, words like "still accurate", "changed", "pricing", "since then" are dropped before ranking.
- No date and no topic → code lists the days and chats and asks which day.

### Router
- Greetings and memory questions are caught by regex, with no model call (and no time-reading call either).
- Everything else goes to a fast structured model call; `search` is the default, `clarify` is rare and never twice in a row.
- A recheck of a recalled answer is decided by code, whatever the model says.

### Recheck
- Loads the claims we stored earlier and the day they were made (the baseline).
- Code runs one search per entity on its vendor's site first; a news search from the baseline is added when launches are asked about.
- Searchers: one call for ≤3 entities, else one per entity in parallel (capped at 8, 90 s timeout, one retry).
- The model proposes verdicts; code checks each one against page text and dates:
  - `held` — a source shows the stored value.
  - `changed` — a source dated after the baseline shows a new value.
  - `corrected` — a source dated on/before the baseline shows a different value.
  - anything unproven → `could-not-verify`. No news is never `held`.
- Code writes the verdict table and the bottom line; the model only explains them.
- Only checked verdicts become new claims.

### Guards
- `[S3]` / `[T2]` tags become links while streaming; unknown tags are removed.
- Prices and percentages in a cited sentence must appear in the cited page text (checked only on full page text).
- Search results dated outside the window are dropped.
- A memory question with nothing recalled gets a fixed "no record" reply; a reply that describes past chats without citing a recalled turn is replaced.

### Models
- `claude-haiku-5-5` (effort `low`) reads date phrases: a small extraction task where speed matters most. Override with `MODEL_TIME`.
- `claude-opus-5-5` for everything else, with effort `low` (router, extraction), `medium` (writer), `high` (recheck).
- Server-side refusal fallback on Opus; Haiku has none, so a declined time read just falls back to the rules.
- Structured outputs for time reading, router, verdicts and extraction; a streamed tool loop for the writer and searchers.
- The system prompt is cached and the per-turn context goes last.

### Search
- Tavily with page text for vendor-domain queries; Brave as an option.
- Vendor queries are not date-filtered (pricing pages are undated); news queries are bounded at the baseline.
- 15 s timeout, retries with backoff and `retry-after`, 10-minute cache.
- Budget: 6 searches per `search` turn; rechecks `clamp(entities + 2, 6, 10)`, or `clamp(2 × entities + 2, 6, 12)` with launches.

### Server and store
- Turn IDs make retries idempotent; a new message cancels the running one (stored as `cancelled`).
- A turn is saved only when complete; claim extraction runs after the reply and never affects it.
- Postgres with upserts and deterministic claim IDs; the server refuses to start without the database.
- The app reads `MIMO_DATABASE_URL`, not `DATABASE_URL`, so another project's database is never used.

## Verification

- `npm test`: 121 tests with a fake model and fake search — date rules, the checks on model dates, recall, guards, graph routes, time reading and every fallback path (error, timeout, bad or disagreeing dates), server reliability, store contract (also against Postgres).
- `npm run eval` (core, time, red-team suites) and `npm run brief` run scenarios against the real model and search.
