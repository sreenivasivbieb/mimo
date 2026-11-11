// npm run demo:seed — writes a sample week of history for user "demo" in Postgres, spread over three chats
// (so recall across conversations can be tried). Open http://localhost:3000/?user=demo to chat on top of it.
// The prices below are illustrative demo values, not real quotes; a recheck will compare them with today's web.
import { claimId, storeFromEnv, type Store } from '../src/store.js';
import { addDays, localDay, safeZone } from '../src/time.js';
import type { Claim, Turn } from '../src/types.js';

export async function seed(store: Store, convId: string, today: string, tz = 'UTC', userId = convId) {
  // Three chats: the CRM one (convId), a notes one and a Node one, all belonging to the same user.
  const chats = [convId, `${convId}-notes`, `${convId}-node`];
  const seqs = new Map<string, number>();
  const mk = (seq: number, daysAgo: number, user: string, assistant: string, sources: Turn['sources'] = []): Turn => {
    const day = addDays(today, -daysAgo);
    const chat = seq <= 2 ? chats[0] : seq === 3 ? chats[1] : chats[2];
    const n = (seqs.get(chat) ?? 0) + 1;
    seqs.set(chat, n);
    return { id: `seed-${seq}`, convId: chat, userId, seq: n, ts: `${day}T10:${String(seq).padStart(2, '0')}:00.000Z`, tz, localDay: day, user, assistant, route: sources.length ? 'search' : 'smalltalk', status: 'complete', sources, evidence: [] };
  };
  const crmSources = [
    { id: 'S1', url: 'https://www.hubspot.com/pricing/crm', title: 'HubSpot CRM pricing', excerpt: 'Starter Customer Platform from $20/month per seat', complete: false },
    { id: 'S2', url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive pricing', excerpt: 'Essential $14 per seat/month billed annually', complete: false },
    { id: 'S3', url: 'https://www.zoho.com/crm/zohocrm-pricing.html', title: 'Zoho CRM pricing', excerpt: 'Standard $14 per user/month billed annually', complete: false },
  ];
  const turns = [
    mk(1, 8, 'What do HubSpot, Pipedrive and Zoho CRM cost for their cheapest paid plan?', 'Cheapest paid plans: HubSpot Starter from $20/seat/month [1](https://www.hubspot.com/pricing/crm), Pipedrive Essential $14/seat/month billed annually [2](https://www.pipedrive.com/en/pricing), Zoho CRM Standard $14/user/month billed annually [3](https://www.zoho.com/crm/zohocrm-pricing.html).', crmSources),
    mk(2, 8, 'Which of those has a free plan?', 'HubSpot and Zoho both offer free CRM tiers; Pipedrive offers a trial rather than a free plan [1](https://www.hubspot.com/pricing/crm).', [crmSources[0]]),
    mk(3, 6, 'Compare Notion and Obsidian for personal notes', 'Notion is cloud-first with databases and sharing; Obsidian stores local Markdown files with plugins and offline use. [This demo turn used no web search]'),
    mk(4, 2, 'What is the current Node.js LTS line?', 'Node.js publishes its active LTS line on the release schedule page; check nodejs.org for the current one.'),
    mk(5, 1, 'thanks!', 'Any time.'),
  ];
  const claims: Claim[] = [
    ['HubSpot', 'starter plan price', '$20/seat/month', crmSources[0]],
    ['Pipedrive', 'essential plan price', '$14/seat/month billed annually', crmSources[1]],
    ['Zoho CRM', 'standard plan price', '$14/user/month billed annually', crmSources[2]],
  ].map(([entity, attribute, value, src]) => ({ id: claimId('seed-1', entity as string, attribute as string), turnId: 'seed-1', day: turns[0].localDay, entity: entity as string, attribute: attribute as string, value: value as string, sourceUrl: (src as { url: string }).url }));
  for (const c of chats) await store.deleteConversation(c);
  for (const t of turns) await store.putTurn(t);
  await store.upsertClaims(convId, claims);
  return { turns, claims };
}

if (process.argv[1]?.endsWith('seed.ts')) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  const store = storeFromEnv();
  const tz = safeZone(process.env.AGENT_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const { turns } = await seed(store, 'demo', localDay(new Date(), tz), tz);
  await store.close?.();
  console.log(`Seeded ${turns.length} turns for user "demo" in 3 chats (${turns.map((t) => t.localDay).join(', ')}). Open http://localhost:3000/?user=demo&conv=demo`);
}
