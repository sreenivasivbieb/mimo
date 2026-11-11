# Mimo — design

## The problem

The brief: a chat agent with **one tool, web search**, judged on fast answers, correct answers and conversation quality ("not the most features"). The three sample questions all depend on **dates and memory**: "since Monday", "what did I ask on 3 November", "last Tuesday".

Language models handle these badly when left alone. They do not know the user's "today". They guess which Tuesday is meant. They invent past conversations. And they say "nothing changed" when they simply found no news. So the core decision was:

> **The model writes; code decides.** Dates, memory lookups, citations, numbers and change verdicts are worked out by plain code. The model gets the results as text and writes the answer around them.

## What we built

A LangGraph.js state graph (`src/graph.ts`) that every message runs through. Its shape follows LangChain's Open Deep Research — scope, research, write — wrapped in code steps for time and memory. The diagrams are in the [README](README.md#workflow-what-happens-to-one-message).

```
ingest → resolve_dates → recall → router ─┬─ smalltalk | clarify | search | memory_only ─→ synthesize
                                          └─ recheck → searcher ×1 or ×N (Send) → verdicts ─→ synthesize
synthesize → guards → store (reply done) → extract_claims
```

The rest of the system: a `node:http` server streaming Server-Sent Events, a single-file chat page, Postgres for history, Tavily for search, and Groq (`gpt-oss`) for the models. The Anthropic adapter is kept as an option.

## How each part works

### 1. Time is code (`src/time.ts`)
- **"Today" is the user's day, not the server's.** The browser sends its IANA time zone, and the server computes the local calendar day for each turn. At 00:20 in Asia/Kolkata, "today" is already the new day.
- **The rules**, each with a table-driven test that pins "now":
  - A bare weekday or date that would fall in the future means the past one. "On Monday", asked on a Sunday, means six days ago.
  - "Last Tuesday" keeps **two candidates**, the most recent Tuesday and the one before it. Day, topic and "did I mention X" lookups all try both days in order before widening. The answer names the day it matched.
  - "In August" and "last month" mean the whole month. "This week" means the last 7 days.
  - `3/11` is read in the browser locale's order (day-first or month-first), the assumption is stated, and we **ask** if both readings have messages.
  - Vague phrases ("a while ago") get a wide window and a `vague` flag. Event-anchored phrases ("before the holidays") are never guessed.
  - `24/7` and "I sat down" are not dates: numeric dates need a date-ish word before them, and only full weekday names count.
- Relative ages ("8 days ago") are computed in code and given to the model as text. The model never does date arithmetic.
- Our own rules run first. `chrono-node` is only the fallback for other explicit dates.

### 2. Memory and recall (`src/recall.ts`)
- **Memory spans all of a person's chats.** There is no login, so the browser keeps one user ID (in localStorage) and sends it with every message. Recall, "did we discuss X?" and rechecks search every chat with that user ID, never another user's. Answers say when a turn came from an earlier chat, and its link opens that chat at that turn. Chats from before user IDs existed are attached to the user the next time they are opened.
- **No date and no topic? Ask which day.** "What did we discuss in our previous conversation?" gets a reply written by code: the days that have messages, each with its chats and their first message. The next message ("3 November", "yesterday") is applied to the original question. With only one day of history there is nothing to ask, so that day is used.
- **A pure date question is an exact lookup.** "What did I ask on 3 November?" returns that day's turns in order, with no ranking and no model.
- **A topic question ranks** the turns inside the window by TF-IDF similarity plus closeness to the asked-for day; a turn that shares no topic word is never a hit, however close its day. On a recheck question, words like "still accurate", "changed", "pricing" or "since then" are removed before ranking, so "is it still accurate?" is not a search for turns mentioning "accurate". We accept the top hit only if it clears a threshold *and* beats the runner-up by a margin. If two candidates are nearly tied, we ask which one was meant. If the match is weak, the window widens (≈ day → week → month), at most 3 times, with a small penalty for distance.
- **"Did I ever mention X?"** scans every turn in the window. A negative answer is "I found no mention", never "you didn't".
- **The abstention gate:** a memory question with nothing recalled gets a fixed reply, with no model call: "I have no record of that… The days I do have messages from are …".
- **Own-record annotation:** earlier answers are fed back to the model with the URLs and excerpts they cited. The agent can then name its sources, and it holds a supported claim under pushback unless a newer source contradicts it.

