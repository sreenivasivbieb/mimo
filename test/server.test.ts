import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/store.js';
import { FakeModel, FakeSearch, turn } from './helpers.js';

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(model: FakeModel) {
  const store = new MemoryStore();
  const server = createApp({ model, search: new FakeSearch(), store });
  await new Promise<void>((r) => server.listen(0, r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chat = async (turnId: string, text: string) => {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ convId: 'c1', turnId, text, tz: 'Asia/Kolkata', locale: 'en-IN' }) });
    return res.text();
  };
  return { store, chat, base };
}

describe('server reliability', () => {
  it('a duplicate turn ID returns the stored result without re-running', async () => {
    const model = new FakeModel({ answer: 'Hello there.' });
    const { chat, store } = await start(model);
    const first = await chat('t1', 'hi');
    expect(first).toContain('event: done');
    const runs = model.calls.length;
    const again = await chat('t1', 'hi');
    expect(again).toContain('Hello there.');
    expect(model.calls.length).toBe(runs);
    expect(await store.turns('c1')).toHaveLength(1);
  });

  it('a new message aborts the running one, which is stored as cancelled', async () => {
    const model = new FakeModel({ answer: 'slow answer', delayMs: 400 });
    const { chat, store } = await start(model);
    const slow = chat('t1', 'hello');
    await new Promise((r) => setTimeout(r, 50));
    model.script.delayMs = 0;
    const fast = await chat('t2', 'thanks');
    expect(await slow).toContain('event: error');
    expect(fast).toContain('event: done');
    expect((await store.getTurn('c1', 't1'))?.status).toBe('cancelled');
    expect((await store.getTurn('c1', 't2'))?.status).toBe('complete');
  });

  it('attaches older chats the browser remembers (made before user IDs) to this user', async () => {
    const { store, base } = await start(new FakeModel({ answer: 'ok' }));
    await store.putTurn(turn({ id: 'old', convId: 'chat-old', localDay: '2026-11-10', user: 'who won ipl 2025' }));
    await store.putTurn(turn({ id: 'other', convId: 'chat-someone', localDay: '2026-11-10', user: 'not mine' }));
    await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ convId: 'chat-new', userId: 'u1', knownConvs: ['chat-old'], turnId: 't1', text: 'hi', tz: 'UTC' }) }).then((r) => r.text());
    expect((await store.turnsForUser('u1')).map((t) => t.user)).toEqual(['who won ipl 2025', 'hi']);
    expect((await store.getTurn('chat-someone', 'other'))?.userId).toBeUndefined();
  });

  it('rejects bad input', async () => {
    const { chat } = await start(new FakeModel());
    expect(await chat('', '')).toContain('required');
  });
});
