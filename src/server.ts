// node:http + SSE. Turn IDs make retries idempotent; one active run per conversation.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runTurn, type Deps } from './graph.js';
import { modelFromEnv } from './models.js';
import { searchFromEnv } from './search.js';
import { storeFromEnv, type Store } from './store.js';
import { localDay, safeZone } from './time.js';
import type { AgentEvent, Turn } from './types.js';

try {
  process.loadEnvFile('.env');
} catch {}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

type Run = { turnId: string; controller: AbortController; events: AgentEvent[]; listeners: Set<(e: AgentEvent) => void>; finished: boolean };

export function createApp(deps: Omit<Deps, 'emit' | 'signal'> & { store: Store }) {
  const active = new Map<string, Run>(); // convId -> run in flight

  const sse = (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    return (e: AgentEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };

  /** Stream a run's buffered and future events to one response until `done` or `error`. */
  function attach(run: Run, res: ServerResponse) {
    const send = sse(res);
    const listener = (e: AgentEvent) => {
      send(e);
      if (e.type === 'done' || e.type === 'error') {
        run.listeners.delete(listener);
        res.end();
      }
    };
    for (const e of run.events) listener(e);
    if (res.writableEnded) return;
    run.listeners.add(listener);
    res.on('close', () => run.listeners.delete(listener)); // the run keeps going; a reconnect with the same turn ID re-attaches
  }

  async function chat(req: IncomingMessage, res: ServerResponse) {
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const convId = String(body.convId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const turnId = String(body.turnId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const text = String(body.text ?? '').trim();
    const userId = String(body.userId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || undefined;
    if (!convId || !turnId || !text) return json(res, 400, { error: 'convId, turnId and text are required' });
    if (text.length > 4000) return json(res, 400, { error: 'message too long (max 4000 characters)' });

    // Idempotent: a retried or double-sent turn gets the stored result or re-attaches to the live run.
    const stored = await deps.store.getTurn(convId, turnId);
    if (stored?.status === 'complete') {
      const send = sse(res);
      send({ type: 'sources', sources: stored.sources.map(({ id, url, title, pageDate }) => ({ id, url, title, pageDate })) });
      send({ type: 'token', text: stored.assistant ?? '' });
      send({ type: 'done', turnId, route: stored.route, day: stored.localDay });
      return res.end();
    }
    const current = active.get(convId);
    if (current && current.turnId === turnId && !current.finished) return attach(current, res);
    // A new message aborts the old run; its turn is stored as cancelled.
    if (current && !current.finished) current.controller.abort();

    // Chats started before user IDs existed join this user, so they show up in cross-chat recall:
    // this chat, plus every other chat this browser remembers using.
    if (userId) {
      const known = Array.isArray(body.knownConvs) ? body.knownConvs.map((c: unknown) => String(c).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)).filter(Boolean).slice(0, 50) : [];
      for (const c of new Set([convId, ...known])) await deps.store.adoptConversation(c, userId);
    }
    const tz = safeZone(body.tz);
    const now = new Date();
    const turn: Turn = {
      id: turnId, convId, userId, seq: await deps.store.nextSeq(convId), ts: now.toISOString(), tz, localDay: localDay(now, tz),
      user: text, route: 'search', status: 'complete', sources: [], evidence: [],
    };
    const run: Run = { turnId, controller: new AbortController(), events: [], listeners: new Set(), finished: false };
    active.set(convId, run);
    const emit = (e: AgentEvent) => {
      run.events.push(e);
      for (const l of [...run.listeners]) l(e);
    };
    attach(run, res);
    emit({ type: 'status', text: 'Thinking…' });

    const started = Date.now();
    try {
      await runTurn({ ...deps, emit, signal: run.controller.signal }, { turn, locale: String(body.locale ?? 'en-US') });
      deps.log?.(`[turn] ${turnId} total ${Date.now() - started}ms`);
    } catch (err) {
      const done = (await deps.store.getTurn(convId, turnId).catch(() => undefined))?.status === 'complete';
      if (!done) {
        const cancelled = run.controller.signal.aborted;
        await deps.store.putTurn({ ...turn, status: cancelled ? 'cancelled' : 'error' }).catch((e) => deps.log?.(`[db] could not store ${turnId}: ${e.message}`));
        deps.log?.(`[turn] ${turnId} ${cancelled ? 'cancelled' : 'error'}: ${(err as Error).message}`);
        emit({ type: 'error', message: cancelled ? 'Stopped: a newer message replaced this one.' : friendly(err) });
      } else {
        deps.log?.(`[turn] ${turnId} post-reply step failed: ${(err as Error).message}`);
      }
    } finally {
      run.finished = true;
      if (active.get(convId) === run) active.delete(convId);
    }
  }

  async function history(url: URL, res: ServerResponse) {
    const convId = (url.searchParams.get('convId') ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!convId) return json(res, 400, { error: 'convId required' });
    const turns = (await deps.store.turns(convId)).map(({ id, user, assistant, status, localDay, ts, route, sources }) => ({
      id, user, assistant, status, localDay, ts, route, sources: sources.map(({ id, url, title, pageDate }) => ({ id, url, title, pageDate })),
    }));
    json(res, 200, { turns });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(join(root, 'public', 'index.html')));
      }
      if (req.method === 'GET' && url.pathname === '/api/history') return await history(url, res);
      if (req.method === 'POST' && url.pathname === '/api/chat') return await chat(req, res);
      json(res, 404, { error: 'not found' });
    } catch (err) {
      deps.log?.(`[server] ${(err as Error).stack}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    }
  });
}

function friendly(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/api[_ -]?key|authentication|401|credential/i.test(msg)) return 'The model provider rejected the credentials. Check ANTHROPIC_API_KEY in .env.';
  if (/429|rate/i.test(msg)) return 'The model provider is rate-limiting us. Please try again in a moment.';
  if (/timeout|timed out|ETIMEDOUT|ECONN/i.test(msg)) return 'A provider took too long to respond. Please try again.';
  return `Something went wrong: ${msg.slice(0, 200)}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Start when run directly (npm run dev), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  const search = searchFromEnv();
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[mimo] ANTHROPIC_API_KEY is not set — add it to .env (or sign in with `ant auth login`).');
  if (search.name === 'none') console.warn('[mimo] No search key — set TAVILY_API_KEY (or BRAVE_API_KEY) in .env.');
    let store: Store;
  try {
    store = storeFromEnv();
    await store.days('_healthcheck'); // fail fast if Postgres is unreachable
  } catch (e) {
    const err = e as Error & { code?: string };
    console.error(`[mimo] database unreachable (${err.message || err.code || String(e)}). Is Postgres up? Try \`npm run db:up\`.`);
    process.exit(1);
  }
  createApp({ model: modelFromEnv(), search, store, log: (l) => console.log(l) }).listen(port, () => {
    console.log(`[mimo] http://localhost:${port}  (db: postgres, search: ${search.name}, model: ${process.env.MODEL_MAIN || 'claude-opus-5-5'})`);
  });
}