### 3. Rechecks and verdicts
- The router extracts the entities. Code loads the **claims** we stored earlier and the **baseline day** they were made on.
- Searchers research the entities: one call when there are 3 or fewer, otherwise a LangGraph `Send` fan-out with one searcher per entity. Fan-out is capped at 8 and each searcher has a 90 s timeout and one retry. A searcher that fails becomes "could not check X", and the rest of the answer still goes out.
- **Coverage first, in code.** Before a searcher model runs, code runs one search per entity on the vendor domain of the stored claim (e.g. "Pipedrive professional price per seat" on pipedrive.com). When the question also asks about launches ("…or shipped something big since?"), each entity gets a second, news search bounded at the baseline day. The searcher model then gets at most two rounds of follow-ups. (Left to itself, the model spent three searches on one vendor and none on another.)
- The model **proposes** a verdict for each claim with source IDs as evidence. **Code checks** each one:
  - `held`: a cited source contains the stored value.
  - `changed`: a source dated after the baseline shows the new value.
  - `corrected`: a source dated on or before the baseline shows a different value, meaning we were wrong before.
  - Anything that fails its check becomes `could-not-verify`. Absence of news is never `held`.
- Code renders the verdict table and the bottom line, so the counts always match the table. The model only writes the explanation in between.
- New claims from a recheck come **only from verdicts that passed the checks**. An unverified number in the explanation can never become the next baseline.

### 4. Honesty guards (`src/guards.ts`)
- **Citations resolve in code, token by token while streaming.** `[S3]` becomes a link from the evidence map, `[T2]` links back to the earlier message, and unknown IDs are removed. A tag split across two tokens is held back until it is complete.
- **Number guard:** every price or percentage in a cited sentence must appear in the cited page text (digits split by page markup are rejoined). This follows a precision-first rule: we only flag when the excerpt is the full page text, because cut-off snippets produce false alarms.
- **Date-window filter:** search results dated outside the resolved window are dropped, so old news cannot pass as this week's.
- **Streaming versus checking:** `smalltalk`, `search` and `recheck` stream. `memory_only` and `clarify` answers are short, so they are shown only after their checks pass.

### 5. Reliability (`src/server.ts`)
- **Idempotent turns:** the browser sends a turn ID. A retry or double-click gets the stored answer, or re-attaches to the run already in progress.
- **One active run per conversation:** a new message aborts the old run (`AbortController`), and the old turn is stored as `cancelled`.
- **Partial results:** a turn is saved only when it completes. Interrupted turns are saved with status `error` and shown that way. Claim extraction runs after the reply, and its failure never touches the answer.
- **Retries and limits:** search has timeouts, backoff with jitter and `retry-after` handling, plus a 10-minute cache keyed by query, window and day. A `search` turn has a budget of 6 searches. Each recheck has a search budget of `clamp(entities + 2, 6, 10)`, or `clamp(2 × entities + 2, 6, 12)` when the question also asks about launches ("…or shipped something big since?"): then every entity gets a second, date-bounded news search from the baseline day, because vendor pricing pages are undated.
- **Database checks:** the server refuses to start if Postgres is unreachable.

### 6. Storage (`src/store.ts`)
- **Postgres**, through the pure-JS `pg` driver, behind an async `Store` interface, with two tables:
  - `turns`: keyed by (conversation, turn ID), with sources and evidence stored as JSONB and an index on local day.
  - `claims`: keyed by a deterministic hash of turn, entity and attribute; deleted automatically when their turn is deleted.
  - `turns.user_id` groups a person's chats, with an index on (user, local day) for cross-chat recall.
- Upserts make retries and re-extraction idempotent, and claims are written in one transaction. The schema is created on first start.
- `npm run db:up` starts Postgres 18 in Docker on port 5433. The app reads `MIMO_DATABASE_URL`, not `DATABASE_URL`: the dev machine exported a `DATABASE_URL` for another project, and Node's `.env` loader does not override existing variables.
- Tests and evals use `MemoryStore`, which follows the same contract. The contract tests also run against the real Postgres.

### 7. Models (`src/models.ts`)
Each provider sits behind a two-method `Model` interface: `structured()` for router, verdict and extraction output, and `run()` for the streamed writer and searcher loop with `web_search`. `MODEL_PROVIDER` picks the adapter.

- **Groq (default):** `openai/gpt-oss-20b` for the fast tier, `openai/gpt-oss-120b` for main and deep. `reasoning_effort` is low, medium or high, and the reasoning is hidden from the text. Structured calls use strict `json_schema` output (zod → `z.toJSONSchema`). Other Groq models fall back to JSON-object mode, and zod validates the result.
- **Anthropic (optional):** `claude-opus-5-5` for all tiers, with effort low, medium or high and server-side refusal fallback.

