// The same contract runs against MemoryStore always, and against Postgres when MIMO_DATABASE_URL is set.
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryStore, PgStore, claimId, normEntity, type Store } from '../src/store.js';
import { turn } from './helpers.js';

try {
  process.loadEnvFile('.env');
} catch {}

function contract(name: string, make: () => Store) {
  describe(name, () => {
    const store = make();
    const made: string[] = [];
    const conv = () => {
      const id = `test-${Math.random().toString(16).slice(2, 10)}`;
      made.push(id);
      return id;
    };
    afterAll(async () => {
      for (const c of made) await store.deleteConversation(c); // leave the real database clean
      await store.close?.();
    });

    it('round-trips a turn, upserts by id, orders by seq', async () => {
      const c = conv();
      const src = [{ id: 'S1', url: 'https://x.com', title: 'X', excerpt: 'price $20', complete: true, pageDate: '2026-11-01' }];
      await store.putTurn(turn({ id: 'b', convId: c, seq: 2, localDay: '2026-11-09', ts: '2026-11-09T05:30:00.000Z', user: 'second' }));
      await store.putTurn(turn({ id: 'a', convId: c, seq: 1, localDay: '2026-11-03', ts: '2026-11-03T10:00:00.000Z', user: 'first', sources: src, status: 'error' }));
      await store.putTurn(turn({ id: 'a', convId: c, seq: 1, localDay: '2026-11-03', ts: '2026-11-03T10:00:00.000Z', user: 'first', sources: src, assistant: 'done', status: 'complete' }));
      const turns = await store.turns(c);
      expect(turns.map((t) => t.id)).toEqual(['a', 'b']);
      expect(turns[0]).toMatchObject({ convId: c, localDay: '2026-11-03', ts: '2026-11-03T10:00:00.000Z', assistant: 'done', status: 'complete', sources: src });
      expect(await store.nextSeq(c)).toBe(3);
      expect((await store.getTurn(c, 'a'))?.user).toBe('first');
      expect(await store.getTurn(c, 'missing')).toBeUndefined();
    });

    it('lists days with complete turns, newest first', async () => {
      const c = conv();
      await store.putTurn(turn({ id: 'a', convId: c, seq: 1, localDay: '2026-11-03', user: 'x' }));
      await store.putTurn(turn({ id: 'b', convId: c, seq: 2, localDay: '2026-11-09', user: 'y' }));
      await store.putTurn(turn({ id: 'c', convId: c, seq: 3, localDay: '2026-11-10', user: 'z', status: 'cancelled' }));
      expect(await store.days(c)).toEqual(['2026-11-09', '2026-11-03']);
    });

    it('upserts claims with deterministic IDs and finds them by entity alias', async () => {
      const c = conv();
      await store.putTurn(turn({ id: 't1', convId: c, localDay: '2026-11-03', user: 'q' }));
      const id = claimId('t1', 'HubSpot Inc.', 'Starter Price');
      expect(id).toBe(claimId('t1', 'hubspot', 'starter price'));
      const claim = { id, turnId: 't1', day: '2026-11-03', entity: 'HubSpot', attribute: 'starter price', value: '$20', sourceUrl: 'u', pageDate: '2026-11-01' };
      await store.upsertClaims(c, [claim]);
      await store.upsertClaims(c, [{ ...claim, value: '$20/seat' }]); // re-run after a crash
      const claims = await store.claims(c);
      expect(claims).toEqual([{ ...claim, value: '$20/seat' }]);
      expect(await store.claimsFor(c, 'hubspot.com')).toHaveLength(1);
      expect(await store.claimsFor(c, 'Zoho')).toHaveLength(0);
    });

    it('finds a user\'s turns and claims across chats, and adopts an old chat', async () => {
      const [c1, c2, c3] = [conv(), conv(), conv()];
      const user = `user-${c1}`;
      await store.putTurn({ ...turn({ id: 'a', convId: c1, seq: 1, localDay: '2026-11-03', ts: '2026-11-03T10:00:00.000Z', user: 'first' }), userId: user });
      await store.putTurn({ ...turn({ id: 'b', convId: c2, seq: 1, localDay: '2026-11-09', ts: '2026-11-09T10:00:00.000Z', user: 'second' }), userId: user });
      await store.putTurn(turn({ id: 'c', convId: c3, seq: 1, localDay: '2026-11-10', ts: '2026-11-10T10:00:00.000Z', user: 'from before user IDs' }));
      await store.upsertClaims(c2, [{ id: claimId(`b-${c2}`, 'X', 'price'), turnId: 'b', day: '2026-11-09', entity: 'X', attribute: 'price', value: '$1', sourceUrl: 'u' }]);
      expect((await store.turnsForUser(user)).map((t) => t.user)).toEqual(['first', 'second']);
      expect((await store.claimsForUser(user)).map((c) => c.value)).toEqual(['$1']);
      await store.adoptConversation(c3, user);
      expect((await store.turnsForUser(user)).map((t) => t.user)).toEqual(['first', 'second', 'from before user IDs']);
      expect((await store.getTurn(c1, 'a'))?.userId).toBe(user);
    });

    it('keeps conversations apart and deletes one', async () => {
      const [c1, c2] = [conv(), conv()];
      await store.putTurn(turn({ id: 'a', convId: c1, localDay: '2026-11-03', user: 'x' }));
      await store.putTurn(turn({ id: 'a', convId: c2, localDay: '2026-11-04', user: 'y' }));
      await store.deleteConversation(c1);
      expect(await store.turns(c1)).toEqual([]);
      expect((await store.turns(c2)).map((t) => t.user)).toEqual(['y']);
    });
  });
}

contract('MemoryStore', () => new MemoryStore());
const url = process.env.MIMO_DATABASE_URL;
if (url) contract('PgStore (Postgres)', () => new PgStore(url));
else describe.skip('PgStore (Postgres) — set MIMO_DATABASE_URL to run', () => it('skipped', () => {}));

describe('normEntity', () => {
  it('normalises names for lookup', () => {
    expect(normEntity('HubSpot, Inc.')).toBe('hubspot');
    expect(normEntity('zoho.com')).toBe('zoho');
  });
});
