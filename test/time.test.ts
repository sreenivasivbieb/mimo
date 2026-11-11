import { describe, expect, it } from 'vitest';
import { localDay, mayMentionTime, relativeAge, resolveDates, resolvedFromModel, type ModelTime } from '../src/time.js';

const WED = '2026-11-11'; // a Wednesday

describe('resolveDates', () => {
  const cases: [string, string, string | null, string[]?][] = [
    // text, today, window start..end, candidates
    ['what did I ask yesterday?', WED, '2026-11-10..2026-11-10'],
    ['what did I ask on Monday?', WED, '2026-11-09..2026-11-09', ['2026-11-09']],
    ['On Monday', '2026-11-15', '2026-11-09..2026-11-09', ['2026-11-09']], // asked on Sunday: six days ago
    ['what did I ask on Wednesday', WED, '2026-11-11..2026-11-11', ['2026-11-11', '2026-11-04']], // today, else a week ago
    ['what about last Tuesday?', WED, '2026-11-10..2026-11-10', ['2026-11-10', '2026-11-03']], // yesterday, else 8 days ago
    ['last Wednesday', WED, '2026-11-04..2026-11-04', ['2026-11-04', '2026-10-28']],
    ['has anything changed since Monday?', WED, '2026-11-09..2026-11-11', ['2026-11-09']],
    ['since Wednesday', WED, '2026-11-04..2026-11-11', ['2026-11-04']],
    ['what did I ask on 3 November?', WED, '2026-11-03..2026-11-03', ['2026-11-03']],
    ['November 3rd', WED, '2026-11-03..2026-11-03'],
    ['on 15 December', WED, '2025-12-15..2025-12-15'], // future date means the past one
    ['what did we discuss in August', WED, '2026-08-01..2026-08-31'],
    ['in December', WED, '2025-12-01..2025-12-31'],
    ['last month', WED, '2026-10-01..2026-10-31'],
    ['this week', WED, '2026-11-05..2026-11-11'],
    ['3 days ago', WED, '2026-11-08..2026-11-08'],
    ['next Friday', WED, '2026-11-13..2026-11-13'],
    ['on 2026-10-02', WED, '2026-10-02..2026-10-02'],
    ['What did I ask you on 3 November? Is your answer still correct today?', WED, '2026-11-03..2026-11-03'],
    ['what did I ask a month ago?', WED, '2026-10-05..2026-10-19'], // about 30 days back, ±7
    ['what did I ask three months ago?', WED, '2026-08-06..2026-08-20'], // 90 days back, ±7
    ['what did we discuss last weekend?', WED, '2026-11-07..2026-11-08'],
    ['what did we discuss last weekend?', '2026-11-15', '2026-11-07..2026-11-08'], // asked on a Sunday: the weekend before this one
    ['what did we discuss last weekend?', '2026-11-14', '2026-11-07..2026-11-08'], // asked on a Saturday
    ['we offer 24/7 support', WED, null],
    ['the sun is out and I sat down', WED, null],
    ['what is the price of HubSpot?', WED, null],
  ];
  for (const [text, today, win, cands] of cases) {
    it(`${text} @ ${today}`, () => {
      const r = resolveDates(text, today, 'en-GB');
      expect(r.window ? `${r.window.start}..${r.window.end}` : null).toBe(win);
      if (cands) expect(r.candidates).toEqual(cands);
    });
  }

  it('reads 3/11 by locale and keeps the other reading', () => {
    const gb = resolveDates('what did I ask on 3/11', WED, 'en-GB');
    expect(gb.candidates).toEqual(['2026-11-03', '2026-03-11']);
    expect(gb.assumption).toMatch(/day-first/);
    const us = resolveDates('what did I ask on 3/11', WED, 'en-US');
    expect(us.candidates).toEqual(['2026-03-11', '2026-11-03']);
    expect(us.assumption).toMatch(/month-first/);
  });

  it('gives vague phrases a wide window and a flag', () => {
    const r = resolveDates('that thing I asked a while ago', WED);
    expect(r.vague).toBe(true);
    expect(r.window?.start).toBe('2026-10-12');
  });

  it('does not guess event-anchored dates', () => {
    const r = resolveDates('what did I ask before the holidays', WED);
    expect(r.eventAnchored).toBe(true);
    expect(r.candidates).toEqual([]);
  });
});

