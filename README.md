# Mimo

A chat agent with exactly one tool, **web search**, that answers questions about time correctly:

- *"What did I ask on 3 November?"*
- *"What did we talk about last Tuesday?"*
- *"Has anything changed with those prices since Monday?"*

The model writes the answers. **Code** works out what "Monday" means in your time zone, finds the earlier messages, checks citations and numbers, and decides whether something really changed. Why it is built this way, and what we ran into along the way, is in **[DESIGN.md](DESIGN.md)**.

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
    logic["<b>time.ts · recall.ts · guards.ts</b><br/>dates, memory, checks<br/>(plain code, no model)"]
    models["<b>models.ts</b><br/>Anthropic adapter<br/>effort per tier · refusal fallback"]
    search["<b>search.ts</b><br/>Tavily (Brave optional)<br/>10-min cache, retries"]
    store["<b>store.ts</b><br/>PgStore"]
  end

  claude[("Anthropic API<br/>claude-opus-5-5")]
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
| Time | `src/time.ts` | Turns date phrases into a date window and an ordered list of candidate days, always in the user's own time zone. |
| Recall | `src/recall.ts` | Finds earlier turns **across all of this user's chats**: exact lookup by day, or keyword (TF-IDF) ranking within a date window. Tries every candidate day first ("last Tuesday" → two Tuesdays), then widens the window up to three times when the match is weak. |
| Guards | `src/guards.ts` | The "no record" reply, citation links, the number check, the date-window filter, and verdict checks with the table and bottom line. |
| Models | `src/models.ts` | The Anthropic adapter: `claude-opus-5-5`, effort low / medium / high per tier, structured outputs, a streamed tool loop, and server-side refusal fallback. |
| Search | `src/search.ts` | The single `web_search` tool, backed by Tavily (Brave optional), with a 10-minute cache, timeouts and retries. |
| Prompts | `src/prompts.ts` | The router, writer, verdict and extraction prompts, and the context blocks that code builds for each turn. |
| Store | `src/store.ts` | Postgres (`turns`, `claims`) behind a `Store` interface. An in-memory version with the same contract is used for tests. |

Colours in both diagrams: **grey** is plain code, **blue** is a model call, **orange** is an external service or data store.

---

## Workflow: what happens to one message

This is the graph implemented in `src/graph.ts`.

![Turn workflow](docs/workflow.png)

1. **ingest** — The server stamps the turn with its own time and a sequence number, and works out the user's local calendar day from the browser's IANA time zone. At 00:20 in Kolkata, "today" is already the new day.
2. **resolve_dates** — Turns phrases like "since Monday", "last Tuesday", "3/11", "in August" or "a while ago" into a date window plus candidate days, using fixed rules (see DESIGN.md).
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

Diagram sources are `docs/workflow.mmd` and `docs/architecture.mmd` (Mermaid).

---

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `MIMO_DATABASE_URL` | Postgres for history. The default points at the Docker container (`postgres://mimo:mimo@localhost:5433/mimo`). It is deliberately not `DATABASE_URL`, so a value exported for another project is never used. |
| `ANTHROPIC_API_KEY` | Claude API key (an `ant auth login` profile also works) |
| `MODEL_FAST` / `MODEL_MAIN` / `MODEL_DEEP` | Optional model per tier. Default `claude-opus-5-5` for all three. |
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
| `npm test` | 94 tests: date rules, recall, guards, graph routes, server reliability, store contract. Uses a fake model and fake search, so no keys are needed. The store contract also runs against Postgres when `MIMO_DATABASE_URL` is set (it is read from `.env`), so run `npm run db:up` first; with no `MIMO_DATABASE_URL` those 5 tests are skipped. |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run eval` | Scenario suites against the real model and search, 3 repeats each. Reports pass rate and median / p90 turn time. |
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
