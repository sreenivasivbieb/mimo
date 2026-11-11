import { describe, expect, it } from 'vitest';
import { runTurn } from '../src/graph.js';
import { SEARCHER_SYSTEM } from '../src/prompts.js';
import { MemoryStore, claimId } from '../src/store.js';
import type { AgentEvent, Turn } from '../src/types.js';
import { FakeModel, FakeSearch, turn } from './helpers.js';

const NOW = '2026-11-11T10:00:00.000Z'; // Wednesday

function setup(model: FakeModel, search = new FakeSearch()) {
  const store = new MemoryStore();
  const events: AgentEvent[] = [];
  const ask = async (text: string, id = `q${Math.random().toString(16).slice(2, 8)}`) => {
    const t: Turn = { ...turn({ id, user: text, localDay: '', ts: NOW, seq: await store.nextSeq('c1') }), assistant: undefined };
    events.length = 0;
    await runTurn({ model, search, store, emit: (e) => events.push(e) }, { turn: t, locale: 'en-GB' });
    return { stored: (await store.getTurn('c1', id))!, text: events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join(''), events: [...events] };
  };
  return { store, ask, search };
}

const crmTurn = () =>
  turn({
    id: 'a', seq: 1, localDay: '2026-11-03', ts: '2026-11-03T09:00:00.000Z', user: 'What does HubSpot Starter cost?', assistant: 'HubSpot Starter is $20 per seat [1](https://hubspot.com/pricing).',
    sources: [{ id: 'S1', url: 'https://hubspot.com/pricing', title: 'Pricing', excerpt: 'Starter $20 per seat', complete: true, pageDate: '2026-10-01' }],
  });

describe('graph routes', () => {
  it('smalltalk skips search and the router model call', async () => {
    const model = new FakeModel({ answer: 'Hi! What can I look up for you?' });
    const { ask, search } = setup(model);
    const r = await ask('hello!');
    expect(r.stored.route).toBe('smalltalk');
    expect(search.queries).toHaveLength(0);
    expect(model.calls.filter((c) => c.kind === 'structured')).toHaveLength(0);
    expect(model.calls[0].tier).toBe('fast');
    expect(r.text).toBe('Hi! What can I look up for you?');
  });

  it('memory question with no turn that day gets the fixed no-record reply, no model call', async () => {
    const model = new FakeModel();
    const { ask, store } = setup(model);
    await store.putTurn(crmTurn());
    const r = await ask('what did I ask on 5 November?');
    expect(r.stored.route).toBe('memory_only');
    expect(r.text).toMatch(/no record/i);
    expect(r.text).toMatch(/Tuesday, 3 November 2026|Tuesday 3 November 2026/);
    expect(model.calls).toHaveLength(0);
  });

  it('memory question finds the day and links the earlier turn', async () => {
    const model = new FakeModel({ answer: 'On Tuesday 3 November you asked what HubSpot Starter costs [T1].' });
    const { ask, store } = setup(model);
    await store.putTurn(crmTurn());
    const r = await ask('what did I ask on 3 November?');
    expect(r.stored.route).toBe('memory_only');
    expect(r.text).toContain('(#turn-a)');
    // buffered route: one token event with the whole checked answer
    expect(r.events.filter((e) => e.type === 'token')).toHaveLength(1);
  });

  it('search cites real URLs and stores claims with deterministic IDs', async () => {
    const model = new FakeModel({
      router: { route: 'search', entities: ['HubSpot'], queries: ['HubSpot pricing'], domains: ['hubspot.com'], reason: '' },
      searches: ['HubSpot Starter price'],
      answer: 'HubSpot Starter costs $20 per seat [S1]. Ignore [S7].',
      extract: [{ entity: 'HubSpot', attribute: 'Starter price', value: '$20 per seat', sourceId: 'S1' }],
    });
    const search = new FakeSearch(() => [{ url: 'https://hubspot.com/pricing', title: 'HubSpot pricing', excerpt: 'Starter: $20 per seat / month', complete: true, pageDate: '2026-11-01' }]);
    const { ask, store } = setup(model, search);
    const r = await ask('How much is HubSpot Starter?', 'q-search');
    expect(r.text).toBe('HubSpot Starter costs $20 per seat [1](https://hubspot.com/pricing). Ignore .');
    expect(r.events.some((e) => e.type === 'status' && e.text.startsWith('Searching'))).toBe(true);
    expect(r.stored.sources.map((s) => s.url)).toEqual(['https://hubspot.com/pricing']);
    expect(r.stored.evidence[0].sourceId).toBe('S1');
    const claims = await store.claims('c1');
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe(claimId('q-search', 'HubSpot', 'starter price'));
    expect(claims[0].pageDate).toBe('2026-11-01');
  });

  it('flags a price that is not in the cited page text', async () => {
    const model = new FakeModel({ searches: ['x'], answer: 'It costs $25 [S1].' });
    const search = new FakeSearch(() => [{ url: 'https://v.com', title: 'v', excerpt: 'It costs $20.', complete: true }]);
    const { ask } = setup(model, search);
    const r = await ask('price of v?');
    expect(r.events.some((e) => e.type === 'note' && e.text.includes('$25'))).toBe(true);
  });
});

