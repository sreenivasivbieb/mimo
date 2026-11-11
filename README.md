# Mimo

A chat agent with exactly one tool, **web search**, that answers questions about time correctly:

- *"What did I ask on 3 November?"*
- *"What did we talk about last Tuesday?"*
- *"Has anything changed with those prices since Monday?"*

The model writes the answers. **Code** decides everything that must be right: a fast model works out what "Monday" means from today's date in your time zone and code checks those dates (with fixed rules as the fallback); code finds the earlier messages, checks citations and numbers, and decides whether something really changed. How each part is designed, and why, is in **[DESIGN.md](DESIGN.md)**.

---

## Quick start

```bash
cp .env.example .env     # add ANTHROPIC_API_KEY and TAVILY_API_KEY
npm install
npm run db:up            # Postgres in Docker on localhost:5433 — conversation history lives here
npm run dev              # http://localhost:3000
```

Requirements: Node 20+ and Docker. There is no build step and there are no native modules.



The first start creates the tables automatically. To try the time and memory features, chat with Mimo for a bit, then ask:

- "What did we discuss in our previous conversation?" — Mimo lists the days and chats it has and asks which day.
- "Did we discuss <something you asked about>?" — the answer links into the chat where it came up.
- "Has anything changed with <that topic> since <the day you asked>?" — a recheck of the claims Mimo made then.
- "What did I ask on <a day with no messages>?" — an honest "no record", plus the days that do have messages.

---

## Architecture

```mermaid
flowchart LR
  subgraph browser["Browser"]
    ui["<b>public/index.html</b><br/>chat page · sends time zone + locale<br/>renders citations and sources"]
  end

  subgraph server["Node server · npm run dev"]
    http["<b>server.ts</b><br/>POST /api/chat → SSE stream<br/>GET /api/history"]
    runs["<b>run registry</b><br/>idempotent turn IDs<br/>new message aborts the old run"]
    turngraph["<b>graph.ts</b><br/>LangGraph turn graph"]
    logic["<b>time.ts · recall.ts · guards.ts</b><br/>date math, memory, checks<br/>(plain code)"]
    models["<b>models.ts</b><br/>Anthropic adapter<br/>effort per tier · refusal fallback"]
    search["<b>search.ts</b><br/>Tavily (Brave optional)<br/>10-min cache, retries"]
    store["<b>store.ts</b><br/>PgStore"]
  end

  claude[("Anthropic API<br/>claude-opus-5-5 · claude-haiku-5-5")]
  tavily[("Tavily API")]
  pg[("Postgres · Docker<br/>turns · claims")]

  ui -- "message + turn ID" --> http
  http -- "status · sources · token · note · done" --> ui
  http --> runs --> turngraph
  turngraph --> logic
  turngraph --> models --> claude
  turngraph --> search --> tavily
  turngraph --> store --> pg

  classDef code fill:#f4f4f5,stroke:#71717a,color:#18181b
  classDef model fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
  classDef data fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  class http,runs,turngraph,logic,search,store code
  class models model
  class claude,tavily,pg data
```

| Part | File | What it does |
|---|---|---|
| Chat page | `public/index.html` | Sends each message with a turn ID, a per-browser **user ID**, the time zone and the locale. Streams the reply and shows live search status, sources with page dates, and citation links. A link to a turn in another chat opens that chat at that turn. |
| HTTP server | `src/server.ts` | `POST /api/chat` answers over Server-Sent Events, and `GET /api/history` returns past turns. It also keeps one active run per conversation: a retried turn ID gets the stored answer, and a new message cancels the old run. Messages are limited to 4,000 characters. |
| Turn graph | `src/graph.ts` | The LangGraph state graph that every message runs through (diagram below). |
| Time | `src/time.ts` | Turns a date phrase into a date window and an ordered list of candidate days, always in the user's own time zone. Claude Haiku works out the exact dates first; these rules check its arithmetic and are the fallback (see `resolve_dates` below). |
| Recall | `src/recall.ts` | Finds earlier turns **across all of this user's chats**: exact lookup by day, or keyword (TF-IDF) ranking within a date window. Tries every candidate day first ("last Tuesday" → two Tuesdays), then widens the window up to three times when the match is weak. |
| Guards | `src/guards.ts` | The "no record" reply, citation links, the number check, the date-window filter, and verdict checks with the table and bottom line. |
| Models | `src/models.ts` | The Anthropic adapter: `claude-haiku-5-5` for reading date phrases, `claude-opus-5-5` (effort low / medium / high) for everything else; structured outputs, a streamed tool loop, and server-side refusal fallback (not on Haiku, which has none). |
| Search | `src/search.ts` | The single `web_search` tool, backed by Tavily (Brave optional), with a 10-minute cache, timeouts and retries. |
| Prompts | `src/prompts.ts` | The router, writer, verdict and extraction prompts, and the context blocks that code builds for each turn. |
| Store | `src/store.ts` | Postgres (`turns`, `claims`) behind a `Store` interface. An in-memory version with the same contract is used for tests. |

