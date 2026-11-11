import { describe, expect, it } from 'vitest';
import { CitationResolver, bottomLine, checkVerdict, filterByWindow, normalizeTags, numberGuard } from '../src/guards.js';
import type { Claim, Source, VerdictRow } from '../src/types.js';

const src = (id: string, excerpt: string, extra: Partial<Source> = {}): Source => ({ id, url: `https://ex.com/${id}`, title: id, excerpt, complete: true, ...extra });

describe('CitationResolver', () => {
  it('resolves tags split across tokens and drops unknown ones', () => {
    const r = new CitationResolver(new Map([['S1', src('S1', '')], ['S2', src('S2', '')]]), new Map([['T1', { id: 'turn-a', day: '2026-11-03' }]]));
    let out = '';
    for (const d of ['Price is $20 [', 'S', '1, S', '2]. Old [S9] gone. You asked [T', '1].']) out += r.push(d);
    out += r.flush();
    expect(out).toBe('Price is $20 [1](https://ex.com/S1) [2](https://ex.com/S2). Old  gone. You asked [↩ Tue 3 Nov](#turn-turn-a).');
    expect([...r.unknown]).toEqual(['S9']);
  });

  it('accepts 【S1†L4-L9】-style citations, even split across tokens', () => {
    const r = new CitationResolver(new Map([['S1', src('S1', '')], ['S2', src('S2', '')]]), new Map());
    let out = '';
    for (const d of ['Node is v26 【', 'S1†L4', '-L9】 and 【S1, S2】.']) out += r.push(d);
    out += r.flush();
    expect(out).toBe('Node is v26 [1](https://ex.com/S1) and [1](https://ex.com/S1) [2](https://ex.com/S2).');
    expect(normalizeTags('a 【S3†source】 b 【not a tag】')).toBe('a [S3] b 【not a tag】');
    expect(normalizeTags('page (S1) and articles (S6, S11), not (Section 2)')).toBe('page [S1] and articles [S6, S11], not (Section 2)');
    expect(normalizeTags('price [\u200bS3]')).toBe('price [S3]');
  });

  it('does not hold back ordinary brackets forever', () => {
    const r = new CitationResolver(new Map(), new Map());
    expect(r.push('see [note] here') + r.flush()).toBe('see [note] here');
  });
});

describe('numberGuard', () => {
  const sources = new Map([
    ['S1', src('S1', 'Starter plan: $1, 200 per year or $ 20 per seat per month. 15 % off annual.')],
    ['S2', src('S2', 'snippet cut off', { complete: false })],
  ]);
  it('joins digits split by page markup', () => {
    expect(numberGuard('Starter costs $1,200 a year or $20 a seat, with 15% off [S1].', sources)).toEqual([]);
  });
  it('flags a number missing from complete cited text', () => {
    expect(numberGuard('Starter costs $25 a seat [S1].', sources)).toEqual(['$25']);
  });
  it('ignores our own earlier values quoted in a recheck', () => {
    expect(numberGuard('Pro is now $59, up from the $47 we reported [S1].', new Map([['S1', src('S1', 'Pro $59/user/month')]]), ['$47/user/month'])).toEqual([]);
  });

  it('stays quiet when the cited excerpt is a cut snippet', () => {
    expect(numberGuard('Pro costs $99 [S2].', sources)).toEqual([]);
  });
});

describe('filterByWindow', () => {
  it('drops dated results outside the window, keeps undated ones', () => {
    const items = [{ pageDate: '2026-11-10' }, { pageDate: '2025-01-01' }, {}];
    const { kept, dropped } = filterByWindow(items, { start: '2026-11-09', end: '2026-11-11', label: '' });
    expect(kept).toHaveLength(2);
    expect(dropped).toEqual([{ pageDate: '2025-01-01' }]);
  });
});

describe('checkVerdict', () => {
  const claim: Claim = { id: 'c1', turnId: 't', day: '2026-11-03', entity: 'HubSpot', attribute: 'starter price', value: '$20', sourceUrl: 'u' };
  const base = '2026-11-03';
  it('matches a value by its numbers when the wording differs', () => {
    const c = { ...claim, value: '$14/seat/month billed annually' };
    expect(checkVerdict('held', c, null, [src('S1', 'Essential: $14 per seat per month, billed yearly')], base).verdict).toBe('held');
    expect(checkVerdict('held', c, null, [src('S1', 'Essential: $140 per seat')], base).verdict).toBe('could-not-verify');
    expect(checkVerdict('held', c, null, [src('S1', 'Essential: $1.14 per seat')], base).verdict).toBe('could-not-verify');
    const rds = { ...claim, value: '$0.016/hour' };
    expect(checkVerdict('held', rds, null, [src('S1', 'db.t4g.micro USD 0.016 per hour')], base).verdict).toBe('held');
    expect(checkVerdict('held', { ...claim, value: '$40/user' }, null, [src('S1', 'up to 40 users')], base).verdict).toBe('could-not-verify');
  });

  it('held needs the stored value in a cited source', () => {
    expect(checkVerdict('held', claim, null, [src('S1', 'Starter $20/mo')], base).verdict).toBe('held');
    expect(checkVerdict('held', claim, null, [src('S1', 'nothing here')], base).verdict).toBe('could-not-verify');
    expect(checkVerdict('held', claim, null, [], base).verdict).toBe('could-not-verify');
  });
  it('changed needs a source dated after the baseline with the new value', () => {
    expect(checkVerdict('changed', claim, '$25', [src('S1', 'now $25', { pageDate: '2026-11-08' })], base).verdict).toBe('changed');
    expect(checkVerdict('changed', claim, '$25', [src('S1', 'now $25')], base).verdict).toBe('could-not-verify');
    expect(checkVerdict('changed', claim, '$25', [src('S1', 'now $25', { pageDate: '2026-10-01' })], base).verdict).toBe('could-not-verify');
  });
  it('corrected needs a source dated on or before the baseline', () => {
    expect(checkVerdict('corrected', claim, '$15', [src('S1', 'Starter $15', { pageDate: '2026-09-01' })], base).verdict).toBe('corrected');
    expect(checkVerdict('corrected', claim, '$15', [src('S1', 'Starter $15', { pageDate: '2026-11-09' })], base).verdict).toBe('could-not-verify');
  });
});

describe('bottomLine', () => {
  it('counts match the table', () => {
    const rows = ['held', 'held', 'changed', 'could-not-verify'].map((verdict) => ({ verdict }) as VerdictRow);
    expect(bottomLine(rows)).toBe('**Bottom line:** 2 held, 1 changed, 0 corrected, 1 could not verify.');
  });
});