describe('recheck', () => {
  const recheckModel = (verdict: 'changed' | 'held', entities = ['HubSpot']) =>
    new FakeModel({
      router: { route: 'recheck', entities, queries: [], domains: ['hubspot.com'], reason: '' },
      searches: ['HubSpot pricing'],
      verdicts: [{ claimId: 'CLAIM', verdict, newValue: verdict === 'changed' ? '$25' : null, evidence: ['S1'], note: '' }],
      answer: 'HubSpot raised Starter to $25 [S1].',
    });

  async function seeded(model: FakeModel) {
    const search = new FakeSearch(() => [{ url: 'https://hubspot.com/blog/new-pricing', title: 'New pricing', excerpt: 'From 8 November Starter is $25 per seat.', complete: true, pageDate: '2026-11-08' }]);
    const ctx = setup(model, search);
    await ctx.store.putTurn(crmTurn());
    const id = claimId('a', 'HubSpot', 'starter price');
    await ctx.store.upsertClaims('c1', [{ id, turnId: 'a', day: '2026-11-03', entity: 'HubSpot', attribute: 'starter price', value: '$20', sourceUrl: 'https://hubspot.com/pricing' }]);
    model.script.verdicts = model.script.verdicts?.map((v) => ({ ...v, claimId: id }));
    return ctx;
  }

  it('verdict table, explanation and a bottom line that matches the table', async () => {
    const model = recheckModel('changed');
    const ctx = await seeded(model);
    const r = await ctx.ask('Has HubSpot pricing changed since 3 November?');
    expect(r.stored.route).toBe('recheck');
    expect(r.text).toMatch(/\| HubSpot \| starter price \| \$20 \| \$25 \| \*\*changed\*\*/);
    expect(r.text).toContain('**Bottom line:** 0 held, 1 changed, 0 corrected, 0 could not verify.');
    expect(model.calls.find((c) => c.kind === 'run' && c.tier === 'deep')).toBeTruthy();
    // the checked verdict becomes the next baseline; no extraction model call on rechecks
    const next = (await ctx.store.claims('c1')).find((c) => c.value === '$25');
    expect(next).toMatchObject({ entity: 'HubSpot', pageDate: '2026-11-08', supersedes: claimId('a', 'HubSpot', 'starter price') });
  });

  it('routes the brief\'s recheck phrasings to recheck even when the router model says otherwise', async () => {
    for (const q of [
      'What did I ask you on 3 November? Is your answer still correct today?',
      'On 3 November I asked about HubSpot. Has any of them changed pricing or shipped something big since?',
      'I asked you about HubSpot pricing on 3 November. Has any pricing changed since then?',
    ]) {
      const model = recheckModel('changed');
      model.script.router = { route: 'memory_only', entities: ['HubSpot'], queries: [], domains: [], reason: '' };
      const { ask } = await seeded(model);
      const r = await ask(q);
      expect(r.stored.route, q).toBe('recheck');
      expect(r.text, q).toContain('**Bottom line:**');
    }
  });

  it('"is it still accurate / true / valid / up to date?" is a recheck of that day, not a search for the word', async () => {
    for (const q of [
      'What did I ask you on November 3rd? Is it still accurate?',
      'What did I ask you on 3 Nov? Is that still true?',
      'What did I ask on 3 November, and is your answer still valid?',
      'What did I ask you on 3 November? Is the answer up to date?',
    ]) {
      const model = recheckModel('changed');
      model.script.router = { route: 'memory_only', entities: [], queries: [], domains: [], reason: '' };
      const { ask } = await seeded(model);
      const r = await ask(q);
      expect(r.stored.route, q).toBe('recheck');
      expect(r.text, q).not.toMatch(/no mention/i);
    }
  });

  it('"…or shipped something big since?" adds a date-bounded launch search per entity', async () => {
    const model = recheckModel('held');
    const ctx = await seeded(model);
    await ctx.ask('On 3 November I asked about HubSpot. Has it changed pricing or shipped something big since?');
    const news = ctx.search.queries.find((q) => /launch/.test(q.query));
    expect(news).toMatchObject({ startDate: '2026-11-03' });
    expect(news?.domains).toBeUndefined();
  });

  it('downgrades a verdict whose evidence does not hold up', async () => {
    const model = recheckModel('held'); // claims $20 held, but the cited page says $25
    const { ask } = await seeded(model);
    const r = await ask('Is your HubSpot answer from 3 November still correct?');
    expect(r.text).toContain('**could-not-verify**');
    expect(r.text).toContain('0 held');
    expect(r.events.some((e) => e.type === 'note' && /Downgraded/.test(e.text))).toBe(true);
  });

  it('shows a different value from an undated page without claiming changed', async () => {
    const model = recheckModel('changed');
    const search = new FakeSearch(() => [{ url: 'https://hubspot.com/pricing', title: 'Pricing', excerpt: 'Starter is $25 per seat.', complete: true }]);
    const ctx = setup(model, search);
    await ctx.store.putTurn(crmTurn());
    const id = claimId('a', 'HubSpot', 'starter price');
    await ctx.store.upsertClaims('c1', [{ id, turnId: 'a', day: '2026-11-03', entity: 'HubSpot', attribute: 'starter price', value: '$20', sourceUrl: 'https://hubspot.com/pricing' }]);
    model.script.verdicts = model.script.verdicts?.map((v) => ({ ...v, claimId: id }));
    const r = await ctx.ask('Is your HubSpot answer from 3 November still correct?');
    expect(r.text).toMatch(/\| HubSpot \| starter price \| \$20 \| \$25 \(undated\) \| \*\*could-not-verify\*\* \[1\]/);
    expect(r.text).toContain('0 changed');
  });

  it('rechecks the entities named in the stored claims, not the question summary', async () => {
    const model = recheckModel('held', ['5 CRM tools']);
    const { ask } = await seeded(model);
    await ask('Has HubSpot pricing changed since 3 November?');
    // one searcher, for the claim's entity
    expect(model.calls.filter((c) => c.system === SEARCHER_SYSTEM.slice(0, 30))).toHaveLength(1);
  });

  it('fans out one searcher per entity above three entities', async () => {
    const entities = ['HubSpot', 'Pipedrive', 'Zoho', 'Salesforce', 'Close'];
    const model = recheckModel('changed', entities);
    const { ask, store } = await seeded(model);
    await store.upsertClaims('c1', entities.slice(1).map((e) => ({ id: claimId('a', e, 'price'), turnId: 'a', day: '2026-11-03', entity: e, attribute: 'price', value: '$10', sourceUrl: 'u' })));
    await ask('Has anything changed since 3 November for HubSpot, Pipedrive, Zoho, Salesforce and Close?');
    expect(model.calls.filter((c) => c.system === SEARCHER_SYSTEM.slice(0, 30))).toHaveLength(5);
  });

  it('asks instead of inventing a baseline when there is no history and nothing named', async () => {
    const model = new FakeModel({ router: { route: 'recheck', entities: [], queries: [], domains: [], reason: '' }, answer: 'Which products should I re-check? Best guess: ...' });
    const { ask, search } = setup(model);
    const r = await ask('is your answer still correct?');
    expect(r.stored.route).toBe('clarify');
    expect(search.queries).toHaveLength(0);
  });
});