Colours in both diagrams: **grey** is plain code, **blue** is a model call, **orange** is an external service or data store.

---

## Workflow: what happens to one message

This is the graph implemented in `src/graph.ts`.

```mermaid
flowchart TD
  msg(["User message<br/>+ turn ID · time zone · locale"]) --> ingest

  ingest["<b>ingest</b> · code<br/>server timestamp + sequence<br/>user's local calendar day"] --> resolve
  resolve["<b>resolve_dates</b><br/>Claude Haiku works out the exact dates from today (4 s limit),<br/>code checks them against time.ts rules<br/>(rules alone if the model fails, is slow or is wrong)"] --> recall
  recall["<b>recall</b> · code<br/>reads this user's earlier chats (Postgres)<br/>exact day lookup or topic ranking<br/>widens the window up to 3×"] --> router

  router{"<b>router</b><br/>regex pre-checks,<br/>else fast model"}
  router -- "smalltalk · clarify · search" --> synth
  router -- "memory_only" --> when{"date<br/>given?"}
  when -- "no, several days" --> whichday["<b>which day?</b> · code<br/>lists days + chats we have;<br/>the reply's date is applied<br/>to the original question"]
  when -- "yes / one day / topic" --> gate{"anything<br/>recalled?"}
  gate -- "yes" --> synth
  gate -- "no" --> norecord["<b>abstention gate</b> · code<br/>fixed 'no record' reply<br/>lists the days we have"]
  router -- "recheck" --> fan{"how many<br/>entities?"}
  fan -- "≤ 3" --> one["<b>searcher</b> ×1<br/>one call covers all entities<br/>calls web_search (Tavily)"]
  fan -- "> 3" --> many["<b>searcher</b> ×N<br/>LangGraph Send fan-out<br/>calls web_search (Tavily)"]
  one --> verdicts
  many --> verdicts
  verdicts["<b>verdicts</b><br/>model proposes held / changed /<br/>corrected / could-not-verify,<br/>code checks every one"] --> synth

  synth["<b>synthesize</b><br/>one writer call, streamed to the browser<br/>search route calls web_search itself"] --> guards
  norecord --> guards
  whichday --> guards
  guards["<b>guards</b> · code<br/>citations → links · number check<br/>budget and downgrade notes"] --> store
  store["<b>store</b> · code<br/>writes the finished turn to Postgres"] --> done(["SSE 'done'<br/>reply complete"])
  store --> extract["<b>extract_claims</b><br/>facts for future rechecks → Postgres<br/>(after the reply is shown)"]

  classDef code fill:#f4f4f5,stroke:#71717a,color:#18181b
  classDef model fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
  classDef edge fill:#ecfdf5,stroke:#059669,color:#064e3b
  class ingest,recall,guards,store,gate,fan,norecord,when,whichday code
  class resolve,router,one,many,verdicts,synth,extract model
  class msg,done edge
```

1. **ingest** — The server stamps the turn with its own time and a sequence number, and works out the user's local calendar day from the browser's IANA time zone. At 00:20 in Kolkata, "today" is already the new day.
2. **resolve_dates** — Turns phrases like "since Monday", "last Tuesday", "3/11", "in August" or "a month ago" into a date window plus candidate days. **Claude Haiku 5.5**, the fastest model, is given **today's date** (in the user's time zone) and their date order, and returns the **exact dates** the message refers to ("last Monday" → `2026-11-09`, with `2026-11-02` as the backup candidate), in the same form the `time.ts` rules produce, so every later step uses them unchanged. It also says whether the time is about our conversation or about the world. Code then checks the dates: they must be real, a past conversation can't be in the future, and wherever `time.ts` understands the same words it recomputes them, and its dates win on a disagreement. Phrases the rules can't read ("two Mondays ago", "in 2025", "since the 1st") use the model's dates. This also keeps "monday.com", "after 3.11" or "before a job interview" from being read as dates. If the model fails, takes longer than 4 seconds, or returns dates that fail the checks, the rules run on the whole message. Greetings, messages with no time words, and memory questions whose date the rules already read skip the model (see DESIGN.md).
3. **recall** — Looks up earlier turns in Postgres, across **every chat this user has had**, not just the open one. A pure date question ("what did I ask on 3 November?") is an exact day lookup. A topic question ranks turns inside the window, and widens the window if the best match is weak or too close to call.
4. **router** — Picks one of five routes. Obvious cases (greetings, "what did I ask…") are caught by regex, with no model call. Everything else goes to a fast model that returns structured JSON.
   - `smalltalk`, `clarify` and `search` go straight to the writer.
   - `memory_only` goes to the writer only if something was recalled. Otherwise the **abstention gate** replies "I have no record of that" and lists the days we do have.
   - A memory question with **no date and no topic** ("what did we discuss in our previous conversation?") gets a **which-day** reply from code: the days with messages, each with its chats. The user's next message ("3 November") is applied to the original question.
   - `recheck` loads the claims we made earlier, then runs **searchers**: one call covering all entities if there are 3 or fewer, otherwise one searcher per entity in parallel (LangGraph `Send`). Before the searcher model runs, code has already run one search per entity on the vendor's own site, plus a news search from the baseline day when the question also asks about launches ("…or shipped something big since?").
