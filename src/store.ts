// History lives in Postgres (PgStore). MemoryStore is the same contract in-process, for tests and evals.
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Claim, Turn } from './types.js';

export interface Store {
  turns(convId: string): Promise<Turn[]>; // ordered by seq, every status
  getTurn(convId: string, turnId: string): Promise<Turn | undefined>;
  nextSeq(convId: string): Promise<number>;
  putTurn(turn: Turn): Promise<void>; // upsert by (convId, id)
  claims(convId: string): Promise<Claim[]>;
  claimsFor(convId: string, entity: string): Promise<Claim[]>;
  upsertClaims(convId: string, claims: Claim[]): Promise<void>;
  days(convId: string): Promise<string[]>; // local days with complete turns, newest first
  deleteConversation(convId: string): Promise<void>;
  /** Every turn of every conversation this user has had, ordered by time. */
  turnsForUser(userId: string): Promise<Turn[]>;
  claimsForUser(userId: string): Promise<Claim[]>;
  /** Attach a conversation started before user IDs existed to this user. */
  adoptConversation(convId: string, userId: string): Promise<void>;
  close?(): Promise<void>;
}

export const claimId = (turnId: string, entity: string, attribute: string) =>
  createHash('sha256').update(`${turnId}|${normEntity(entity)}|${attribute.toLowerCase().trim()}`).digest('hex').slice(0, 16);

/** "HubSpot, Inc." and "hubspot.com" both become "hubspot". */
export function normEntity(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(com|io|ai|co|app|net|org)\b/g, '')
    .replace(/\b(inc|ltd|llc|corp|corporation|gmbh)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const entityMatches = (stored: string, asked: string) => {
  const a = normEntity(stored);
  const b = normEntity(asked);
  return a === b || a.includes(b) || b.includes(a);
};

// ---------------- Postgres ----------------

const SCHEMA = `
create table if not exists turns (
  conv_id    text        not null,
  id         text        not null,
  seq        integer     not null,
  ts         timestamptz not null,
  tz         text        not null,
  local_day  date        not null,
  user_text  text        not null,
  assistant  text,
  route      text        not null,
  status     text        not null check (status in ('complete', 'cancelled', 'error')),
  sources    jsonb       not null default '[]',
  evidence   jsonb       not null default '[]',
  primary key (conv_id, id)
);
create index if not exists turns_conv_seq on turns (conv_id, seq);
create index if not exists turns_conv_day on turns (conv_id, local_day) where status = 'complete';
alter table turns add column if not exists user_id text;
create index if not exists turns_user_day on turns (user_id, local_day) where status = 'complete';

create table if not exists claims (
  id          text primary key,
  conv_id     text not null,
  turn_id     text not null,
  day         date not null,
  entity      text not null,
  entity_norm text not null,
  attribute   text not null,
  value       text not null,
  source_url  text not null,
  page_date   date,
  supersedes  text,
  foreign key (conv_id, turn_id) references turns (conv_id, id) on delete cascade
);
create index if not exists claims_conv_entity on claims (conv_id, entity_norm);
`;

// DATE columns come back as 'YYYY-MM-DD' strings, not JS Dates shifted by the server zone.
const types = { getTypeParser: (oid: number, format?: any) => (oid === 1082 ? (v: string) => v : pg.types.getTypeParser(oid, format)) };

const toTurn = (r: any): Turn => ({
  id: r.id, convId: r.conv_id, ...(r.user_id ? { userId: r.user_id } : {}), seq: r.seq, ts: new Date(r.ts).toISOString(), tz: r.tz, localDay: r.local_day,
  user: r.user_text, assistant: r.assistant ?? undefined, route: r.route, status: r.status, sources: r.sources, evidence: r.evidence,
});
const toClaim = (r: any): Claim => ({
  id: r.id, turnId: r.turn_id, day: r.day, entity: r.entity, attribute: r.attribute, value: r.value, sourceUrl: r.source_url,
  ...(r.page_date ? { pageDate: r.page_date } : {}), ...(r.supersedes ? { supersedes: r.supersedes } : {}),
});

export class PgStore implements Store {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, types, connectionTimeoutMillis: 5_000 });
    this.pool.on('error', (e) => console.error('[db] idle client error:', e.message));
    this.ready = this.pool.query(SCHEMA).then(() => undefined);
  }

  private async q(sql: string, params: unknown[] = []) {
    await this.ready;
    return (await this.pool.query(sql, params)).rows;
  }

  async turns(convId: string) {
    return (await this.q('select * from turns where conv_id = $1 order by seq', [convId])).map(toTurn);
  }
  async getTurn(convId: string, turnId: string) {
    const [r] = await this.q('select * from turns where conv_id = $1 and id = $2', [convId, turnId]);
    return r ? toTurn(r) : undefined;
  }
  async nextSeq(convId: string) {
    const [r] = await this.q('select coalesce(max(seq), 0) + 1 as n from turns where conv_id = $1', [convId]);
    return Number(r.n);
  }
  async putTurn(t: Turn) {
    await this.q(
      `insert into turns (conv_id, id, seq, ts, tz, local_day, user_text, assistant, route, status, sources, evidence, user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (conv_id, id) do update set
         assistant = excluded.assistant, route = excluded.route, status = excluded.status,
         sources = excluded.sources, evidence = excluded.evidence, user_id = coalesce(excluded.user_id, turns.user_id)`,
      [t.convId, t.id, t.seq, t.ts, t.tz, t.localDay, t.user, t.assistant ?? null, t.route, t.status, JSON.stringify(t.sources), JSON.stringify(t.evidence), t.userId ?? null],
    );
  }
  async claims(convId: string) {
    return (await this.q('select * from claims where conv_id = $1 order by day, id', [convId])).map(toClaim);
  }
  async claimsFor(convId: string, entity: string) {
    const key = normEntity(entity);
    if (!key) return [];
    const rows = await this.q(
      `select * from claims where conv_id = $1
         and (entity_norm = $2 or entity_norm like '%' || $2 || '%' or $2 like '%' || entity_norm || '%')
       order by day, id`,
      [convId, key],
    );
    return rows.map(toClaim);
  }
  async upsertClaims(convId: string, claims: Claim[]) {
    if (!claims.length) return;
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const c of claims) {
        await client.query(
          `insert into claims (id, conv_id, turn_id, day, entity, entity_norm, attribute, value, source_url, page_date, supersedes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (id) do update set value = excluded.value, source_url = excluded.source_url,
             page_date = excluded.page_date, supersedes = excluded.supersedes`,
          [c.id, convId, c.turnId, c.day, c.entity, normEntity(c.entity), c.attribute, c.value, c.sourceUrl, c.pageDate ?? null, c.supersedes ?? null],
        );
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
  async days(convId: string) {
    const rows = await this.q(`select distinct local_day from turns where conv_id = $1 and status = 'complete' order by local_day desc`, [convId]);
    return rows.map((r) => r.local_day as string);
  }
  async turnsForUser(userId: string) {
    return (await this.q('select * from turns where user_id = $1 order by ts, seq', [userId])).map(toTurn);
  }
  async claimsForUser(userId: string) {
    const rows = await this.q(
      `select c.* from claims c join turns t on t.conv_id = c.conv_id and t.id = c.turn_id
       where t.user_id = $1 order by c.day, c.id`,
      [userId],
    );
    return rows.map(toClaim);
  }
  async adoptConversation(convId: string, userId: string) {
    await this.q('update turns set user_id = $2 where conv_id = $1 and user_id is null', [convId, userId]);
  }
  async deleteConversation(convId: string) {
    await this.q('delete from turns where conv_id = $1', [convId]); // claims cascade
    await this.q('delete from claims where conv_id = $1', [convId]);
  }
  async close() {
    await this.pool.end();
  }
}