describe('memory questions (did we discuss X?)', () => {
  const iplTurn = () =>
    turn({
      id: 'ipl', seq: 1, localDay: '2026-11-11', ts: '2026-11-11T08:00:00.000Z', user: 'search me who won ipl 2025',
      assistant: 'Royal Challengers Bengaluru (RCB) won the 2025 IPL title [1](https://www.bbc.com/sport/cricket).',
      sources: [{ id: 'S1', url: 'https://www.bbc.com/sport/cricket', title: 'BBC', excerpt: 'RCB win IPL 2025', complete: false }],
    });

  it('with no history, "did we discussed about rcb" says no — no guess, no model call', async () => {
    const model = new FakeModel({ router: { route: 'clarify', entities: [], queries: [], domains: [], reason: '' } });
    const { ask } = setup(model);
    const r = await ask('did we discussed about rcb');
    expect(r.stored.route).toBe('memory_only');
    expect(r.text).toBe("No — we haven't discussed rcb yet. There are no earlier messages.");
    expect(r.text).not.toMatch(/best guess/i);
    expect(model.calls).toHaveLength(0);
  });

  it('"did we ever researched about ipl" finds the earlier turn and links it', async () => {
    const model = new FakeModel({ answer: 'Yes. Earlier today you asked who won IPL 2025 and I searched it [T1].' });
    const { ask, store } = setup(model);
    await store.putTurn(iplTurn());
    const r = await ask('did we ever researched about ipl');
    expect(r.stored.route).toBe('memory_only');
    expect(r.text).toContain('(#turn-ipl)');
  });

  it('"what are all topics that we discussed on ipl" lists mentions instead of asking', async () => {
    const model = new FakeModel({ answer: 'We discussed one IPL topic: who won IPL 2025 [T1].' });
    const { ask, store } = setup(model);
    await store.putTurn(iplTurn());
    const r = await ask('no what are all topics that we discussed on ipl');
    expect(r.stored.route).toBe('memory_only');
    expect(r.text).toContain('(#turn-ipl)');
  });

  it('says "no mention" for a topic that never came up, listing the days we have', async () => {
    const model = new FakeModel();
    const { ask, store } = setup(model);
    await store.putTurn(iplTurn());
    const r = await ask('have we talked about football?');
    expect(r.text).toMatch(/^I found no mention of football in this conversation\. The days I do have messages from are: Wednesday/);
    expect(model.calls).toHaveLength(0);
  });

  it('memory guard replaces an uncited claim about past turns', async () => {
    const model = new FakeModel({
      router: { route: 'clarify', entities: [], queries: [], domains: [], reason: '' },
      answer: 'Which team do you mean?\n\n**Best guess:** We might have talked about their recent match results.',
    });
    const { ask } = setup(model);
    const r = await ask('tell me more about that team');
    expect(r.text).not.toMatch(/talked about/);
    expect(r.text).toMatch(/no record/i);
  });

  it('a new request phrased with "what can you search" is not a memory question', async () => {
    const model = new FakeModel({ router: { route: 'search', entities: [], queries: [], domains: [], reason: '' }, answer: 'Sure.' });
    const { ask } = setup(model);
    const r = await ask('what can you search about rcb');
    expect(r.stored.route).toBe('search');
  });
});