5. **verdicts** (recheck only) — The model proposes a verdict for each stored claim: `held`, `changed`, `corrected` or `could-not-verify`, with source IDs as evidence. Code then checks each one against the source text and page dates. Anything unsupported becomes `could-not-verify`.
6. **synthesize** — One writer call, streamed token by token. On the `search` route the writer calls `web_search` itself. On rechecks, code shows the verdict table first, the model explains it, and code adds the bottom line.
7. **guards** — `[S3]` tags become real links, and unknown tags are removed. Prices and percentages are checked against the cited page text. Budget and downgrade notes are shown to the user.
8. **store** — The finished turn is written to Postgres, and the browser gets `done`.
9. **extract_claims** — After the reply is shown, the facts it cited are saved for future rechecks. On a recheck, new claims come only from verdicts that code has checked.

Both diagrams are Mermaid, so GitHub renders them. The sources are `docs/workflow.mmd` and `docs/architecture.mmd`.

---

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `MIMO_DATABASE_URL` | Postgres for history. The default points at the Docker container (`postgres://mimo:mimo@localhost:5433/mimo`). It is deliberately not `DATABASE_URL`, so a value exported for another project is never used. |
| `ANTHROPIC_API_KEY` | Claude API key (an `ant auth login` profile also works) |
| `MODEL_TIME` | Optional model for reading date phrases. Default `claude-haiku-5-5`. |
| `MODEL_FAST` / `MODEL_MAIN` / `MODEL_DEEP` | Optional model per tier (router and extraction / writer / recheck). Default `claude-opus-5-5` for all three. |
| `TAVILY_API_KEY` (or `BRAVE_API_KEY`) | Web search |
| `AGENT_TZ` | Fallback time zone if the browser sends none |
| `PORT` | HTTP port, default 3000 |
| `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` | Optional LangSmith tracing of graph nodes (read by LangChain itself) |

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server and chat page |
| `npm run db:up` / `npm run db:down` | Start or stop the Postgres container (data stays in the `mimo-pg` volume) |
| `npm test` | 121 tests: date rules and the checks on model dates, time reading and its fallbacks, recall, guards, graph routes, server reliability, store contract. Uses a fake model and fake search, so no keys are needed. The store contract also runs against Postgres when `MIMO_DATABASE_URL` is set (it is read from `.env`), so run `npm run db:up` first; with no `MIMO_DATABASE_URL` those 5 tests are skipped. |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run eval` | Scenario suites (core, time, red-team) against the real model and search, 3 repeats each. Reports pass rate and median / p90 turn time. |
| `npm run brief` | Seed three earlier chats for user `brief` in Postgres, then ask the three sample questions from new chats against the real model and search, printing each answer (needs keys) |

Inspect the data directly with `docker exec -it mimo-postgres psql -U mimo -d mimo`.

---

## Project layout

```
src/
  server.ts    HTTP, SSE, turn IDs, abort handling
  graph.ts     LangGraph nodes, edges, Send fan-out
  time.ts      time zones, date-phrase rules, windows
  recall.ts    day lookup, topic ranking, widen loop
  guards.ts    abstention, citations, numbers, date window, verdicts
  models.ts    Anthropic adapter (Claude)
  search.ts    SearchProvider: Tavily, Brave, cache
  prompts.ts   prompts and per-turn context blocks
  store.ts     Store interface: Postgres + in-memory
  types.ts     records and events
public/        chat page
docs/          diagrams (PNG + Mermaid source)
test/          unit, graph, reliability and adapter tests
eval/          scenario runner, sample history (seed.ts), sample-question run (brief.ts)
```