describe('localDay', () => {
  it('uses the user zone, not the server zone', () => {
    // 00:20 on 11 Nov in Kolkata is still 10 Nov in UTC.
    const at = new Date('2026-11-10T18:50:00Z');
    expect(localDay(at, 'Asia/Kolkata')).toBe('2026-11-11');
    expect(localDay(at, 'UTC')).toBe('2026-11-10');
    expect(localDay(at, 'America/Los_Angeles')).toBe('2026-11-10');
  });
  it('handles a DST change day', () => {
    expect(localDay(new Date('2026-03-08T09:30:00Z'), 'America/New_York')).toBe('2026-03-08');
  });
});

describe('relativeAge', () => {
  it('is computed in code', () => {
    expect(relativeAge('2026-11-11', WED)).toBe('today');
    expect(relativeAge('2026-11-10', WED)).toBe('yesterday');
    expect(relativeAge('2026-11-03', WED)).toBe('8 days ago');
    expect(relativeAge('2026-10-21', WED)).toBe('3 weeks ago');
  });
});

describe('mayMentionTime (the gate before the time model)', () => {
  it('lets time-like messages through and skips plain ones', () => {
    for (const q of ['what did I ask on Monday?', 'since 3/11', 'in August', '3rd of May', 'a month ago', 'last time', 'any news before the launch', 'what about 2026-11-03']) expect(mayMentionTime(q), q).toBe(true);
    for (const q of ['whats tavily', 'price of iphone 15', 'who won ipl 2025', 'hello']) expect(mayMentionTime(q), q).toBe(false);
    expect(mayMentionTime('what did we look at in 2025?')).toBe(true);
    expect(mayMentionTime('what did I ask two Tuesdays ago?', true)).toBe(true);
    // "strong" ignores words that usually point at the conversation, not a date
    expect(mayMentionTime('what did we discuss in our previous conversation?', true)).toBe(false);
    expect(mayMentionTime('what did we discuss in our previous conversation?')).toBe(true);
  });
});

describe('resolvedFromModel (checks dates a model worked out)', () => {
  const m = (start: string | null, end: string | null, extra: Partial<ModelTime> = {}): ModelTime =>
    ({ about: 'conversation', phrase: 'x', start, end, candidates: [], vague: false, eventAnchored: false, assumption: null, ...extra });
  it('accepts real past dates and returns the same shape as the rules', () => {
    expect(resolvedFromModel(m('2026-11-09', '2026-11-09', { candidates: ['2026-11-09', '2026-11-02'] }), WED)).toEqual({
      resolved: { window: { start: '2026-11-09', end: '2026-11-09', label: 'Monday, 9 November 2026' }, candidates: ['2026-11-09', '2026-11-02'], vague: false, eventAnchored: false },
    });
    // a single day with no candidates gets that day as its candidate, like the rules
    expect(resolvedFromModel(m('2026-11-03', '2026-11-03'), WED)).toMatchObject({ resolved: { candidates: ['2026-11-03'] } });
    expect(resolvedFromModel(m('2026-11-03', '2026-11-03', { assumption: 'I read 3/11 as 3 November (day-first).' }), WED)).toMatchObject({ resolved: { assumption: 'I read 3/11 as 3 November (day-first).' } });
  });
  it('rejects what cannot be right', () => {
    for (const [why, x] of [
      ['not a date', m('2026-02-30', '2026-02-30')],
      ['missing', m(null, null)],
      ['start after end', m('2026-11-09', '2026-11-03')],
      ['past conversation in the future', m('2026-11-12', '2026-11-12')],
      ['too far back', m('2020-01-01', '2020-01-02')],
      ['window over a year', m('2025-01-01', '2026-11-01')],
      ['candidate far from the window', m('2026-11-09', '2026-11-09', { candidates: ['2026-06-01'] })],
    ] as const) expect('problem' in resolvedFromModel(x, WED), why).toBe(true);
  });
  it('allows a world window to reach into the future (an upcoming release), but not a conversation', () => {
    expect('resolved' in resolvedFromModel(m('2026-11-20', '2026-11-20', { about: 'world' }), WED)).toBe(true);
    expect('problem' in resolvedFromModel(m('2026-11-20', '2026-11-20'), WED)).toBe(true);
  });
});