describe('follow-ups and clarify loops', () => {
  const clarifyTurn = (seq: number, user: string, assistant: string) =>
    turn({ id: `c${seq}`, seq, localDay: '2026-11-11', ts: `2026-11-11T05:3${seq}:00.000Z`, user, assistant, route: 'clarify' });

  it('the router sees the recent conversation, so "what it is" can be resolved', async () => {
    const model = new FakeModel({ router: { route: 'search', entities: ['Tavily'], queries: ['Tavily'], domains: [], reason: '' }, answer: 'Tavily is a search API.' });
    const { ask, store } = setup(model);
    await store.putTurn(turn({ id: 'p1', seq: 1, localDay: '2026-11-11', user: 'whats tavilly', assistant: 'Tavily is a web search API for AI agents.' }));
    await ask('what it is');
    const routerCall = model.calls.find((c) => c.kind === 'structured')!;
    expect(routerCall.prompt).toContain('Recent conversation');
    expect(routerCall.prompt).toContain('User: whats tavilly');
  });

  it('never asks a clarifying question twice in a row: the reply is treated as the answer', async () => {
    const model = new FakeModel({ router: { route: 'clarify', entities: ['Tavily'], queries: [], domains: [], reason: '' }, answer: 'Tavily is a search API for LLM apps.' });
    const { ask, store } = setup(model);
    await store.putTurn(clarifyTurn(1, 'whats tavilly', 'Could you specify what "tavilly" refers to?'));
    const r = await ask('tavily yes i mean');
    expect(r.stored.route).toBe('search');
  });
});