## What we tackled along the way

Most of these surfaced when we ran the agent live against Groq and Tavily.

| Problem | Symptom | Fix |
|---|---|---|
| **Groq tokens-per-minute cap** | `413 Request too large … Limit 8000, Requested 8405` on `gpt-oss-120b`. Rotating keys can't fix a request that is itself too big. | A per-request **input budget** (`GROQ_MAX_INPUT_TOKENS`, default 5000). We drop the oldest history first, then shorten older search results, then squeeze the middle of the turn context — never the user's question. Source excerpts shown to the model went from 1500 to 700 characters, and searches return 4 results instead of 5. The full text stays on the server for the guards. |
| **Rate limits (429)** | Turns failed while the SDK's own retries waited. | A **key rotator** over `GROQ_API_KEYS`. A key that gets 429 rests for the time Groq asks for (`retry-after` or `x-ratelimit-reset-tokens`), and the call moves straight to the next key. If every key is resting, we wait for the first one to come back. |
| **`tool_choice: "none"` ignored** | gpt-oss still called a tool, and Groq errored: "Tool choice is none, but model called a tool". | The final round sends **no tools at all** and passes the gathered results as plain text. |
| **Empty final answer** | The last round finished with `stop` and no text: the model still "wanted" to search. | The final round's system prompt says plainly that no tools are available and the answer must be written now. If the answer is still empty, we retry once with lower reasoning effort. |
| **Malformed tool calls** | Mid-stream 400: "parameters for tool web_search did not match schema" (the model sent a `url`). | A bad tool call falls back to the final round instead of failing the turn. The tool description now says there is no page-fetch tool. |
| **Citation formats** | gpt-oss writes `【S1†L4-L9】` and `(S1, S6)`, so links didn't render and no claims were saved. | `normalizeTags` rewrites both forms to `[S1]` before the resolver runs, including while streaming. |
| **Pricing pages filtered out** | The model passed today's date as `start_date`, and undated pricing pages disappeared, causing repeated searches. | Vendor-domain queries (`domains: [...]`) never send dates. News-style queries stay date-bounded at the baseline. |
| **Unverified claim saved** | A recheck that verified nothing still stored "$20/seat" as a fresh claim. | Recheck claims come only from code-checked verdicts. |
| **Invented memories via "Best guess"** | "did we discussed about rcb" (past tense, no prior history) missed the memory patterns, the router chose `clarify`, and the reply said "Best guess: we might have talked about their recent match results". | Memory patterns accept any tense and more verbs ("discussed", "researched", "covered"). "Did we discuss X?" and "what did we discuss about X?" scan every turn for X and answer "No — we haven't discussed X yet" or "I found no mention of X" without a model call, or list the turns with links. `clarify` may guess what to look up but never what was said. A **memory guard** replaces any buffered reply that describes past conversation without citing a real recalled turn. |
| **Clarify loops on follow-ups** | "whats tavilly" → "tavily yes i mean" → "what it is": 7 of 8 turns asked another question with a "Best guess" instead of answering. The router saw only the current message, so "it" meant nothing to it. | The router now gets the last 4 exchanges, so it can resolve "it" and fix misspellings. Its prompt makes `search` the default for any factual question, however short, and `clarify` rare. Code never asks twice in a row: if the previous turn was a clarifying question, this message is treated as the answer and goes to `search`. |
| **New chats forgot old ones** | Memory questions only searched the open chat, so "what did we discuss before?" in a new chat found nothing. | A per-browser user ID groups chats. Recall and rechecks search all of that user's chats. A question without a date gets a code-written "which day?" list, and the next reply's date is applied to it. |
| **Old chats invisible to new ones** | Chats made before user IDs had none, so a new chat asking "did we discuss IPL recently?" found nothing. Once they were attached, the answer quoted an earlier *"did we discuss IPL?" → "no"* exchange instead of the real IPL turn. | The browser remembers every chat it has used and sends the list, and the server attaches those chats to the user. Topic recall skips turns that were themselves questions about our history (and their answers); day questions still list them. |
| **Verdict values too literal** | "$14/seat/month billed annually" was not found on a page saying "$14 per seat", so a true `held` became `could-not-verify`, and the explanation contradicted the table. | When the exact wording isn't on the page, a value matches if every price and number in it appears there (so "$14" does not match "$140" or "$1.14"). The writer is told the table is final. Zero-width characters inside `[S3]` are stripped. |
| **Recheck words taken as the topic** | "What did I ask on 3 Nov? Is it still accurate?" became a search for turns mentioning "accurate" (and "nov"), answered "I found no mention of accurate". | On a recheck question, recheck vocabulary ("still", "true", "accurate", "changed", "pricing", "since then"…) is removed before recall; abbreviated months are stop words. |
| **Second "last Tuesday" ignored** | If the Postgres chat was on the earlier Tuesday, "Last Tuesday I asked about Postgres…" asked "which one?" or said "no mention". | Topic and "did I mention X" lookups try each candidate day in order before widening. |
| **Unrelated turns as matches** | A turn on the asked-for day with no shared word ("a good name for a cat?") scored on date closeness alone and forced a needless "which one?". | A turn must share a topic word to be a hit. |
| **Launches never searched** | "Has any of them changed pricing or shipped something big since?" searched only undated pricing pages; with 5 tools the budget left 2 searches for everything else. | A news search per entity from the baseline day, and a budget of `clamp(2 × entities + 2, 6, 12)` for such questions. |
| **"what did I ask" read as an absence question** | The "did I ever mention" pattern matched inside "what did I ask on 3 November". | The absence pattern is anchored to the start of the message. |
| **False dates** | "24/7 support" was parsed as 24 July, and "I sat down" as Saturday. | Numeric dates need a preceding date word, only full weekday names count, and the `chrono` fallback only accepts phrases containing letters. |
| **LangGraph name clash** | "recall is already being used as a state attribute". | State channels were renamed to `recalled` and `verdictRows`; the node names stay as in the plan. |
| **Stray `DATABASE_URL`** | Tests tried to connect to another project's database. | The app uses a dedicated `MIMO_DATABASE_URL` and its own port. |

