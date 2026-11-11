// Time is never left to the model. Everything here is pure and takes "today"
// (the user's local calendar day) as an argument, so tests can pin it.
import * as chrono from 'chrono-node';
import type { DateWindow, Resolved } from './types.js';

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_RE = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';

/**
 * Cheap pre-check: could this message refer to a time at all? Used to skip the model that reads time
 * phrases when there is nothing to read ("whats tavily"). Deliberately generous; the model has the final say.
 */
const TIME_CUE = new RegExp(
  `\\b\\d{1,2}[/.]\\d{1,2}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)\\b|\\b(?:${WEEKDAYS.join('|')}|yesterday|today|tonight|tomorrow|morning|afternoon|evening|night|ago|since|last|before|earlier|previous|previously|recent|recently|weeks?|weekends?|months?|years?|quarter)\\b|\\b${MONTH_RE}\\b`,
  'i',
);
export const mayMentionTime = (text: string) => TIME_CUE.test(text);

/** Validate an IANA zone; fall back when the browser sent nothing usable. */
export function safeZone(tz: string | undefined, fallback = process.env.AGENT_TZ || 'UTC'): string {
  for (const z of [tz, fallback, 'UTC']) {
    if (!z) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: z });
      return z;
    } catch {}
  }
  return 'UTC';
}

