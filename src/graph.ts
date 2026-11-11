// The turn graph: code steps for time and memory around a router, research and one writer call.
//
//   ingest → resolve_dates → recall → router ─┬─ smalltalk / memory_only / clarify / search ─→ synthesize
//                                             └─ recheck → searcher ×N (Send) → verdicts ──→ synthesize
//   synthesize → guards → store (reply done) → extract_claims → END
import { Annotation, END, Send, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { CitationResolver, bottomLine, checkVerdict, filterByWindow, noRecordReply, normalizeTags, numberGuard, sourceShows, verdictTable, whichDayReply } from './guards.js';
import type { Model, Tier, ToolCall, Usage } from './models.js';
import {
  EXTRACT_SYSTEM, ExtractSchema, ROUTE_INSTRUCTIONS, ROUTER_SYSTEM, RouterSchema, SEARCHER_SYSTEM, VERDICT_SYSTEM, VerdictSchema, WRITER_SYSTEM,
  historyMessages, sourceList, turnContext,
} from './prompts.js';
import { recall as runRecall, terms, topicWords, type RecallMode } from './recall.js';
import type { SearchProvider, SearchResult } from './search.js';
import { claimId, normEntity, type Store } from './store.js';
import { dayLabel, localDay, resolveDates } from './time.js';
import type { Claim, Emit, Finding, Flag, Recall, Resolved, Route, Source, Turn, VerdictRow } from './types.js';

// ---------- per-run dependencies (not graph state) ----------

export const LIMITS = { maxFanout: 8, searcherTimeoutMs: 90_000, searcherRounds: 3, writerRounds: 4, historyTurns: 12, routerContextTurns: 4 };

/** Assigns S# IDs across parallel searchers and dedupes by URL. */
export class SourceRegistry {
  readonly byId = new Map<string, Source>();
  private byUrl = new Map<string, Source>();
  add(r: SearchResult): Source {
    const seen = this.byUrl.get(r.url);
    if (seen) {
      if (r.excerpt.length > seen.excerpt.length) Object.assign(seen, { excerpt: r.excerpt, complete: r.complete });
      seen.pageDate ??= r.pageDate;
      return seen;
    }
    const s: Source = { id: `S${this.byId.size + 1}`, ...r };
    this.byId.set(s.id, s);
    this.byUrl.set(s.url, s);
    return s;
  }
}

export type Deps = {
  model: Model;
  search: SearchProvider;
  store: Store;
  emit: Emit;
  signal?: AbortSignal;
  log?: (line: string) => void;
};

type RunCtx = Deps & {
  registry: SourceRegistry;
  turnTags: Map<string, { id: string; day: string; convId: string }>; // T# -> turn
  pool: Turn[]; // turns that memory questions may draw on (all of this user's conversations)
  resolver: CitationResolver;
  budget: { left: number; total: number };
};

const ctxOf = (config: LangGraphRunnableConfig): RunCtx => (config.configurable as { ctx: RunCtx }).ctx;

// ---------- state ----------

const concat = <T>() => ({ reducer: (a: T[], b: T[]) => a.concat(b), default: (): T[] => [] });

export const State = Annotation.Root({
  turn: Annotation<Turn>(),
  locale: Annotation<string>(),
  resolved: Annotation<Resolved>(),
  recallMode: Annotation<RecallMode | null>(),
  askDate: Annotation<boolean>(), // a memory question with no date and several days to choose from
  recalled: Annotation<Recall>(),
  route: Annotation<Route>(),
  entities: Annotation<string[]>(),
  queries: Annotation<string[]>(),
  domains: Annotation<string[]>(),
  baselineDay: Annotation<string | undefined>(),
  claims: Annotation<Claim[]>(),
  task: Annotation<string[] | undefined>(), // entities for one searcher (Send payload)
  findings: Annotation<Finding[]>(concat<Finding>()),
  verdictRows: Annotation<VerdictRow[]>(),
  answer: Annotation<string>(), // raw, with [S#]/[T#] tags
  display: Annotation<string>(), // what the user saw
  flags: Annotation<Flag[]>(concat<Flag>()),
});
type S = typeof State.State;
type U = typeof State.Update;

// ---------- helpers ----------

function logUsage(ctx: RunCtx, what: string, started: number, u?: Usage) {
  ctx.log?.(`[node] ${what} ${Date.now() - started}ms${u ? ` in=${u.input} out=${u.output} cache=${u.cacheRead}` : ''}`);
}

const SMALLTALK = /^\s*(hi|hello|hey|yo|hiya|thanks|thank you|thx|ok|okay|cool|great|nice|good (morning|afternoon|evening|night)|bye|goodbye|how are you)\b[\s!.?,a-z]{0,20}$/i;
// Verbs people use about the conversation itself, in any tense ("discuss", "discussed", "researched").
const MEM_VERB = '(?:ask|say|said|tell|told|answer|talk|discuss|mention|search|research|look(?:ed)? up|bring up|brought up|cover|chat|speak|spoke)\\w*';
const PAST_VERB = '(?:asked|said|told|talked|discussed|mentioned|searched|researched|looked up|brought up|covered|chatted|spoke|answered)';
// "what did I ask…", "what topics we discussed…" (past tense only: "what can you search?" is a new request).
const ASK_HISTORY = new RegExp(`\\b(what|which)\\b.{0,40}\\b(?:(?:did|have|had)\\s+(?:i|we|you)\\s+(?:ever\\s+|already\\s+)?${MEM_VERB}|(?:i|we|you)\\s+(?:ever\\s+|already\\s+)?${PAST_VERB})|\\bwhat (was|were) my (question|message)s?\\b`, 'i');
// "Did we discuss X?" / "have I ever mentioned X?": a scan of every turn, answered yes (with links) or "no mention".
const ABSENCE = new RegExp(`^\\s*(did|have|had)\\s+(i|we|you)\\s+(ever\\s+|already\\s+)?${MEM_VERB}`, 'i');
// A reply that talks about our past conversation without citing a recalled turn is making it up.
const CLAIMS_PAST = /\b(we|you|i)\s+(might|may|probably|likely|must|could)?\s*(have\s+)?(already\s+|previously\s+|earlier\s+)?(discussed|talked|asked|researched|searched|mentioned|said|covered|looked up)\b/i;
// "Is your answer still correct?", "has any of them changed pricing since?", "shipped anything big since then?"
const RECHECK = /\b(still (correct|true|valid|accurate|right|current|the case|the same|hold|holds|apply|applies|good)|(gone|went) (up|down)|(anything|what('s| has)?) (changed|new)|any (changes|updates)|re-?check|up to date|out of date)\b|\b(chang|updat|ship|launch|releas|rais|increas|drop|cut)\w*\b.{0,80}\bsince\b|\bsince\b.{0,80}\b(chang|updat|ship|launch|releas)\w*/i;
// Words that only say "has it changed?" — on a recheck question they are not the topic to recall
// ("is it still accurate?" is not a search for turns that mention "accurate").
const RECHECK_WORDS = /\b(still|correct|true|valid|accurate|right|current|case|same|holds?|appl(y|ies)|good|chang\w*|updat\w*|ship\w*|launch\w*|releas\w*|rais\w*|increas\w*|drop\w*|cut|since|then|gone|went|up|down|new|big|date|re-?check|pric(e|es|ing))\b/gi;
// The question also asks about launches or news, not just whether stored values held.
const ASKS_LAUNCHES = /\b(ship|launch|releas|announc|unveil|roll(ed|s|ing)? out)\w*|\bnew (feature|product)s?\b/i;
const REFERS_BACK = /\b(you said|you told|earlier|before|last time|those|them|that answer|your answer|previous|i asked)\b/i;

function nowLabel(iso: string, tz: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/** Runs the model's web_search calls in parallel against the budget, registering every result. */
async function runSearches(ctx: RunCtx, s: S, calls: ToolCall[], defaults: { startDate?: string }): Promise<string[]> {
  const Input = z.object({ query: z.string().min(1), domains: z.array(z.string()).optional(), start_date: z.string().optional(), end_date: z.string().optional() });
  const window = s.route === 'search' ? s.resolved.window : null;
  return Promise.all(
    calls.map(async (c) => {
      if (c.name !== 'web_search') return `Unknown tool ${c.name}.`;
      const parsed = Input.safeParse(c.input);
      if (!parsed.success) return `Invalid web_search input: ${parsed.error.message}`;
      if (ctx.budget.left <= 0) return 'Search budget for this turn is used up. Answer with what you have and say what you could not check.';
      ctx.budget.left--;
      const q = parsed.data;
      // Date-bounded: explicit dates only, never a relative range. Vendor pages (pricing, plans) are
      // usually undated and a date filter hides them, so domain-restricted queries get no dates at all.
      const vendor = Boolean(q.domains?.length);
      const startDate = vendor ? undefined : q.start_date ?? defaults.startDate ?? window?.start;
      const endDate = vendor ? undefined : q.end_date ?? (window && window.end < s.turn.localDay ? window.end : undefined);
      ctx.emit({ type: 'status', text: `Searching: ${q.query}${q.domains?.length ? ` (${q.domains.join(', ')})` : ''}${startDate ? ` since ${startDate}` : ''}` });
      try {
        const results = await ctx.search.search({ query: q.query, domains: q.domains, startDate, endDate }, ctx.signal);
        const { kept, dropped } = filterByWindow(results, window);
        const sources = kept.map((r) => ctx.registry.add(r));
        if (sources.length) ctx.emit({ type: 'sources', sources: sources.map(({ id, url, title, pageDate }) => ({ id, url, title, pageDate })) });
        const note = dropped.length ? `\n(${dropped.length} result(s) dropped: page dates outside ${window!.start}..${window!.end})` : '';
        return (sources.length ? sourceList(sources, s.turn.localDay) : 'No results.') + note;
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return `Search failed: ${(e as Error).message}`;
      }
    }),
  );
}

/** The writer on a recheck sees only sources the verdicts or the researchers' notes refer to. */
function recheckSources(s: S, ctx: RunCtx): Source[] {
  const ids = new Set<string>([...(s.verdictRows ?? []).flatMap((r) => r.evidence)]);
  for (const f of s.findings) for (const m of f.summary.matchAll(/S\d+/g)) ids.add(m[0]);
  return [...ids].map((id) => ctx.registry.byId.get(id)).filter((x): x is Source => Boolean(x)).slice(0, 8)
    .map((x) => ({ ...x, excerpt: x.excerpt.slice(0, 400) }));
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
};

/** Up to 4 sources that mention a claim's entity or value, each cut to ~350 chars around the mention. */
function evidenceFor(c: Claim, sources: Source[]): { src: Source; passage: string }[] {
  const words = normEntity(c.entity).split(' ').filter((w) => w.length > 2);
  const nums = c.value.match(/\d+(?:\.\d+)?/g) ?? [];
  // The plan or field name ("professional", "launch", "end of life") pins the right passage on a page with many prices.
  const GENERIC = new Set(['price', 'pricing', 'per', 'seat', 'user', 'plan', 'month', 'monthly', 'the', 'and', 'for', 'version']);
  const attr = c.attribute.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
  const scored = sources
    .map((src) => {
      const hay = `${src.title} ${src.url} ${src.excerpt}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length * 2 + (hostOf(src.url) === hostOf(c.sourceUrl) ? 3 : 0);
      const lower = src.excerpt.toLowerCase();
      const esc = (x: string) => new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const at = [...attr.map(esc), ...nums.map(esc), ...words.map(esc), /[$€£₹]\s?\d/]
        .map((re) => lower.search(re))
        .find((i) => i >= 0) ?? 0;
      const passage = src.excerpt.slice(Math.max(0, at - 120), at + 230).replace(/\s+/g, ' ').trim();
      return { src, passage, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 4);
}

// ---------- nodes ----------

function ingest(s: S): U {
  // Server assigned id, seq and timestamp; "today" is the user's calendar day in their zone.
  return { turn: { ...s.turn, localDay: localDay(new Date(s.turn.ts), s.turn.tz) } };
}

function resolve_dates(s: S): U {
  return { resolved: resolveDates(s.turn.user, s.turn.localDay, s.locale) };
}

const isMemoryQuestion = (t: string) => ABSENCE.test(t) || ASK_HISTORY.test(t);
/** The part of a message that names what to recall: recheck vocabulary removed from recheck questions. */
const topicText = (t: string) => (RECHECK.test(t) ? t.replace(RECHECK_WORDS, ' ') : t);

async function recall(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const ctx = ctxOf(config);
  const notThis = (t: Turn) => !(t.id === s.turn.id && t.convId === s.turn.convId);
  const conv = (await ctx.store.turns(s.turn.convId)).filter(notThis);
  // Memory spans every conversation this user has had (the browser keeps one user ID); without one, just this chat.
  const pool = s.turn.userId ? (await ctx.store.turnsForUser(s.turn.userId)).filter(notThis) : conv;
  ctx.pool = pool;
  const daysAvailable = [...new Set(pool.filter((t) => t.status === 'complete').map((t) => t.localDay))].sort().reverse();

  let text = s.turn.user;
  let resolved = s.resolved;
  // A reply to our "which day?" question ("3 November", "yesterday") continues the question it answers.
  const last = conv.filter((t) => t.status === 'complete').at(-1);
  if (last?.route === 'clarify' && isMemoryQuestion(last.user) && !isMemoryQuestion(text)) {
    text = `${last.user} — ${text}`;
    ctx.log?.(`[recall] treating "${s.turn.user}" as the answer to "${last.user}"`);
  }

  let mode: RecallMode | null = null;
  let askDate = false;
  const query = topicText(text);
  const topic = terms(query).length > 0;
  if (isMemoryQuestion(text) && !resolved.window && !topic) {
    // "What did we talk about before?": no date, no topic. One day of history → use it; several → ask which.
    if (daysAvailable.length === 1) resolved = { window: { start: daysAvailable[0], end: daysAvailable[0], label: dayLabel(daysAvailable[0]) }, candidates: [daysAvailable[0]], vague: false, eventAnchored: false };
    else askDate = daysAvailable.length > 1;
    mode = 'day';
  } else if (ABSENCE.test(text)) mode = 'absence';
  else if (ASK_HISTORY.test(text) && resolved.window && !topic) mode = 'day';
  else if (ASK_HISTORY.test(text) && topic) mode = 'absence'; // "what did we discuss about IPL?" lists every mention
  else if (ASK_HISTORY.test(text) || RECHECK.test(text) || REFERS_BACK.test(text) || resolved.window) mode = 'topic';
  if (!mode) return { recallMode: null, askDate: false, recalled: { status: 'skipped', hits: [], widened: 0, daysAvailable } };
  if (askDate) return { recallMode: mode, askDate, resolved, recalled: { status: 'ask', hits: [], widened: 0, daysAvailable } };

  // Topic searches skip turns that were themselves questions about our history ("did we discuss IPL?")
  // and their answers: they mention the topic without being about it, and would drown the real turn.
  const about = (t: Turn) => t.route !== 'memory_only' && !isMemoryQuestion(t.user);
  const r = runRecall({ turns: mode === 'day' ? pool : pool.filter(about), query, resolved, mode, today: s.turn.localDay, daysAvailable });
  r.hits.forEach((h, i) => ctx.turnTags.set(`T${i + 1}`, { id: h.turn.id, day: h.turn.localDay, convId: h.turn.convId }));
  return { recallMode: mode, askDate, resolved, recalled: r };
}

async function router(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const ctx = ctxOf(config);
  const t0 = Date.now();
  const text = s.turn.user;
  let route: Route;
  let entities: string[] = [];
  let queries: string[] = [];
  let domains: string[] = [];

  // Deterministic pre-checks: obvious turns skip the model.
  // "Has X changed since…?" / "is your answer still correct?" about a turn we found is a recheck,
  // even when it also asks what was said ("what did I ask on 3 November? still correct?").
  const recheckOfFound = RECHECK.test(text) && s.recalled.status === 'found';
  if (SMALLTALK.test(text)) route = 'smalltalk';
  else if (!recheckOfFound && (s.recallMode === 'day' || s.recallMode === 'absence')) route = 'memory_only';
  else {
    const recalled = s.recalled.hits.slice(0, 5).map((h) => `- ${h.turn.localDay}: user asked "${h.turn.user.slice(0, 300)}"`).join('\n');
    // The last few exchanges, so follow-ups like "what it is" or "yes, Tavily" can be resolved.
    const recent = (await ctx.store.turns(s.turn.convId))
      .filter((t) => t.id !== s.turn.id && t.status === 'complete')
      .slice(-LIMITS.routerContextTurns)
      .map((t) => `User: ${t.user.slice(0, 200)}\nAssistant: ${(t.assistant ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
      .join('\n');
    const prompt = [
      `Today: ${s.turn.localDay}`,
      s.resolved.window ? `Date phrase resolved to ${s.resolved.window.start}..${s.resolved.window.end}` : '',
      recent ? `Recent conversation (oldest first):\n${recent}` : 'This is the first message of the conversation.',
      recalled ? `Recalled earlier turns:\n${recalled}` : '',
      `Turn to classify:\n${text}`,
    ].filter(Boolean).join('\n\n');
    try {
      const { value, usage } = await ctx.model.structured({ tier: 'fast', system: ROUTER_SYSTEM, prompt, schema: RouterSchema, signal: ctx.signal });
      ({ route, entities, queries, domains } = value);
      logUsage(ctx, 'router', t0, usage);
      if (recheckOfFound && route !== 'recheck') ctx.log?.(`[router] model said ${route}; recheck of a recalled answer wins`);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      route = 'search'; // safe default
      ctx.log?.(`[router] fell back to search: ${(e as Error).message}`);
    }
    // The model still names the entities and vendor domains; the route itself is decided here.
    if (recheckOfFound) route = 'recheck';
  }

  // Recheck: find the stored claims and the baseline they were made on.
  let claims: Claim[] = [];
  let baselineDay: string | undefined;
  const flags: Flag[] = [];
  if (route === 'recheck') {
    const hitIds = new Set(s.recalled.hits.map((h) => h.turn.id));
    // Claims from any of this user's conversations, so "those prices" works from a new chat too.
    const scope = s.turn.userId ? await ctx.store.claimsForUser(s.turn.userId) : await ctx.store.claims(s.turn.convId);
    claims = scope.filter((c) => hitIds.has(c.turnId));
    if (!claims.length && entities.length) claims = scope.filter((c) => entities.some((e) => normEntity(c.entity) === normEntity(e) || normEntity(c.entity).includes(normEntity(e)) || normEntity(e).includes(normEntity(c.entity))));
    // Keep only the latest value per entity+attribute.
    const latest = new Map<string, Claim>();
    for (const c of claims.sort((a, b) => a.day.localeCompare(b.day))) latest.set(`${normEntity(c.entity)}|${c.attribute}`, c);
    claims = [...latest.values()];
    // What we said is the authority on what to recheck: the claims' own entities ("HubSpot Sales Hub",
    // "Neon"), not the model's summary of the question ("5 CRM tools", "Postgres hosting").
    if (claims.length) entities = [...new Set(claims.map((c) => c.entity))];
    baselineDay = s.recalled.matchedDay ?? s.resolved.window?.start ?? claims.map((c) => c.day).sort().at(-1);
    if (!entities.length) route = 'clarify';
    else if (!claims.length) flags.push({ kind: 'info', message: 'No earlier values stored; reporting only dated announcements after the baseline.' });
  }
  if ((route === 'memory_only' || route === 'recheck') && s.recalled.status === 'ask') route = 'clarify';
  // Never ask twice in a row: if we just asked a clarifying question, this message is the answer.
  else if (route === 'clarify') {
    const last = (await ctx.store.turns(s.turn.convId)).filter((t) => t.id !== s.turn.id && t.status === 'complete').at(-1);
    if (last?.route === 'clarify') {
      route = 'search';
      ctx.log?.('[router] previous turn was a clarifying question; answering instead of asking again');
    }
  }
  ctx.log?.(`[router] route=${route} entities=${entities.length} recall=${s.recalled.status}`);
  if (route === 'recheck') {
    // One seeded search per entity (two when launches are asked about), plus room for follow-ups.
    const perEntity = ASKS_LAUNCHES.test(text) ? 2 : 1;
    const total = Math.min(perEntity === 2 ? 12 : 10, Math.max(6, entities.length * perEntity + 2));
    ctx.budget.left = ctx.budget.total = total;
  }
  return { route, entities, queries, domains, claims, baselineDay, flags };
}

function afterRouter(s: S): string | Send[] {
  if (s.route !== 'recheck') return 'synthesize';
  // ≤3 entities: one searcher covers them all (one call issuing parallel searches). More: one per entity, width capped.
  if (s.entities.length <= 3) return [new Send('searcher', { ...s, task: s.entities })];
  const groups: string[][] = Array.from({ length: Math.min(LIMITS.maxFanout, s.entities.length) }, () => []);
  s.entities.forEach((e, i) => groups[i % groups.length].push(e));
  return groups.map((g) => new Send('searcher', { ...s, task: g }));
}

async function searcher(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const ctx = ctxOf(config);
  const names = s.task ?? s.entities;
  const label = names.join(', ');
  const relevant = s.claims.filter((c) => names.some((n) => normEntity(n) === normEntity(c.entity) || normEntity(c.entity).includes(normEntity(n))));
  const prompt = [
    `Entities: ${label}`,
    `Baseline day: ${s.baselineDay ?? 'none'} (today is ${s.turn.localDay}).`,
    relevant.length ? `What we said earlier:\n${relevant.map((c) => `- ${c.entity} / ${c.attribute} = "${c.value}" (${c.day}, ${c.sourceUrl})`).join('\n')}` : 'We have no stored values; look for dated announcements after the baseline.',
    s.domains.length ? `Vendor domains: ${s.domains.join(', ')}` : '',
    `User asked: ${s.turn.user}`,
  ].filter(Boolean).join('\n\n');

  // Coverage first, in code: one focused search per entity on the vendor's own site, before the model
  // decides on follow-ups. (Left to itself the model spent three searches on one vendor and none on another.)
  const seedCalls: ToolCall[] = names.map((n, i) => {
    const c = relevant.find((x) => normEntity(x.entity) === normEntity(n)) ?? relevant.find((x) => normEntity(x.entity).includes(normEntity(n)));
    const host = c ? hostOf(c.sourceUrl) : undefined;
    return { id: `seed${i}`, name: 'web_search', input: { query: `${n} ${c?.attribute ?? 'pricing'}`, ...(host ? { domains: [host] } : {}) } };
  });
  // "…or shipped something big since?": vendor pricing pages are undated, so launches need their own
  // news search per entity, bounded at the baseline day (runSearches applies it as start_date).
  if (ASKS_LAUNCHES.test(s.turn.user)) names.forEach((n, i) => seedCalls.push({ id: `seedNews${i}`, name: 'web_search', input: { query: `${n} launch announcement` } }));
  const seeded = await runSearches(ctx, s, seedCalls, { startDate: s.baselineDay });
  const withSeeds = `${prompt}\n\nFirst results (one search per entity, already run for you):\n\n${seeded.join('\n\n')}\n\nSearch again only for an entity whose current value is still missing, or for a big launch.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const signal = AbortSignal.any([AbortSignal.timeout(LIMITS.searcherTimeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
    const seen = new Set(ctx.registry.byId.keys());
    try {
      const { text, usage } = await ctx.model.run({
        tier: 'main',
        system: SEARCHER_SYSTEM,
        messages: [{ role: 'user', content: withSeeds }],
        onToolCalls: (calls) => runSearches({ ...ctx, signal }, s, calls, { startDate: s.baselineDay }),
        maxRounds: 2, // follow-ups only; every entity already has a search
        signal,
      });
      logUsage(ctx, `searcher(${label})`, t0, usage);
      const sources = [...ctx.registry.byId.values()].filter((x) => !seen.has(x.id) || seeded.some((r) => r.includes(`[${x.id}]`)));
      return { findings: [{ entity: label, summary: text, sources }] };
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log?.(`[searcher] ${label} attempt ${attempt + 1} failed: ${(e as Error).message}`);
    }
  }
  return { findings: [{ entity: label, summary: '', sources: [], error: 'timed out or failed twice' }], flags: [{ kind: 'error', message: `Could not check ${label}.` }] };
}

async function verdicts(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const ctx = ctxOf(config);
  if (!s.claims.length) return { verdictRows: [] };
  const t0 = Date.now();
  const sources = [...ctx.registry.byId.values()];
  const baseline = s.baselineDay ?? s.turn.localDay;
  let proposed: z.infer<typeof VerdictSchema>['rows'] = [];
  try {
    // Compact on purpose: each claim with only the few sources about it, cut to the passage that
    // mentions it. Dumping every source blew the model's input limit and it then saw none of them.
    const perClaim = s.claims.map((c) => {
      const ev = evidenceFor(c, sources).map((x) => `    [${x.src.id}] ${x.src.url} — ${x.src.pageDate ? `page date ${x.src.pageDate}` : 'no page date'}: "${x.passage}"`);
      return `- id=${c.id} ${c.entity} / ${c.attribute} = "${c.value}" (said ${c.day})\n${ev.length ? ev.join('\n') : '    (no source mentions it)'}`;
    });
    const notes = s.findings.map((f) => `${f.entity}: ${f.error ? 'could not check' : f.summary.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n');
    const prompt = `Baseline day: ${baseline}. Today: ${s.turn.localDay}.\n\nClaims, each with the sources that mention it:\n${perClaim.join('\n')}\n\nResearcher notes:\n${notes}`;
    const { value, usage } = await ctx.model.structured({ tier: 'deep', system: VERDICT_SYSTEM, prompt, schema: VerdictSchema, signal: ctx.signal });
    proposed = value.rows;
    logUsage(ctx, 'verdicts', t0, usage);
    if (process.env.MIMO_DEBUG) for (const p of proposed) ctx.log?.(`[verdicts] proposed ${p.claimId} ${p.verdict} new=${p.newValue} ev=${p.evidence.join(',')}`);
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    ctx.log?.(`[verdicts] failed: ${(e as Error).message}`);
  }
  // Code checks every proposed verdict; anything missing or failing becomes could-not-verify.
  const rows: VerdictRow[] = s.claims.map((c) => {
    const p = proposed.find((r) => r.claimId === c.id);
    const evidence = (p?.evidence ?? []).map((id) => ctx.registry.byId.get(id)).filter((x): x is Source => Boolean(x));
    const checked = p ? checkVerdict(p.verdict, c, p.newValue, evidence, baseline) : { verdict: 'could-not-verify' as const, note: 'no verdict proposed' };
    // A different value that a cited page really shows is still worth showing, even when its page
    // has no date and so can't tell "changed" from "we were wrong": the verdict stays could-not-verify.
    const showing = p?.newValue && p.newValue !== c.value ? evidence.filter((e) => sourceShows(e, p.newValue!)) : [];
    const verified = checked.verdict !== 'could-not-verify';
    return {
      claimId: c.id, entity: c.entity, attribute: c.attribute, oldValue: c.value,
      newValue: (verified && checked.verdict !== 'held') || showing.length ? p?.newValue ?? undefined : undefined,
      verdict: checked.verdict,
      evidence: verified ? evidence.map((e) => e.id) : showing.map((e) => e.id),
      note: !verified && showing.length ? 'a current page shows a different value but has no usable date, so "changed" and "corrected" cannot be told apart' : checked.note ?? p?.note,
    };
  });
  const downgraded = rows.filter((r, i) => proposed.find((p) => p.claimId === s.claims[i].id && p.verdict !== r.verdict));
  return { verdictRows: rows, flags: downgraded.map((r) => ({ kind: 'guard' as const, message: `Downgraded ${r.entity} / ${r.attribute} to could-not-verify: ${r.note}` })) };
}

async function synthesize(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const ctx = ctxOf(config);
  const t0 = Date.now();
  const streams = s.route === 'smalltalk' || s.route === 'search' || s.route === 'recheck';
  let shown = '';
  const show = (raw: string) => {
    const out = ctx.resolver.push(raw);
    shown += out;
    if (streams && out) ctx.emit({ type: 'token', text: out });
  };

  // Abstention gate: a memory question with nothing recalled gets a fixed reply, no model call.
  const noRecord = () => noRecordReply(s.recalled, s.turn.localDay, s.resolved.window?.label, s.recallMode === 'absence' ? topicWords(topicText(s.turn.user)).join(' ') : undefined, Boolean(s.turn.userId));
  // "Which day?": asked by code, listing the days and conversations we have, so the reply is always grounded.
  if (s.route === 'clarify' && (s.askDate || (s.recallMode === 'day' && s.recalled.status === 'ask'))) {
    const answer = whichDayReply(s.askDate ? ctx.pool : s.recalled.hits.map((h) => h.turn), s.turn.localDay);
    ctx.emit({ type: 'token', text: answer });
    return { answer, display: answer };
  }
  if (s.route === 'memory_only' && s.recalled.status === 'none') {
    const answer = noRecord();
    ctx.emit({ type: 'token', text: answer });
    return { answer, display: answer };
  }

  let prefix = '';
  if (s.route === 'recheck' && s.verdictRows.length) {
    prefix = `${verdictTable(s.verdictRows)}\n\n`;
    show(prefix);
  }

  const recalledTags = new Map([...ctx.turnTags].map(([tag, t]) => [t.id, tag]));
  const context = turnContext({
    now: nowLabel(s.turn.ts, s.turn.tz), tz: s.turn.tz, today: s.turn.localDay, route: s.route,
    resolved: s.resolved, recall: s.recalled, recalledTags, claims: s.claims, baselineDay: s.baselineDay, convId: s.turn.convId,
    findings: s.findings, sources: s.route === 'recheck' ? recheckSources(s, ctx) : [],
    verdicts: s.verdictRows ?? [], dropped: 0,
    instructions: ROUTE_INSTRUCTIONS[s.route] + (s.flags.some((f) => f.kind === 'info') ? ' ' + s.flags.filter((f) => f.kind === 'info').map((f) => f.message).join(' ') : ''),
  });
  const history = historyMessages((await ctx.store.turns(s.turn.convId)).filter((t) => t.id !== s.turn.id), LIMITS.historyTurns);
  const tier: Tier = s.route === 'recheck' ? 'deep' : s.route === 'smalltalk' || s.route === 'clarify' ? 'fast' : 'main';
  if (s.route === 'search') ctx.budget.left = ctx.budget.total = 6;

  const { text, usage } = await ctx.model.run({
    tier,
    system: WRITER_SYSTEM,
    messages: [...history, { role: 'user', content: `${context}\n\n${s.turn.user}` }],
    onText: show,
    onToolCalls: s.route === 'search' ? (calls) => runSearches(ctx, s, calls, {}) : undefined,
    maxRounds: LIMITS.writerRounds,
    signal: ctx.signal,
  });
  logUsage(ctx, `synthesize(${s.route})`, t0, usage);

  let tail = ctx.resolver.flush();
  if (s.route === 'recheck' && s.verdictRows.length) tail += ctx.resolver.push(`\n\n${bottomLine(s.verdictRows)}`) + ctx.resolver.flush();
  shown += tail;
  if (streams && tail) ctx.emit({ type: 'token', text: tail });
  // Memory guard: a buffered reply that describes our past conversation without citing a real
  // recalled turn is invented, so it is replaced by the no-record wording before anyone sees it.
  const citedTurn = [...ctx.resolver.used].some((id) => id.startsWith('T'));
  if (!streams && CLAIMS_PAST.test(shown) && !citedTurn) {
    ctx.log?.(`[guards] memory guard replaced an uncited claim about past turns`);
    const answer = noRecord();
    ctx.emit({ type: 'token', text: answer });
    return { answer, display: answer };
  }
  // Buffered routes are shown only now, after the citation and memory checks ran.
  if (!streams) ctx.emit({ type: 'token', text: shown });
  return { answer: normalizeTags(prefix + text + (s.route === 'recheck' && s.verdictRows.length ? `\n\n${bottomLine(s.verdictRows)}` : '')), display: shown };
}

function guards(s: S, config: LangGraphRunnableConfig): U {
  const ctx = ctxOf(config);
  const flags: Flag[] = [];
  const bad = numberGuard(s.answer, ctx.registry.byId, (s.claims ?? []).map((c) => c.value));
  if (bad.length) flags.push({ kind: 'guard', message: `Caution: I could not find ${bad.join(', ')} in the cited page text. Please check the source before relying on it.` });
  if (ctx.resolver.unknown.size) ctx.log?.(`[guards] removed unknown citation tags: ${[...ctx.resolver.unknown].join(', ')}`);
  if (ctx.budget.total && ctx.budget.left <= 0) flags.push({ kind: 'budget', message: `Search budget (${ctx.budget.total}) reached; coverage may be incomplete.` });
  for (const f of [...s.flags, ...flags]) if (f.kind !== 'info') ctx.emit({ type: 'note', text: f.message });
  return { flags };
}

async function store(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const ctx = ctxOf(config);
  const cited = [...ctx.resolver.used].filter((id) => id.startsWith('S')).map((id) => ctx.registry.byId.get(id)!).filter(Boolean);
  const evidence = s.answer
    .split(/(?<=[.!?])\s+|\n+/)
    .flatMap((sentence) => [...sentence.matchAll(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/)).map((id) => ({ sentence, id })))
    .filter(({ id }) => ctx.registry.byId.has(id))
    .map(({ sentence, id }) => ({ sentence: sentence.slice(0, 400), sourceId: id, excerpt: ctx.registry.byId.get(id)!.excerpt.slice(0, 600) }));
  const notes = s.flags.filter((f) => f.kind === 'guard' || f.kind === 'budget' || f.kind === 'error').map((f) => `\n\n> ${f.message}`).join('');
  const turn: Turn = { ...s.turn, assistant: s.display + notes, route: s.route, status: 'complete', sources: cited, evidence };
  await ctx.store.putTurn(turn);
  ctx.emit({ type: 'done', turnId: turn.id, route: s.route, day: turn.localDay });
  return { turn };
}

async function extract_claims(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const ctx = ctxOf(config);
  // Recheck: new claims come only from code-checked verdicts (no model call), so an unverified
  // value in the explanation can never become the next baseline.
  if (s.route === 'recheck') {
    const claims: Claim[] = (s.verdictRows ?? [])
      .filter((r) => r.verdict !== 'could-not-verify' && r.evidence.length)
      .map((r) => {
        const src = ctx.registry.byId.get(r.evidence[0])!;
        return {
          id: claimId(s.turn.id, r.entity, r.attribute), turnId: s.turn.id, day: s.turn.localDay, entity: r.entity, attribute: r.attribute,
          value: r.newValue ?? r.oldValue, sourceUrl: src.url, pageDate: src.pageDate, ...(r.verdict !== 'held' ? { supersedes: r.claimId } : {}),
        };
      });
    await ctx.store.upsertClaims(s.turn.convId, claims).catch((e) => ctx.log?.(`[extract_claims] skipped: ${(e as Error).message}`));
    ctx.log?.(`[node] extract_claims(recheck verdicts: ${claims.length})`);
    return {};
  }
  if (s.route !== 'search' || !s.turn.sources.length) return {};
  const t0 = Date.now();
  try {
    const { value, usage } = await ctx.model.structured({ tier: 'fast', system: EXTRACT_SYSTEM, prompt: s.answer, schema: ExtractSchema });
    const existing = await ctx.store.claims(s.turn.convId);
    const claims: Claim[] = value.claims
      .filter((c) => ctx.registry.byId.has(c.sourceId))
      .map((c) => {
        const src = ctx.registry.byId.get(c.sourceId)!;
        const prior = existing.filter((x) => normEntity(x.entity) === normEntity(c.entity) && x.attribute === c.attribute.toLowerCase() && x.value !== c.value).at(-1);
        return {
          id: claimId(s.turn.id, c.entity, c.attribute), turnId: s.turn.id, day: s.turn.localDay,
          entity: c.entity, attribute: c.attribute.toLowerCase(), value: c.value, sourceUrl: src.url, pageDate: src.pageDate,
          ...(prior ? { supersedes: prior.id } : {}),
        };
      });
    await ctx.store.upsertClaims(s.turn.convId, claims);
    logUsage(ctx, `extract_claims(${claims.length})`, t0, usage);
  } catch (e) {
    ctx.log?.(`[extract_claims] skipped: ${(e as Error).message}`); // never affects the shown answer
  }
  return {};
}

// ---------- graph ----------

export const graph = new StateGraph(State)
  .addNode('ingest', ingest)
  .addNode('resolve_dates', resolve_dates)
  .addNode('recall', recall)
  .addNode('router', router)
  .addNode('searcher', searcher)
  .addNode('verdicts', verdicts)
  .addNode('synthesize', synthesize)
  .addNode('guards', guards)
  .addNode('store', store)
  .addNode('extract_claims', extract_claims)
  .addEdge(START, 'ingest')
  .addEdge('ingest', 'resolve_dates')
  .addEdge('resolve_dates', 'recall')
  .addEdge('recall', 'router')
  .addConditionalEdges('router', afterRouter, ['synthesize', 'searcher'])
  .addEdge('searcher', 'verdicts')
  .addEdge('verdicts', 'synthesize')
  .addEdge('synthesize', 'guards')
  .addEdge('guards', 'store')
  .addEdge('store', 'extract_claims')
  .addEdge('extract_claims', END)
  .compile();

/** Run one turn. Resolves when claims are extracted; the reply is complete at the `done` event. */
export async function runTurn(deps: Deps, input: { turn: Turn; locale: string }) {
  const registry = new SourceRegistry();
  const turnTags = new Map<string, { id: string; day: string; convId: string }>();
  const ctx: RunCtx = { ...deps, registry, turnTags, pool: [], resolver: new CitationResolver(registry.byId, turnTags, input.turn.convId), budget: { left: 0, total: 0 } };
  return graph.invoke({ turn: input.turn, locale: input.locale }, { configurable: { ctx }, signal: deps.signal, recursionLimit: 30 });
}
