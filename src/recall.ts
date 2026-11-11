// Finding earlier turns: exact day lookup, topic ranking inside a window,
// and a bounded widen loop. No model calls.
import { diffDays, widen } from './time.js';
import type { DateWindow, Recall, RecallHit, Resolved, Turn } from './types.js';

export type RecallMode = 'day' | 'topic' | 'absence';

/** Tuned on the eval suite, not chosen for elegance. */
export const RECALL = { threshold: 0.12, margin: 0.04, maxWiden: 3, distancePenalty: 0.005 };

const STOP = new Set(
  `a an the and or but if of to in on at for with about from by is are was were be been being do does did done have has had i me my we our you your it its this that these those what which who whom when where why how
  ask asked asking say said tell told mention mentioned talk talked question questions answer answers still correct right wrong anything something changed change changes since ago last next
  today yesterday week weeks month months day days year time earlier before previously recently ever again please can could would should will just now there here any some all
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december
  discuss discussed discussing research researched researching search searched searching look looked lookup find found cover covered chat chatted speak spoke
  topic topics thing things stuff list all anything everything something about regarding related conversation conversations chat chats session sessions
  previous prior other old past earlier just
  jan feb mar apr jun jul aug sep sept oct nov dec then them they true valid accurate current same case`.split(/\s+/),
);

/** The content words of a message, as written ("rcb", "ipl", "2025"). */
export function topicWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%.\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d{1,2}(st|nd|rd|th)?$/.test(w));
}

/** Content words, lightly stemmed for matching. */
export function terms(text: string): string[] {
  return topicWords(text).map((w) => w.replace(/(ies)$/, 'y').replace(/(?<=..)(s|ing|ed)$/, ''));
}

const inWindow = (t: Turn, w: DateWindow) => t.localDay >= w.start && t.localDay <= w.end;
const turnText = (t: Turn) => `${t.user}\n${t.assistant ?? ''}`;

