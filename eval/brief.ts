// npm run brief — stores three earlier conversations for user "brief" in Postgres, then asks the
// brief's sample questions from brand-new chats against the real model and search, printing each answer.
// The stored values are what "we" said back then (illustrative); the rechecks compare them with today's web.
import { runTurn } from '../src/graph.js';
import { modelFromEnv } from '../src/models.js';
import { searchFromEnv } from '../src/search.js';
import { claimId, storeFromEnv, type Store } from '../src/store.js';
import { addDays, localDay } from '../src/time.js';
import type { AgentEvent, Claim, Source, Turn } from '../src/types.js';

try {
  process.loadEnvFile('.env');
} catch {}

const USER = 'brief';
const TZ = 'Asia/Kolkata';

type Seed = { conv: string; daysAgo: number; user: string; assistant: string; sources: Omit<Source, 'id' | 'complete'>[]; claims: [entity: string, attribute: string, value: string, sourceIndex: number][] };

function seeds(): Seed[] {
  return [
    {
      conv: 'brief-crm', daysAgo: 2, // Monday
      user: 'Shortlist 5 CRM tools for our 20-person sales team, with per-seat pricing.',
      assistant: [
        'Here is a shortlist for a 20-seat sales team (annual billing):',
        '',
        '| Tool | Plan | Price per seat / month |',
        '|---|---|---|',
        '| HubSpot Sales Hub | Professional | $100 [1](https://www.hubspot.com/pricing/sales) |',
        '| Salesforce Sales Cloud | Enterprise | $165 [2](https://www.salesforce.com/sales/pricing/) |',
        '| Pipedrive | Professional | $49 [3](https://www.pipedrive.com/en/pricing) |',
        '| Zoho CRM | Enterprise | $40 [4](https://www.zoho.com/crm/zohocrm-pricing.html) |',
        '| Freshsales | Pro | $47 [5](https://www.freshworks.com/crm/pricing/) |',
      ].join('\n'),
      sources: [
        { url: 'https://www.hubspot.com/pricing/sales', title: 'HubSpot Sales Hub pricing', excerpt: 'Sales Hub Professional $100/seat/month billed annually' },
        { url: 'https://www.salesforce.com/sales/pricing/', title: 'Salesforce Sales Cloud pricing', excerpt: 'Enterprise $165 USD/user/month billed annually' },
        { url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive pricing', excerpt: 'Professional $49 per seat/month billed annually' },
        { url: 'https://www.zoho.com/crm/zohocrm-pricing.html', title: 'Zoho CRM pricing', excerpt: 'Enterprise $40 per user/month billed annually' },
        { url: 'https://www.freshworks.com/crm/pricing/', title: 'Freshsales pricing', excerpt: 'Pro $47/user/month billed annually' },
      ],
      claims: [
        ['HubSpot Sales Hub', 'professional price per seat', '$100/seat/month', 0],
        ['Salesforce Sales Cloud', 'enterprise price per user', '$165/user/month', 1],
        ['Pipedrive', 'professional price per seat', '$49/seat/month', 2],
        ['Zoho CRM', 'enterprise price per user', '$40/user/month', 3],
        ['Freshsales', 'pro price per user', '$47/user/month', 4],
      ],
    },
    {
      conv: 'brief-node', daysAgo: 8, // Tuesday 3 November
      user: 'Which Node.js version should I use for a new production app?',
      assistant: 'Use **Node.js 22**: it is the current Active LTS line and is supported until April 2027 [1](https://nodejs.org/en/about/previous-releases).',
      sources: [{ url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js releases', excerpt: 'Node.js 22 Active LTS, end of life April 2027' }],
      claims: [
        ['Node.js', 'recommended active lts version', 'Node.js 22', 0],
        ['Node.js 22', 'end of life', 'April 2027', 0],
      ],
    },
    {
      conv: 'brief-pg', daysAgo: 1, // Tuesday 10 November ("last Tuesday" asked on a Wednesday)
      user: 'Compare pricing for managed Postgres hosting for a small app: Neon, Supabase and AWS RDS.',
      assistant: [
        'For a small app:',
        '- **Neon** Launch plan from $19/month [1](https://neon.com/pricing)',
        '- **Supabase** Pro plan $25/month per organization, including compute credits [2](https://supabase.com/pricing)',
        '- **AWS RDS for PostgreSQL** db.t4g.micro about $0.016/hour on demand in us-east-1 (≈ $12/month) [3](https://aws.amazon.com/rds/postgresql/pricing/)',
      ].join('\n'),
      sources: [
        { url: 'https://neon.com/pricing', title: 'Neon pricing', excerpt: 'Launch plan from $19/month' },
        { url: 'https://supabase.com/pricing', title: 'Supabase pricing', excerpt: 'Pro $25/month per organization, includes $10 compute credits' },
        { url: 'https://aws.amazon.com/rds/postgresql/pricing/', title: 'Amazon RDS for PostgreSQL pricing', excerpt: 'db.t4g.micro $0.016 per hour On-Demand us-east-1' },
      ],
      claims: [
        ['Neon', 'launch plan price', '$19/month', 0],
        ['Supabase', 'pro plan price', '$25/month', 1],
        ['AWS RDS for PostgreSQL', 'db.t4g.micro on-demand price', '$0.016/hour', 2],
      ],
    },
  ];
}

const QUESTIONS = [
  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
  'What did I ask you on 3 November? Is your answer still correct today?',
  'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
];

async function seedAll(store: Store, today: string) {
  for (const sd of seeds()) {
    await store.deleteConversation(sd.conv);
    const day = addDays(today, -sd.daysAgo);
    const sources: Source[] = sd.sources.map((s, i) => ({ id: `S${i + 1}`, complete: false, ...s }));
    const turn: Turn = { id: `${sd.conv}-1`, convId: sd.conv, userId: USER, seq: 1, ts: `${day}T05:30:00.000Z`, tz: TZ, localDay: day, user: sd.user, assistant: sd.assistant, route: 'search', status: 'complete', sources, evidence: [] };
    await store.putTurn(turn);
    const claims: Claim[] = sd.claims.map(([entity, attribute, value, i]) => ({ id: claimId(turn.id, entity, attribute), turnId: turn.id, day, entity, attribute, value, sourceUrl: sources[i].url }));
    await store.upsertClaims(sd.conv, claims);
    console.log(`seeded ${sd.conv} on ${day}: "${sd.user}" (${claims.length} claims)`);
  }
}

async function main() {
  const store = storeFromEnv();
  const today = localDay(new Date(), TZ);
  await seedAll(store, today);
  const model = modelFromEnv();
  const search = searchFromEnv();

  for (const [i, q] of QUESTIONS.entries()) {
    const conv = `brief-q${i + 1}`;
    await store.deleteConversation(conv);
    const events: AgentEvent[] = [];
    const logs: string[] = [];
    const turn: Turn = { id: `${conv}-1`, convId: conv, userId: USER, seq: 1, ts: new Date().toISOString(), tz: TZ, localDay: today, user: q, route: 'search', status: 'complete', sources: [], evidence: [] };
    const t0 = Date.now();
    let failed = '';
    try {
      await runTurn({ model, search, store, emit: (e) => events.push(e), log: (l) => logs.push(l) }, { turn, locale: 'en-IN' });
    } catch (e) {
      failed = (e as Error).message;
    }
    const stored = await store.getTurn(conv, turn.id);
    const text = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    console.log(`\n${'='.repeat(100)}\nQ${i + 1}: ${q}\nroute: ${stored?.route ?? '?'} · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${logs.find((l) => l.startsWith('[router]')) ?? ''}`);
    for (const e of events) if (e.type === 'status' && e.text !== 'Thinking…') console.log(`  › ${e.text}`);
    console.log(`\n${text}`);
    for (const e of events) if (e.type === 'note' || e.type === 'error') console.log(`\n  [${e.type}] ${'text' in e ? e.text : e.message}`);
    if (failed) console.log(`\n  [failed] ${failed}`);
  }
  await store.close?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
