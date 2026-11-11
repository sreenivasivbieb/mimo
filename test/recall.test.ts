import { describe, expect, it } from 'vitest';
import { recall } from '../src/recall.js';
import { resolveDates } from '../src/time.js';
import { turn } from './helpers.js';

const TODAY = '2026-11-11';
const turns = [
  turn({ id: 'a', seq: 1, localDay: '2026-11-03', user: 'What do HubSpot, Pipedrive and Zoho CRM cost per seat?', assistant: 'HubSpot Starter is $20...' }),
  turn({ id: 'b', seq: 2, localDay: '2026-11-03', user: 'Which one has the best free plan?' }),
  turn({ id: 'c', seq: 3, localDay: '2026-11-09', user: 'Compare Notion and Obsidian for note taking' }),
  turn({ id: 'd', seq: 4, localDay: '2026-11-10', user: 'What is the latest Node.js LTS version?' }),
  turn({ id: 'x', seq: 5, localDay: '2026-11-10', user: 'zebra question', status: 'cancelled' }),
];
const daysAvailable = ['2026-11-10', '2026-11-09', '2026-11-03'];
const run = (query: string, mode: 'day' | 'topic' | 'absence', locale = 'en-GB') =>
  recall({ turns, query, resolved: resolveDates(query, TODAY, locale), mode, today: TODAY, daysAvailable });

describe('recall', () => {
  it('pure date question is an exact day lookup, in order', () => {
    const r = run('what did I ask on 3 November?', 'day');
    expect(r.status).toBe('found');
    expect(r.hits.map((h) => h.turn.id)).toEqual(['a', 'b']);
    expect(r.matchedDay).toBe('2026-11-03');
  });

  it('falls back to the second candidate for "last Tuesday" and says how it matched', () => {
    // Asked Wed 11 Nov: yesterday (10th) has turns, so it matches there first.
    expect(run('what did I ask last Tuesday?', 'day').matchedDay).toBe('2026-11-10');
    const r = recall({ turns: turns.filter((t) => t.localDay !== '2026-11-10'), query: 'what did I ask last Tuesday?', resolved: resolveDates('last Tuesday', TODAY), mode: 'day', today: TODAY, daysAvailable });
    expect(r.matchedDay).toBe('2026-11-03');
    expect(r.hits[0].how).toMatch(/off by 7 days/);
  });

  it('returns none for a day with no turns, with the days we have', () => {
    const r = run('what did I ask on 5 November?', 'day');
    expect(r.status).toBe('none');
    expect(r.daysAvailable).toEqual(daysAvailable);
  });

  it('asks when an ambiguous numeric date has turns on both readings', () => {
    const extra = [...turns, turn({ id: 'm', seq: 9, localDay: '2026-03-11', user: 'march question' })];
    const q = 'what did I ask on 3/11';
    const r = recall({ turns: extra, query: q, resolved: resolveDates(q, TODAY, 'en-GB'), mode: 'day', today: TODAY, daysAvailable });
    expect(r.status).toBe('ask');
  });

  it('ranks topic matches inside the window', () => {
    const r = run('has CRM pricing changed since Monday 2 November?', 'topic');
    expect(r.status).toBe('found');
    expect(r.hits[0].turn.id).toBe('a');
  });

  it('widens the window when nothing matches inside it', () => {
    const r = run('what about the CRM seat prices from yesterday?', 'topic');
    expect(r.status).toBe('found');
    expect(r.widened).toBeGreaterThan(0);
    expect(r.hits[0].turn.id).toBe('a');
  });

  it('absence scan says none rather than guessing', () => {
    expect(run('did I ever mention Salesforce?', 'absence').status).toBe('none');
    expect(run('did I ever mention Obsidian?', 'absence').status).toBe('found');
  });

  it('ignores cancelled turns', () => {
    const r = run('did I ever mention zebras?', 'absence');
    expect(r.status).toBe('none');
  });

  it('with no topic words, takes the latest answer that used sources', () => {
    const withSrc = turns.map((t) => (t.id === 'c' ? { ...t, sources: [{ id: 'S1', url: 'https://x', title: 'x', excerpt: '', complete: false }] } : t));
    const r = recall({ turns: withSrc, query: 'is your answer still correct?', resolved: resolveDates('is your answer still correct?', TODAY), mode: 'topic', today: TODAY, daysAvailable });
    expect(r.hits[0].turn.id).toBe('c');
  });

  it('tries the second "last Tuesday" candidate before widening, in topic and absence modes', () => {
    // Asked Wed 11 Nov: yesterday (10th) has only an unrelated turn; the Postgres chat was on the 3rd.
    const ts = [
      turn({ id: 'cat', seq: 1, localDay: '2026-11-10', user: 'What is a good name for a cat?' }),
      turn({ id: 'crm', seq: 2, localDay: '2026-11-09', user: 'Shortlist CRM tools with per-seat pricing' }),
      turn({ id: 'pg', seq: 3, localDay: '2026-11-03', user: 'Compare pricing for managed Postgres hosting' }),
    ];
    const q = 'Last Tuesday I asked you about Postgres hosting.';
    const topic = recall({ turns: ts, query: q, resolved: resolveDates(q, TODAY), mode: 'topic', today: TODAY, daysAvailable });
    expect(topic.status).toBe('found');
    expect(topic.matchedDay).toBe('2026-11-03');
    expect(topic.widened).toBe(0);
    const absence = recall({ turns: ts, query: 'postgres', resolved: resolveDates(q, TODAY), mode: 'absence', today: TODAY, daysAvailable });
    expect(absence.matchedDay).toBe('2026-11-03');
  });

  it('a turn sharing no topic word is never a hit, however close its day', () => {
    const ts = [turn({ id: 'cat', seq: 1, localDay: '2026-11-10', user: 'What is a good name for a cat?' })];
    const q = 'what about the Postgres prices from yesterday?';
    expect(recall({ turns: ts, query: q, resolved: resolveDates(q, TODAY), mode: 'topic', today: TODAY, daysAvailable }).status).toBe('none');
  });
});