describe('memory across conversations (same user)', () => {
  // A user with two earlier chats; questions are asked from a brand-new chat.
  async function world(model: FakeModel) {
    const store = new MemoryStore();
    const old = (id: string, convId: string, day: string, user: string, assistant: string) =>
      store.putTurn({ ...turn({ id, convId, seq: 1, localDay: day, ts: `${day}T09:00:00.000Z`, user, assistant }), userId: 'u1' });
    await old('crm', 'chat-crm', '2026-11-03', 'What does HubSpot Starter cost?', 'HubSpot Starter is $20 per seat.');
    await old('ipl', 'chat-ipl', '2026-11-09', 'who won ipl 2025', 'RCB won IPL 2025.');
    await store.putTurn({ ...turn({ id: 'stranger', convId: 'chat-x', seq: 1, localDay: '2026-11-03', user: 'someone else asked about football' }), userId: 'u2' });
    const events: AgentEvent[] = [];
    const ask = async (text: string, id: string) => {
      const t: Turn = { ...turn({ id, convId: 'chat-new', user: text, localDay: '', ts: NOW, seq: await store.nextSeq('chat-new') }), userId: 'u1', assistant: undefined };
      events.length = 0;
      await runTurn({ model, search: new FakeSearch(), store, emit: (e) => events.push(e) }, { turn: t, locale: 'en-GB' });
      return { stored: (await store.getTurn('chat-new', id))!, text: events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('') };
    };
    return { store, ask };
  }

  it('a new chat answers "what did I ask on 3 November?" from the earlier chat, linking into it', async () => {
    const model = new FakeModel({ answer: 'On Tuesday 3 November, in an earlier chat, you asked what HubSpot Starter costs [T1].' });
    const { ask } = await world(model);
    const r = await ask('what did I ask on 3 November?', 'n1');
    expect(r.stored.route).toBe('memory_only');
    expect(r.text).toContain('[↩ Tue 3 Nov, other chat](/?conv=chat-crm#turn-crm)');
  });

  it('asks which day — listing the days and chats — when no date is given, without a model call', async () => {
    const model = new FakeModel();
    const { ask } = await world(model);
    const r = await ask('what did we discuss in our previous conversation?', 'n1');
    expect(r.stored.route).toBe('clarify');
    expect(r.text).toMatch(/^Which day do you mean\? I have messages from:/);
    expect(r.text).toContain('Monday, 9 November 2026');
    expect(r.text).toContain('"who won ipl 2025"');
    expect(r.text).toContain('Tuesday, 3 November 2026');
    expect(r.text).not.toContain('football'); // another user's chats are never shown
    expect(model.calls).toHaveLength(0);
  });

  it('the date given in reply is applied to the original question', async () => {
    const model = new FakeModel({ answer: 'On Monday 9 November you asked who won IPL 2025 [T1].' });
    const { ask } = await world(model);
    await ask('what did we discuss in our previous conversation?', 'n1');
    const r = await ask('9 November', 'n2');
    expect(r.stored.route).toBe('memory_only');
    expect(r.text).toContain('(/?conv=chat-ipl#turn-ipl)');
  });

  it('topic recall ignores earlier "did we discuss X?" turns and finds the real one', async () => {
    const model = new FakeModel({ answer: 'Yes — on Monday 9 November you asked who won IPL 2025 [T1].' });
    const { ask, store } = await world(model);
    // an earlier memory question about IPL, answered "no", in yet another chat
    await store.putTurn({ ...turn({ id: 'meta', convId: 'chat-meta', seq: 1, localDay: '2026-11-10', ts: '2026-11-10T09:00:00.000Z', user: 'did we discussed about ipl recently', assistant: "No — we haven't discussed ipl yet.", route: 'memory_only' }), userId: 'u1' });
    const r = await ask('did we discussed about ipl recently ??', 'n1');
    expect(r.stored.route).toBe('memory_only');
    expect(r.text).toContain('(/?conv=chat-ipl#turn-ipl)');
    expect(r.text).not.toContain('chat-meta');
  });

  it('"did we discuss X?" searches every chat of this user, and only this user', async () => {
    const model = new FakeModel();
    const { ask } = await world(model);
    expect((await ask('did we discuss football?', 'n1')).text).toMatch(/^I found no mention of football in any of our conversations/);
  });
});

