// Plain-code checks. A guard adds a visible note or blocks; it never silently rewrites facts.
import { dayLabel, relativeAge, shortDay } from './time.js';
import type { Claim, DateWindow, Recall, Source, Turn, Verdict, VerdictRow } from './types.js';

// ---- abstention gate (before the writer, no model call) ----

export function noRecordReply(recall: Recall, today: string, label?: string, topic?: string, allConversations = false): string {
  const days = recall.daysAvailable.slice(0, 10).map((d) => `${dayLabel(d)} (${relativeAge(d, today)})`);
  const what = label ? ` for ${label}` : '';
  if (topic) {
    const where = label ? ` in our messages from ${label}` : allConversations ? ' in any of our conversations' : ' in this conversation';
    if (!days.length) return `No — we haven't discussed ${topic} yet. There are no earlier messages.`;
    return `I found no mention of ${topic}${where}. The days I do have messages from are: ${days.join('; ')}. Want me to look it up now?`;
  }
  if (!days.length) return `I have no record${what} — there are no earlier messages yet.`;
  return `I have no record of that${what}. The days I do have messages from are: ${days.join('; ')}. Which one did you mean, or can you tell me what it was about?`;
}

/** "Which day?" — the days that have messages, each with the conversations held that day. */
export function whichDayReply(turns: Turn[], today: string): string {
  const byDay = new Map<string, Map<string, Turn>>();
  for (const t of turns.filter((x) => x.status === 'complete')) {
    const convs = byDay.get(t.localDay) ?? new Map<string, Turn>();
    if (!convs.has(t.convId)) convs.set(t.convId, t); // first message of that chat on that day
    byDay.set(t.localDay, convs);
  }
  const days = [...byDay.keys()].sort().reverse().slice(0, 8);
  const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  const lines = days.map((d) => {
    const convs = [...byDay.get(d)!.values()];
    const n = convs.length;
    return `- **${dayLabel(d)}** (${relativeAge(d, today)}) — ${n} conversation${n > 1 ? 's' : ''}: ${convs.slice(0, 3).map((t) => `"${clip(t.user)}"`).join('; ')}`;
  });
  return `Which day do you mean? I have messages from:\n\n${lines.join('\n')}\n\nReply with a date like "3 November" or "yesterday".`;
}

// ---- date-window filter (before the writer) ----

/** Drop results whose page date falls outside the window. Undated results stay but are not "changes". */
export function filterByWindow<T extends { pageDate?: string }>(items: T[], w: DateWindow | null): { kept: T[]; dropped: T[] } {
  if (!w) return { kept: items, dropped: [] };
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const s of items) (s.pageDate && (s.pageDate < w.start || s.pageDate > w.end) ? dropped : kept).push(s);
  return { kept, dropped };
}

// ---- citation resolver (token by token while streaming) ----

const TAG = /\[((?:[ST]\d+)(?:\s*[,;]\s*[ST]\d+)*)\]/g;

/** gpt-oss cites as 【S1】, 【S1†L4-L9】 or (S1, S6); rewrite those to [S1] so one resolver handles every model. */
export function normalizeTags(text: string): string {
  return text
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '') // zero-width characters inside [​S3]
    .replace(/【([^】]*)】/g, (m, inner: string) => {
      const ids = inner.match(/[ST]\d+/g);
      return ids ? `[${ids.join(', ')}]` : m;
    })
    .replace(/\(((?:[ST]\d+)(?:\s*(?:,|and)\s*[ST]\d+)*)\)/g, (_m, inner: string) => `[${inner.match(/[ST]\d+/g)!.join(', ')}]`);
}

/**
 * Rewrites [S3] into a markdown link to the source and [T2] into a link to the
 * earlier turn; unknown tags are removed. Holds back a possibly-partial tag at
 * the end of a delta so a tag split across tokens still resolves.
 */
export class CitationResolver {
  private buf = '';
  readonly used = new Set<string>();
  readonly unknown = new Set<string>();
  constructor(private sources: Map<string, Source>, private turns: Map<string, { id: string; day: string; convId?: string }>, private convId?: string) {}

  push(delta: string): string {
    this.buf += delta;
    const open = Math.max(this.buf.lastIndexOf('['), this.buf.lastIndexOf('【'));
    let cut = this.buf.length;
    if (open !== -1 && !/[\]】]/.test(this.buf.slice(open)) && this.buf.length - open < 40) cut = open;
    const ready = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return this.resolve(ready);
  }

  flush(): string {
    const out = this.resolve(this.buf);
    this.buf = '';
    return out;
  }

  private resolve(text: string): string {
    return normalizeTags(text).replace(TAG, (_m, inner: string) => {
      const links = inner
        .split(/\s*[,;]\s*/)
        .map((id) => {
          const s = this.sources.get(id);
          if (s) {
            this.used.add(id);
            return `[${id.slice(1)}](${s.url})`;
          }
          const t = this.turns.get(id);
          if (t) {
            this.used.add(id);
            // A turn from another chat links to that chat, opened at the turn.
            if (t.convId && this.convId && t.convId !== this.convId) return `[↩ ${shortDay(t.day)}, other chat](/?conv=${t.convId}#turn-${t.id})`;
            return `[↩ ${shortDay(t.day)}](#turn-${t.id})`;
          }
          this.unknown.add(id);
          return '';
        })
        .filter(Boolean);
      return links.join(' ');
    });
  }
}

