// Fakes so every test runs without keys or network.
import type { Model, Msg, ToolCall, Usage } from '../src/models.js';
import { ExtractSchema, RouterSchema, TimeSchema, VerdictSchema, type RouterOut, type TimeOut } from '../src/prompts.js';
import type { SearchProvider, SearchQuery, SearchResult } from '../src/search.js';
import type { Route, Turn } from '../src/types.js';

const U: Usage = { input: 0, output: 0, cacheRead: 0 };

export function turn(p: Partial<Turn> & { user: string; localDay: string }): Turn {
  return {
    id: p.id ?? `t-${p.localDay}-${Math.random().toString(16).slice(2, 8)}`,
    convId: 'c1', seq: p.seq ?? 1, ts: p.ts ?? `${p.localDay}T10:00:00.000Z`, tz: 'UTC',
    route: (p.route ?? 'search') as Route, status: p.status ?? 'complete', sources: p.sources ?? [], evidence: [],
    assistant: p.assistant ?? 'ok', ...p,
  };
}

type Script = {
  router?: RouterOut;
  /** What the time-reading model returns. Left out, that call fails, so the date rules take over. */
  time?: TimeOut;
  extract?: { entity: string; attribute: string; value: string; sourceId: string }[];
  verdicts?: { claimId: string; verdict: 'held' | 'changed' | 'corrected' | 'could-not-verify'; newValue: string | null; evidence: string[]; note: string }[];
  /** Searches the writer/searcher asks for before answering. */
  searches?: string[];
  /** Answer text; may reference [S1], [T1]. */
  answer?: string | ((msgs: Msg[]) => string);
  delayMs?: number;
};

export class FakeModel implements Model {
  calls: { kind: string; tier: string; system: string; prompt?: string }[] = [];
  constructor(public script: Script = {}) {}
  async structured<T>(o: { tier: string; system: string; prompt: string; schema: unknown }) {
    this.calls.push({ kind: 'structured', tier: o.tier, system: o.system.slice(0, 30), prompt: o.prompt });
    if (o.schema === TimeSchema) {
      if (!this.script.time) throw new Error('time reader not scripted');
      return { value: this.script.time as T, usage: U };
    }
    if (o.schema === RouterSchema) return { value: (this.script.router ?? { route: 'search', entities: [], queries: [], domains: [], reason: '' }) as T, usage: U };
    if (o.schema === ExtractSchema) return { value: { claims: this.script.extract ?? [] } as T, usage: U };
    if (o.schema === VerdictSchema) return { value: { rows: this.script.verdicts ?? [] } as T, usage: U };
    throw new Error('unknown schema');
  }
  async run(o: { tier: string; system: string; messages: Msg[]; onText?: (d: string) => void; onToolCalls?: (c: ToolCall[]) => Promise<string[]>; signal?: AbortSignal }) {
    this.calls.push({ kind: 'run', tier: o.tier, system: o.system.slice(0, 30) });
    if (o.onToolCalls && this.script.searches?.length) {
      await o.onToolCalls(this.script.searches.map((q, i) => ({ id: `tu${i}`, name: 'web_search', input: { query: q } })));
    }
    if (this.script.delayMs) {
      await new Promise((r, j) => {
        const t = setTimeout(r, this.script.delayMs);
        o.signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); });
      });
    }
    const text = typeof this.script.answer === 'function' ? this.script.answer(o.messages) : this.script.answer ?? 'Hello!';
    // Stream in small pieces so citation tags get split across deltas.
    for (let i = 0; i < text.length; i += 3) o.onText?.(text.slice(i, i + 3));
    return { text, usage: U };
  }
}

export class FakeSearch implements SearchProvider {
  name = 'fake';
  queries: SearchQuery[] = [];
  constructor(private results: (q: SearchQuery) => SearchResult[] = () => []) {}
  async search(q: SearchQuery) {
    this.queries.push(q);
    return this.results(q);
  }
}