// ---------------- in-process (tests, evals) ----------------

export class MemoryStore implements Store {
  private t = new Map<string, Map<string, Turn>>();
  private c = new Map<string, Map<string, Claim>>();
  private conv<T>(m: Map<string, Map<string, T>>, id: string) {
    if (!m.has(id)) m.set(id, new Map());
    return m.get(id)!;
  }
  async turns(convId: string) {
    return [...this.conv(this.t, convId).values()].sort((a, b) => a.seq - b.seq);
  }
  async getTurn(convId: string, turnId: string) {
    return this.conv(this.t, convId).get(turnId);
  }
  async nextSeq(convId: string) {
    return (await this.turns(convId)).reduce((m, t) => Math.max(m, t.seq), 0) + 1;
  }
  async putTurn(turn: Turn) {
    this.conv(this.t, turn.convId).set(turn.id, structuredClone(turn));
  }
  async claims(convId: string) {
    return [...this.conv(this.c, convId).values()].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
  }
  async claimsFor(convId: string, entity: string) {
    return (await this.claims(convId)).filter((c) => entityMatches(c.entity, entity));
  }
  async upsertClaims(convId: string, claims: Claim[]) {
    for (const c of claims) this.conv(this.c, convId).set(c.id, { ...c });
  }
  async days(convId: string) {
    const set = new Set((await this.turns(convId)).filter((t) => t.status === 'complete').map((t) => t.localDay));
    return [...set].sort().reverse();
  }
  async deleteConversation(convId: string) {
    this.t.delete(convId);
    this.c.delete(convId);
  }
  async turnsForUser(userId: string) {
    return [...this.t.values()].flatMap((m) => [...m.values()]).filter((t) => t.userId === userId).sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  }
  async claimsForUser(userId: string) {
    const mine = new Set((await this.turnsForUser(userId)).map((t) => `${t.convId}|${t.id}`));
    return [...this.c.entries()].flatMap(([conv, m]) => [...m.values()].filter((c) => mine.has(`${conv}|${c.turnId}`)));
  }
  async adoptConversation(convId: string, userId: string) {
    for (const t of this.conv(this.t, convId).values()) if (!t.userId) t.userId = userId;
  }
}

/**
 * The app's store: Postgres at MIMO_DATABASE_URL. A dedicated name (not DATABASE_URL) so a
 * DATABASE_URL exported for some other project never gets Mimo's tables.
 */
export function storeFromEnv(env = process.env): Store {
  if (!env.MIMO_DATABASE_URL) throw new Error('MIMO_DATABASE_URL is not set. Run `npm run db:up` and copy .env.example to .env.');
  return new PgStore(env.MIMO_DATABASE_URL);
}
