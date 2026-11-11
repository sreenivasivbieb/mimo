# Mimo — design

A chat agent with one tool, **web search**, built to answer questions about time correctly: "since Monday", "what did I ask on 3 November", "last Tuesday".

## Design principle

**The model writes; code decides.** Dates, memory lookups, citations, numbers and change verdicts are computed by plain code. The model receives the results as text and writes the answer around them.

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
| Time | `src/time.ts` | Date phrase → date window + candidate days, in the user's time zone |
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

### Time
- "Today" is the user's local day, from the browser's IANA time zone.
- A bare weekday or date in the future means the past one. "Last Tuesday" keeps two candidates.
- `3/11` follows the browser locale, states the assumption, and asks if both readings have messages.
- "In August" = whole month; "this week" = last 7 days; vague phrases get a wide window; "before the holidays" is never guessed.
- `24/7` and "I sat down" are not dates. Relative ages ("8 days ago") are computed in code.

### Recall
- Memory spans every chat of one user (browser-held user ID; no login).
- Date question → exact day lookup. Topic question → TF-IDF ranking inside the window.
- Every candidate day is tried before the window widens (day → week → month, at most 3 times).
- A turn must share a topic word to count; near-ties ask "which one?".
- On a recheck, words like "still accurate", "changed", "pricing", "since then" are dropped before ranking.
- No date and no topic → code lists the days and chats and asks which day.

### Router
- Greetings and memory questions are caught by regex, with no model call.
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
- `claude-opus-5-5` for all tiers, with effort `low` (router, extraction), `medium` (writer), `high` (recheck).
- Structured outputs for router, verdicts and extraction; a streamed tool loop for the writer and searchers.
- Server-side refusal fallback; the system prompt is cached and per-turn context goes last.

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

## Known limits

- **Identity is per browser.** Another browser or cleared storage starts a new memory.
- **JavaScript-rendered pricing pages** often lack prices in search text, so many price rechecks end in `could-not-verify`.
- **English only.** Memory, recheck and date patterns are English.
- **Recall thresholds** (0.12 / 0.04) are not tuned yet.

## Verification

- `npm test`: 94 tests with a fake model and fake search — date rules, recall, guards, graph routes, server reliability, store contract (also against Postgres).
- `npm run eval` and `npm run brief` run scenarios against the real model and search.