## How we verified it

- **102 automated tests**, run without any API keys:
  - date rules with a pinned clock, including midnight and daylight-saving edges;
  - recall: exact day, falling back to the second candidate (for day, topic and absence lookups), near-tie asks, widening, absence scans, no hits on date closeness alone;
  - guards: tags split across tokens, digits split by markup, verdict downgrades, matching counts;
  - graph routes with a fake model and fake search: smalltalk makes no search call, the abstention gate, citations, verdicts, rechecks phrased as "still accurate / true / valid / up to date", launch searches from the baseline day, fan-out above 3 entities, asking when there is no history, "did we discuss X?" in any tense, the memory guard, follow-ups resolved from recent turns, no clarify loops, memory across chats (the which-day flow, links into other chats, other users never visible);
  - server reliability: duplicate turn IDs, aborting a run mid-stream, bad input;
  - the Groq adapter against a local fake API: streamed tool calls, strict schema, key rotation, trimming, the final round;
  - the store contract against both in-memory and real Postgres.
- **Live runs on Groq and Tavily:**
  - search with a citation, with the claim saved to Postgres;
  - "what did I ask on 3 November" with links back to both turns;
  - a recheck on the demo week producing a verdict table and a bottom line that matches it;
  - an honest "I could not verify" when the pricing page snippets showed no price.
- `npm run eval` runs scenario suites (core and red-team) against the real APIs, 3 repeats each.

## Differences from the original plan

1. **Provider SDKs instead of LangChain chat wrappers.** Groq is the default and Anthropic is optional. LangGraph still runs the control flow.
2. **A recheck with ≤3 entities uses one searcher call**, not the writer searching itself, because the verdicts must exist before the writer explains them.
3. **Postgres instead of JSONL files**, as requested. Setup gains one step (`npm run db:up`) beyond `npm install` → `npm run dev`.
4. **Vendor-domain searches are not date-filtered** (see the table above).
5. **This document is longer than one page.** It records the build as well as the design.

## Known limits and next steps

- **Identity is per browser.** With no login, a person's chats are grouped by a browser-held ID: another browser or a cleared localStorage starts a new memory. A real login would replace that ID and nothing else.

- **Pricing in snippets.** Vendor-domain searches already ask Tavily for the page text (`raw_content`, up to 8,000 characters), but prices on JavaScript-rendered pricing pages are often missing from it, and Brave returns snippets only. So many price rechecks honestly end in `could-not-verify`. Next step: render vendor pricing pages, with change detection against stored values.
- **English only.** The memory, recheck and date patterns are English. A question in another language (e.g. Hinglish) still gets its dates and recall, but whether it is a memory question is left to the router model.
- **Untuned recall.** The recall threshold (0.12) and margin (0.04) haven't been tuned yet. Next step: tune them on the eval suite and a LongMemEval sample.
- **Long conversations.** These would need observer/reflector notes, added only beyond a token threshold.
- **Model routing.** Compare model choices per route on cost, latency and pass rate.
