import { describe, expect, it } from 'vitest';
import { localDay, relativeAge, resolveDates } from '../src/time.js';

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