/** The user's calendar day for an instant, as YYYY-MM-DD. */
export function localDay(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const toUtc = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => fromUtc(toUtc(day) + n * DAY_MS);
export const diffDays = (a: string, b: string) => Math.round((toUtc(a) - toUtc(b)) / DAY_MS);
export const weekdayOf = (day: string) => new Date(toUtc(day)).getUTCDay();
const ymd = (y: number, m: number, d: number) => fromUtc(Date.UTC(y, m - 1, d));
const validYmd = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && ymd(y, m, d) === `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(toUtc(day)));
}

export function shortDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(toUtc(day))).replace(',', '');
}

/** "today", "yesterday", "3 days ago", "2 weeks ago" — computed here, handed to the model as text. */
export function relativeAge(day: string, today: string): string {
  const n = diffDays(today, day);
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 0) return `in ${-n} days`;
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  return `${Math.round(n / 30)} months ago`;
}

function monthWindow(y: number, m: number): DateWindow {
  const start = ymd(y, m, 1);
  const end = addDays(ymd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1), -1);
  return { start, end, label: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(toUtc(start))) };
}

const single = (day: string): DateWindow => ({ start: day, end: day, label: dayLabel(day) });
const range = (start: string, end: string, label?: string): DateWindow => ({ start, end, label: label ?? `${dayLabel(start)} to ${dayLabel(end)}` });

/** Locales that write month before day. Everything else is read day-first. */
const MONTH_FIRST = /^(en-us|en-ph|en-as|en-gu|en-mp|en-pr|en-um|en-vi|fil)\b/i;
export const isMonthFirst = (locale = 'en-US') => MONTH_FIRST.test(locale);

const weekdayIndex = (w: string) => WEEKDAYS.findIndex((d) => d.startsWith(w.slice(0, 3)));
const monthIndex = (m: string) => MONTHS.findIndex((x) => x.startsWith(m.slice(0, 3))) + 1;

/** Most recent day with weekday `w` that is on or before (or strictly before) today. */
function pastWeekday(today: string, w: number, strict: boolean): string {
  let back = (weekdayOf(today) - w + 7) % 7;
  if (back === 0 && strict) back = 7;
  return addDays(today, -back);
}

/** A month/day with no year means the most recent one that is not in the future. */
function pastDate(today: string, m: number, d: number, year?: number): string | null {
  const y = +today.slice(0, 4);
  if (year) return validYmd(year, m, d) ? ymd(year, m, d) : null;
  if (!validYmd(y, m, d) && !validYmd(y - 1, m, d)) return null;
  const thisYear = validYmd(y, m, d) ? ymd(y, m, d) : null;
  return thisYear && thisYear <= today ? thisYear : ymd(y - 1, m, d);
}

const none = (): Resolved => ({ window: null, candidates: [], vague: false, eventAnchored: false });
const exact = (day: string, extra: Partial<Resolved> = {}): Resolved => ({ window: single(day), candidates: [day], vague: false, eventAnchored: false, ...extra });

/**
 * Turn the date phrase in a message into a window and ordered candidate days.
 * Rules (each has a test in test/time.test.ts):
 *  - "today" is the user's local day; a bare weekday/date that would be in the future means the past one
 *  - "in August" / "last month" = whole month; "this week" = 7 days ending today
 *  - "last Tuesday" keeps two candidates: the most recent one, then the week before
 *  - "3/11" uses the locale's order, states the assumption, keeps the other reading as a candidate
 *  - vague phrases get a wide window; event-anchored phrases are not guessed
 * In the app a fast model first copies out the words that name the time, and only those words come
 * here (so "monday.com" or "after 3.11" never reach it); on any model failure this runs on the whole message.
 */
export function resolveDates(text: string, today: string, locale = 'en-US'): Resolved {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ')} `;
  const y = +today.slice(0, 4);
  const mo = +today.slice(5, 7);

  // "since X": window from X to today.
  const since = t.match(/\bsince (.+?)(?:[?.!,]| and | with | for | about |$)/);
  if (since) {
    const inner = resolveDates(since[1], today, locale);
    let start = inner.window?.start;
    // "since Monday" asked on a Monday means last week's Monday.
    const wd = since[1].match(new RegExp(`^(?:last )?${WEEKDAY_RE}\\b`));
    if (wd && !/\d/.test(since[1])) start = pastWeekday(today, weekdayIndex(wd[1]), true);
    if (start && start <= today) {
      return { window: range(start, today, `since ${dayLabel(start)}`), candidates: [start], vague: false, eventAnchored: false, assumption: inner.assumption };
    }
  }

  // Event-anchored phrases: do not guess the date of "the holidays".
  if (/\b(before|after|during|around) (the |my |our )?(holidays?|christmas|diwali|new year|launch|break|vacation|trip|meeting|conference|release|offsite)\b/.test(t)) {
    return { window: range(addDays(today, -90), today, 'the last 90 days'), candidates: [], vague: true, eventAnchored: true };
  }

  let m: RegExpMatchArray | null;
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)) && validYmd(+m[1], +m[2], +m[3])) return exact(ymd(+m[1], +m[2], +m[3]));
  // Explicit dates win over relative words: "what did I ask on 3 November — still correct today?" is about 3 November.
  // "3 November", "3rd of Nov 2026", "November 3", "Nov 3rd".
  const dm = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}\\b(?:,? (\\d{4}))?`));
  const md = t.match(new RegExp(`\\b${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?`));
  const parts = dm ? { d: +dm[1], m: monthIndex(dm[2]), y: dm[3] ? +dm[3] : undefined } : md ? { d: +md[2], m: monthIndex(md[1]), y: md[3] ? +md[3] : undefined } : null;
  if (parts) {
    const day = pastDate(today, parts.m, parts.d, parts.y);
    if (day) return exact(day);
  }

  // Numeric "3/11" or "3/11/2026": the browser locale decides the order.
  // Needs a date-ish word before it so "24/7" or "50/50" are not read as dates.
  if ((m = t.match(/\b(?:on|since|from|of|dated|date|until|till|before|after|ask|asked|say|said) (\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/))) {
    const a = +m[1], b = +m[2];
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined;
    const monthFirst = isMonthFirst(locale);
    const primary = monthFirst ? pastDate(today, a, b, year) : pastDate(today, b, a, year);
    const alt = monthFirst ? pastDate(today, b, a, year) : pastDate(today, a, b, year);
    if (primary && alt && primary !== alt) {
      return exact(primary, {
        candidates: [primary, alt],
        assumption: `I read ${m[1]}/${m[2]} as ${dayLabel(primary)} (${monthFirst ? 'month-first' : 'day-first'}, from your browser's locale).`,
      });
    }
    if (primary || alt) return exact((primary ?? alt)!);
  }
  if (/\b(the )?day before yesterday\b/.test(t)) return exact(addDays(today, -2));
  if (/\byesterday\b/.test(t)) return exact(addDays(today, -1));
  if (/\b(today|this morning|this afternoon|this evening|tonight|earlier today)\b/.test(t)) return exact(today);
  if ((m = t.match(/\b(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) months? ago\b/))) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const n = words[m[1]] ?? +m[1];
    if (n >= 1) {
      // Calendar months differ in length, so this is an approximate window around 30 days per month, flagged vague.
      const mid = addDays(today, -30 * n);
      return { window: range(addDays(mid, -7), addDays(mid, 7), `about ${n} month${n > 1 ? 's' : ''} ago`), candidates: [mid], vague: true, eventAnchored: false };
    }
  }
  if ((m = t.match(/\b(\d+|a|one|two|three|four|five|six) (day|week)s? ago\b/))) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const n = words[m[1]] ?? +m[1];
    if (m[2] === 'day') return exact(addDays(today, -n));
    const mid = addDays(today, -7 * n);
    return { window: range(addDays(mid, -3), addDays(mid, 3), `about ${n} week${n > 1 ? 's' : ''} ago`), candidates: [mid], vague: false, eventAnchored: false };
  }
  if (/\b(this week|past week|last 7 days|the last week)\b/.test(t)) {
    return { window: range(addDays(today, -6), today, 'the last 7 days'), candidates: [], vague: false, eventAnchored: false };
  }
  if (/\blast week\b/.test(t)) {
    return { window: range(addDays(today, -13), addDays(today, -7), 'last week'), candidates: [], vague: false, eventAnchored: false };
  }
  if (/\blast weekend\b/.test(t)) {
    // The most recent finished Saturday + Sunday; asked on a Sunday, the weekend before this one.
    let sat = pastWeekday(today, 6, true);
    if (weekdayOf(today) === 0) sat = addDays(sat, -7);
    return { window: range(sat, addDays(sat, 1), 'last weekend'), candidates: [], vague: false, eventAnchored: false };
  }
  if (/\bthis month\b/.test(t)) {
    const w = monthWindow(y, mo);
    return { window: { ...w, end: today }, candidates: [], vague: false, eventAnchored: false };
  }
  if (/\blast month\b/.test(t)) {
    return { window: monthWindow(mo === 1 ? y - 1 : y, mo === 1 ? 12 : mo - 1), candidates: [], vague: false, eventAnchored: false };
  }

  // Weekdays: "last Tuesday", "next Friday", "on Monday", "Monday".
  if ((m = t.match(new RegExp(`\\b(last|next|this|on|past)? ?${WEEKDAY_RE}\\b`)))) {
    const w = weekdayIndex(m[2]);
    if (m[1] === 'next') {
      let ahead = (w - weekdayOf(today) + 7) % 7 || 7;
      return exact(addDays(today, ahead));
    }
    if (m[1] === 'last' || m[1] === 'past') {
      const first = pastWeekday(today, w, true);
      return { window: single(first), candidates: [first, addDays(first, -7)], vague: false, eventAnchored: false };
    }
    const first = pastWeekday(today, w, false);
    const candidates = first === today ? [today, addDays(today, -7)] : [first];
    return { window: single(first), candidates, vague: false, eventAnchored: false };
  }


  // A whole month: "in August", "August 2026". Bare "may" needs "in" or a year.
  if ((m = t.match(new RegExp(`\\b(in|during|from|of) ${MONTH_RE}\\b(?: (\\d{4}))?`))) || (m = t.match(new RegExp(`\\b()${MONTH_RE}(?: (\\d{4}))\\b`))) || (m = t.match(/\b()(january|february|march|april|june|july|august|september|october|november|december)\b()/))) {
    const month = monthIndex(m[2]);
    let year = m[3] ? +m[3] : y;
    if (!m[3] && month > mo) year -= 1;
    const w = monthWindow(year, month);
    return { window: w.end > today ? { ...w, end: today } : w, candidates: [], vague: false, eventAnchored: false };
  }

  if (/\b(the other day|a few days ago|couple of days ago)\b/.test(t)) {
    return { window: range(addDays(today, -7), today, 'the last 7 days'), candidates: [], vague: true, eventAnchored: false };
  }
  if (/\b(a while ago|a while back|some time ago|recently|before|earlier|previously|last time)\b/.test(t)) {
    return { window: range(addDays(today, -30), today, 'the last 30 days'), candidates: [], vague: true, eventAnchored: false };
  }

  // Fallback: chrono for anything else that names a specific day. The reference
  // is local noon on `today`, so chrono's local getters see the user's day.
  const ref = new Date(y, mo - 1, +today.slice(8, 10), 12);
  const parsed = chrono.parse(text, ref, { forwardDate: false })[0];
  if (parsed && parsed.start.isCertain('day') && /[a-z]/i.test(parsed.text)) {
    const d = parsed.start.date();
    const day = ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    if (day <= today) return exact(day);
  }
  return none();
}

/** Widen a window one step: day -> week -> month -> quarter. */
export function widen(w: DateWindow, step: number, today: string): DateWindow {
  const pad = [3, 14, 45][Math.min(step, 2)];
  const start = addDays(w.start, -pad);
  const end = addDays(w.end, pad) > today ? today : addDays(w.end, pad);
  return range(start, end);
}