/** Cosine similarity of TF-IDF vectors; the corpus is one conversation, so this is cheap. */
function rank(query: string[], docs: Turn[], corpus: Turn[]): Map<string, number> {
  const df = new Map<string, number>();
  const toks = new Map(corpus.map((t) => [t.id, terms(turnText(t))]));
  for (const ts of toks.values()) for (const w of new Set(ts)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = Math.max(corpus.length, 1);
  const idf = (w: string) => Math.log(1 + n / (1 + (df.get(w) ?? 0)));
  const vec = (ts: string[]) => {
    const v = new Map<string, number>();
    for (const w of ts) v.set(w, (v.get(w) ?? 0) + 1);
    for (const [w, c] of v) v.set(w, c * idf(w));
    return v;
  };
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
  const q = vec(query);
  const qn = norm(q);
  const out = new Map<string, number>();
  for (const d of docs) {
    const v = vec(toks.get(d.id) ?? terms(turnText(d)));
    let dot = 0;
    for (const [w, x] of q) dot += x * (v.get(w) ?? 0);
    out.set(d.id, dot / (qn * norm(v)));
  }
  return out;
}

export function recall(opts: { turns: Turn[]; query: string; resolved: Resolved; mode: RecallMode; today: string; daysAvailable: string[] }): Recall {
  const { query, resolved, mode, today, daysAvailable } = opts;
  const turns = opts.turns.filter((t) => t.status === 'complete');
  const base = { widened: 0, daysAvailable };
  if (!turns.length) return { status: 'none', hits: [], ...base };

  // A pure date question: exact lookup, in order, no ranking.
  if (mode === 'day') {
    const found = resolved.candidates.map((day) => ({ day, hits: turns.filter((t) => t.localDay === day) }));
    const nonEmpty = found.filter((f) => f.hits.length);
    if (resolved.assumption && nonEmpty.length > 1) {
      return { status: 'ask', hits: nonEmpty.flatMap((f) => f.hits.map((turn) => ({ turn, score: 1, how: `on ${f.day}` }))), ...base };
    }
    if (nonEmpty.length) {
      const f = nonEmpty[0];
      const off = diffDays(resolved.candidates[0], f.day);
      const how = off === 0 ? 'exact day' : `off by ${Math.abs(off)} days (next candidate)`;
      return { status: 'found', matchedDay: f.day, hits: f.hits.map((turn) => ({ turn, score: 1, how })), ...base };
    }
    if (!resolved.candidates.length && resolved.window) {
      const hits = turns.filter((t) => inWindow(t, resolved.window!));
      if (hits.length) return { status: 'found', hits: hits.map((turn) => ({ turn, score: 1, how: 'in window' })), ...base };
    }
    return { status: 'none', hits: [], ...base };
  }

  const q = terms(query);
  const full: DateWindow = { start: turns[0].localDay, end: today, label: 'all history' };
  const window = resolved.window ?? full;
  // "Last Tuesday" keeps two candidate days: both are tried, in order, before any widening.
  const candidateWindows: DateWindow[] = resolved.candidates.length > 1 ? resolved.candidates.map((d) => ({ start: d, end: d, label: d })) : [];
  const sameDay = (hs: RecallHit[]) => (hs.length && hs.every((h) => h.turn.localDay === hs[0].turn.localDay) ? hs[0].turn.localDay : undefined);

  // "Did I ever mention X?" scans every turn in the window, not the top few.
  if (mode === 'absence') {
    for (const w of candidateWindows.length ? candidateWindows : [window]) {
      const hits = turns.filter((t) => inWindow(t, w)).filter((t) => {
        const ts = new Set(terms(turnText(t)));
        return q.some((x) => ts.has(x));
      }).map((turn) => ({ turn, score: 1, how: 'keyword' }));
      if (hits.length) return { status: 'found', hits, matchedDay: sameDay(hits), ...base };
    }
    return { status: 'none', hits: [], ...base };
  }

  // "Is your answer still correct?" has no topic words: take the latest answer that used sources.
  if (!q.length) {
    const pool = turns.filter((t) => inWindow(t, window));
    const last = [...pool].reverse().find((t) => t.sources.length) ?? pool.at(-1);
    return last ? { status: 'found', matchedDay: last.localDay, hits: [{ turn: last, score: 1, how: 'most recent answer' }], ...base } : { status: 'none', hits: [], ...base };
  }

  const anchors = resolved.candidates;
  const orig = resolved.window;
  const nearest = (day: string) => anchors.reduce<string | undefined>((best, a) => (best === undefined || Math.abs(diffDays(day, a)) < Math.abs(diffDays(day, best)) ? a : best), undefined);
  /** Days outside both the asked-for window and every candidate day. */
  const outside = (day: string) => {
    if (!orig) return 0;
    const fromWindow = day < orig.start ? diffDays(orig.start, day) : day > orig.end ? diffDays(day, orig.end) : 0;
    return Math.min(fromWindow, ...anchors.map((a) => Math.abs(diffDays(day, a))));
  };

  const attempt = (w: DateWindow, step: number): Recall | null => {
    const pool = turns.filter((t) => inWindow(t, w));
    const scores = rank(q, pool, turns);
    const hits: RecallHit[] = pool
      // A turn sharing no topic word is not a match, however close its day is.
      .filter((turn) => (scores.get(turn.id) ?? 0) > 0)
      .map((turn) => {
        let score = scores.get(turn.id)!;
        // Closer to an asked-about day is better; outside the original window costs a little.
        const anchor = nearest(turn.localDay);
        if (anchor) score += 0.1 / (1 + Math.abs(diffDays(turn.localDay, anchor)));
        score -= RECALL.distancePenalty * outside(turn.localDay);
        const how = anchor ? (turn.localDay === anchor ? 'exact day' : `off by ${Math.abs(diffDays(turn.localDay, anchor))} days`) : 'keyword';
        return { turn, score, how };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score);

    const [top, second] = hits;
    if (!top || top.score < RECALL.threshold) return null;
    if (!second || top.score - second.score >= RECALL.margin || second.turn.localDay === top.turn.localDay) {
      const sameDayHits = hits.filter((h) => h.turn.localDay === top.turn.localDay && h.score >= RECALL.threshold);
      return { status: 'found', matchedDay: top.turn.localDay, hits: sameDayHits, widened: step, daysAvailable };
    }
    return { status: 'ask', hits: hits.slice(0, 3), widened: step, daysAvailable };
  };

  for (const w of [window, ...candidateWindows.slice(1)]) {
    const r = attempt(w, 0);
    if (r) return r;
  }
  if (!orig) return { status: 'none', hits: [], widened: 0, daysAvailable }; // already searched everything
  for (let step = 1; step <= RECALL.maxWiden; step++) {
    const r = attempt(widen(orig, step - 1, today), step);
    if (r) return r;
  }
  return { status: 'none', hits: [], widened: RECALL.maxWiden, daysAvailable };
}
