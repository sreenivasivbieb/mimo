// GroqModel against a local stand-in for the Groq API: request shape, streamed tool calls, strict schema.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GroqModel, groqKeysFromEnv, providerFromEnv } from '../src/models.js';
import { RouterSchema } from '../src/prompts.js';

const bodies: any[] = [];
let base = '';
const server = createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data);
    bodies.push({ path: req.url, body, auth: req.headers.authorization });
    if (req.headers.authorization === 'Bearer limited') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      return res.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' } }));
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ route: 'search', entities: ['HubSpot'], queries: ['hubspot pricing'], domains: ['hubspot.com'], reason: 'price' }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (choice: object, extra: object = {}) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`);
    const hasToolResult = body.messages.some((m: any) => m.role === 'tool') || !body.tools;
    if (!hasToolResult) {
      // tool call arrives in two argument fragments
      send({ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"HubSpot ' } }] }, finish_reason: null });
      send({ delta: { tool_calls: [{ index: 0, function: { arguments: 'pricing","domains":["hubspot.com"]}' } }] }, finish_reason: null });
      send({ delta: {}, finish_reason: 'tool_calls' }, { x_groq: { usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } } });
    } else {
      send({ delta: { role: 'assistant', content: 'Starter is ' }, finish_reason: null });
      send({ delta: { content: '$20 [S1].' }, finish_reason: 'stop' }, { x_groq: { usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } } });
    }
    res.end('data: [DONE]\n\n');
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const quiet = () => {};
const model = () => new GroqModel({ GROQ_API_KEY: 'test', GROQ_BASE_URL: base } as NodeJS.ProcessEnv, quiet);

describe('GroqModel', () => {
  it('streams text, runs the tool call, sends the result back as a tool message', async () => {
    bodies.length = 0;
    let streamed = '';
    const seen: unknown[] = [];
    const out = await model().run({
      tier: 'main', system: 'sys', messages: [{ role: 'user', content: 'price?' }],
      onText: (d) => (streamed += d),
      onToolCalls: async (calls) => {
        seen.push(...calls);
        return ['[S1] HubSpot pricing — Starter $20'];
      },
    });
    expect(seen).toEqual([{ id: 'call_1', name: 'web_search', input: { query: 'HubSpot pricing', domains: ['hubspot.com'] } }]);
    expect(out.text).toBe('Starter is $20 [S1].');
    expect(streamed).toBe(out.text);
    expect(out.usage).toMatchObject({ input: 60, output: 14 });
    const [first, second] = bodies.map((b) => b.body);
    expect(bodies[0].path).toBe('/openai/v1/chat/completions');
    expect(first).toMatchObject({ model: 'openai/gpt-oss-120b', stream: true, tool_choice: 'auto', reasoning_effort: 'medium', reasoning_format: 'hidden' });
    expect(first.tools[0].function.name).toBe('web_search');
    expect(second.messages.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function' }] });
    expect(second.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '[S1] HubSpot pricing — Starter $20' });
  });

  it('uses strict json_schema output on gpt-oss and validates with zod', async () => {
    bodies.length = 0;
    const { value } = await model().structured({ tier: 'fast', system: 'route it', prompt: 'hubspot price?', schema: RouterSchema });
    expect(value.route).toBe('search');
    const body = bodies[0].body;
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.reasoning_effort).toBe('low');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  it('falls back to json_object mode with the schema in the prompt for other models', async () => {
    bodies.length = 0;
    const m = new GroqModel({ GROQ_API_KEY: 'test', GROQ_BASE_URL: base, MODEL_FAST: 'llama-3.3-70b-versatile' } as NodeJS.ProcessEnv, quiet);
    await m.structured({ tier: 'fast', system: 'route it', prompt: 'x', schema: RouterSchema });
    const body = bodies[0].body;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain('JSON Schema');
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe('final round', () => {
  it('sends no tools and hands over gathered results as text once the round limit is hit', async () => {
    bodies.length = 0;
    const out = await model().run({
      tier: 'main', system: 'sys', messages: [{ role: 'user', content: 'price?' }], maxRounds: 1,
      onToolCalls: async () => ['[S1] HubSpot pricing — Starter $20'],
    });
    expect(out.text).toBe('Starter is $20 [S1].');
    const last = bodies.at(-1)!.body;
    expect(last.tools).toBeUndefined();
    expect(last.messages.some((m: any) => m.role === 'tool' || m.tool_calls)).toBe(false);
    expect(last.messages.at(-1).content).toMatch(/Search results gathered so far:[\s\S]*Starter \$20[\s\S]*No more searches/);
  });
});

describe('key rotation and budget', () => {
  it('reads and dedupes keys from GROQ_API_KEYS and GROQ_API_KEY', () => {
    expect(groqKeysFromEnv({ GROQ_API_KEYS: 'a, b,a', GROQ_API_KEY: 'c' } as NodeJS.ProcessEnv)).toEqual(['a', 'b', 'c']);
  });

  it('a rate-limited key rests and the call moves to the next key', async () => {
    bodies.length = 0;
    const logs: string[] = [];
    const m = new GroqModel({ GROQ_API_KEYS: 'limited,good', GROQ_BASE_URL: base } as NodeJS.ProcessEnv, (l) => logs.push(l));
    const first = await m.structured({ tier: 'fast', system: 's', prompt: 'p', schema: RouterSchema });
    expect(first.value.route).toBe('search');
    expect(bodies.map((b) => b.auth)).toEqual(['Bearer limited', 'Bearer good']);
    expect(logs.join()).toMatch(/key1 got 429; resting 30s/);
    // the resting key is skipped on the next call
    bodies.length = 0;
    await m.structured({ tier: 'fast', system: 's', prompt: 'p', schema: RouterSchema });
    expect(bodies.map((b) => b.auth)).toEqual(['Bearer good']);
  });

  it('trims history and squeezes the turn context to the input budget, keeping the question', async () => {
    bodies.length = 0;
    const m = new GroqModel({ GROQ_API_KEY: 'test', GROQ_BASE_URL: base, GROQ_MAX_INPUT_TOKENS: '1000' } as NodeJS.ProcessEnv, quiet);
    const history = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `old ${i} `.repeat(200) }));
    await m.run({ tier: 'main', system: 'sys', messages: [...history, { role: 'user', content: 'CONTEXT '.repeat(2000) + 'What is the price?' }] });
    const sent = bodies[0].body.messages;
    const chars = sent.reduce((n: number, x: any) => n + String(x.content ?? '').length, 0);
    expect(chars).toBeLessThanOrEqual(1000 * 3.5 + 100);
    expect(sent.filter((x: any) => String(x.content).startsWith('old'))).toHaveLength(0);
    expect(sent.at(-1).content).toMatch(/trimmed to fit/);
    expect(sent.at(-1).content.endsWith('What is the price?')).toBe(true);
  });
});

describe('providerFromEnv', () => {
  it('defaults to groq, honours MODEL_PROVIDER, picks anthropic when only its key is set', () => {
    expect(providerFromEnv({} as NodeJS.ProcessEnv)).toBe('groq');
    expect(providerFromEnv({ MODEL_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv)).toBe('anthropic');
    expect(providerFromEnv({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBe('anthropic');
    expect(providerFromEnv({ ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'g' } as NodeJS.ProcessEnv)).toBe('groq');
  });
});