// ---- number guard (after the answer) ----

// Thousands separators only between digit groups, so "$59," at the end of a clause is "$59".
const MONEY_OR_PCT = /(?:[$€£₹]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?!\d)|[$€£₹]\s?\d+(?:\.\d+)?|\d+(?:,\d{3})*(?:\.\d+)?\s?%)/g;
const squash = (s: string) => s.replace(/(\d)[\s,]+(?=\d)/g, '$1').replace(/([$€£₹])\s+/g, '$1').replace(/\s+%/g, '%');

/**
 * Each price or percentage in a cited sentence must appear in a cited excerpt.
 * Precision first: only flag when every cited excerpt is complete page text and
 * none contains the number (cut snippets caused mostly false alarms).
 */
/** `ours` are values from our own earlier answers (rechecks quote them); they are not claims about the page. */
export function numberGuard(answer: string, sources: Map<string, Source>, ours: string[] = []): string[] {
  const flagged: string[] = [];
  const known = new Set(ours.flatMap((v) => squash(v).match(MONEY_OR_PCT) ?? []).map((n) => squash(n)));
  for (const sentence of answer.split(/(?<=[.!?])\s+|\n+/)) {
    const ids = [...sentence.matchAll(TAG)].flatMap((m) => m[1].split(/\s*[,;]\s*/)).filter((id) => id.startsWith('S'));
    const cited = ids.map((id) => sources.get(id)).filter((s): s is Source => Boolean(s));
    if (!cited.length || !cited.every((s) => s.complete)) continue;
    const text = squash(cited.map((s) => s.excerpt).join(' \n '));
    for (const n of sentence.match(MONEY_OR_PCT) ?? []) {
      if (!text.includes(squash(n)) && !known.has(squash(n))) flagged.push(n.trim());
    }
  }
  return [...new Set(flagged)];
}

// ---- verdict guard ----

const norm = (s: string) => squash(s.toLowerCase()).replace(/\s+/g, ' ').trim();
/**
 * Does the page state this value? The exact wording first; otherwise every price, percentage and
 * number in the value must appear on the page ("$14/seat/month billed annually" ↔ "$14 per seat").
 */
export const sourceShows = (src: Source, value: string) => contains(src, value);
const contains = (src: Source, value: string) => {
  const page = norm(src.excerpt);
  if (page.includes(norm(value))) return true;
  const nums = squash(value).match(/[$€£₹]?\d+(?:\.\d+)?%?/g) ?? [];
  const onPage = (n: string) => {
    const re = (x: string) => new RegExp(`(^|[^\\d.])${x.replace(/[$.]/g, '\\$&')}(?![\\d])`).test(page);
    // A decimal price ("$0.016") is specific enough to match without its currency sign ("USD 0.016").
    return re(n) || (/\d\.\d/.test(n) && re(n.replace(/^[$€£₹]/, '')));
  };
  return nums.length > 0 && nums.every(onPage);
};

/**
 * The model proposes; code disposes. A verdict whose check fails becomes could-not-verify.
 *  held:      a cited current source contains the stored value
 *  changed:   a cited source dated after the baseline contains the new value
 *  corrected: a cited source dated on/before the baseline contains the new value
 */
export function checkVerdict(proposed: Verdict, claim: Claim, newValue: string | null, evidence: Source[], baselineDay: string): { verdict: Verdict; note?: string } {
  const fail = (why: string) => ({ verdict: 'could-not-verify' as const, note: why });
  if (proposed === 'could-not-verify') return { verdict: proposed };
  if (!evidence.length) return fail('no cited evidence');
  if (proposed === 'held') return evidence.some((s) => contains(s, claim.value)) ? { verdict: 'held' } : fail('cited source does not contain the stored value');
  if (!newValue || norm(newValue) === norm(claim.value)) return fail('no different value given');
  const showing = evidence.filter((s) => contains(s, newValue));
  if (!showing.length) return fail('cited source does not contain the new value');
  if (proposed === 'changed') return showing.some((s) => s.pageDate && s.pageDate > baselineDay) ? { verdict: 'changed' } : fail('no source dated after the baseline');
  return showing.some((s) => s.pageDate && s.pageDate <= baselineDay) ? { verdict: 'corrected' } : fail('no source dated before the baseline');
}

export function verdictTable(rows: VerdictRow[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const lines = rows.map((r) => {
    const cites = r.evidence.map((e) => `[${e}]`).join('');
    const undated = r.verdict === 'could-not-verify' && r.newValue ? ' (undated)' : '';
    return `| ${cell(r.entity)} | ${cell(r.attribute)} | ${cell(r.oldValue)} | ${cell(r.newValue ?? '—')}${undated} | **${r.verdict}** ${cites} |`;
  });
  return ['| Item | What | We said | Now | Verdict |', '|---|---|---|---|---|', ...lines].join('\n');
}

/** Counts come from the table itself, so they always match. */
export function bottomLine(rows: VerdictRow[]): string {
  const c = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  return `**Bottom line:** ${c('held')} held, ${c('changed')} changed, ${c('corrected')} corrected, ${c('could-not-verify')} could not verify.`;
}
