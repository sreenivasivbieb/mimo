// The one model-visible tool. Executed by our code (not provider-side) so the
// writer can stream and every result lands in the turn's evidence with its date.
import type { Source } from './types.js';

export type SearchQuery = {
  query: string;
  startDate?: string; // YYYY-MM-DD; the baseline on rechecks
  endDate?: string;
  domains?: string[]; // vendor restriction for price/plan/launch questions
  max?: number;
};
export type SearchResult = Omit<Source, 'id'>;

export interface SearchProvider {
  name: string;
  search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]>;
}

const TIMEOUT_MS = 15_000;
const MAX_EXCERPT = 8_000;

const toDay = (s?: string | null) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

/** fetch with a per-call timeout, the caller's abort, and backoff with jitter on 429/5xx. */
async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal, retries = 2): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const s = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
    const res = await fetch(url, { ...init, signal: s });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new Error(`search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt + Math.random() * 300;
    await new Promise((r) => setTimeout(r, Math.min(wait, 8_000)));
  }
}

export class TavilySearch implements SearchProvider {
  name = 'tavily';
  constructor(private key: string) {}
  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query: q.query,
      max_results: q.max ?? 4,
      search_depth: 'basic',
      // Page text only for vendor-restricted queries: pricing often hides from snippets.
      include_raw_content: q.domains?.length ? 'text' : false,
    };
    if (q.domains?.length) body.include_domains = q.domains;
    if (q.startDate) body.start_date = q.startDate;
    if (q.endDate) body.end_date = q.endDate;
    const data = await fetchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body),
    }, signal);
    return (data.results ?? []).map((r: any) => {
      const raw: string | undefined = r.raw_content ?? undefined;
      const text = raw && raw.length > (r.content?.length ?? 0) ? raw : r.content ?? '';
      return {
        url: r.url,
        title: r.title ?? r.url,
        pageDate: toDay(r.published_date),
        excerpt: text.slice(0, MAX_EXCERPT),
        complete: Boolean(raw) && text.length <= MAX_EXCERPT,
      };
    });
  }
}

export class BraveSearch implements SearchProvider {
  name = 'brave';
  constructor(private key: string) {}
  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const sites = q.domains?.length ? ` (${q.domains.map((d) => `site:${d}`).join(' OR ')})` : '';
    const params = new URLSearchParams({ q: q.query + sites, count: String(q.max ?? 4) });
    if (q.startDate) params.set('freshness', `${q.startDate}to${q.endDate ?? new Date().toISOString().slice(0, 10)}`);
    const data = await fetchJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { accept: 'application/json', 'x-subscription-token': this.key },
    }, signal);
    return (data.web?.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title ?? r.url,
      pageDate: toDay(r.page_age),
      excerpt: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(' … ').replace(/<[^>]+>/g, ''),
      complete: false,
    }));
  }
}

/** Short-lived cache keyed by query + window; the day is part of the key so "now" never goes stale across midnight. */
export class CachedSearch implements SearchProvider {
  private cache = new Map<string, { at: number; results: SearchResult[] }>();
  constructor(private inner: SearchProvider, private ttlMs = 10 * 60_000) {}
  get name() {
    return this.inner.name;
  }
  async search(q: SearchQuery, signal?: AbortSignal) {
    const key = JSON.stringify([q.query.toLowerCase().trim(), q.startDate, q.endDate, q.domains?.slice().sort(), q.max, new Date().toISOString().slice(0, 10)]);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.results;
    const results = await this.inner.search(q, signal);
    this.cache.set(key, { at: Date.now(), results });
    return results;
  }
}

export class NoSearch implements SearchProvider {
  name = 'none';
  async search(): Promise<SearchResult[]> {
    throw new Error('No search provider configured: set TAVILY_API_KEY or BRAVE_API_KEY in .env');
  }
}

export function searchFromEnv(env = process.env): SearchProvider {
  if (env.TAVILY_API_KEY) return new CachedSearch(new TavilySearch(env.TAVILY_API_KEY));
  if (env.BRAVE_API_KEY) return new CachedSearch(new BraveSearch(env.BRAVE_API_KEY));
  return new NoSearch();
}

/** JSON schema for the tool the model sees. */
export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the web. Returns results with IDs like S3, titles, URLs, page dates and excerpts. ' +
    'Write neutral queries (never include the answer you expect). For prices, plans or launches, pass the vendor domain(s) in `domains`. ' +
    'Pass start_date/end_date (YYYY-MM-DD) when the question is about a period; never put relative ranges like "past week" in the query text. ' +
    'This is the only tool: there is no page-fetch or browse tool. To read a specific page, search for it with its domain in `domains`.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Neutral search query' },
      domains: { type: 'array', items: { type: 'string' }, description: 'Restrict to these domains, e.g. ["hubspot.com"]' },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};
