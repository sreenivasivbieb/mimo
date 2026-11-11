// Model calls behind a small interface so tests can swap in a fake.
// Provider by MODEL_PROVIDER (groq | anthropic); tiers map to MODEL_FAST / MODEL_MAIN / MODEL_DEEP.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import Groq from 'groq-sdk';
import { z } from 'zod';
import { WEB_SEARCH_TOOL } from './search.js';

export type Tier = 'fast' | 'main' | 'deep';
export type Msg = { role: 'user' | 'assistant'; content: string };
export type ToolCall = { id: string; name: string; input: unknown };
export type Usage = { input: number; output: number; cacheRead: number };

export interface Model {
  structured<T>(o: { tier: Tier; system: string; prompt: string; schema: z.ZodType<T>; signal?: AbortSignal }): Promise<{ value: T; usage: Usage }>;
  /** One writer/searcher call. With `onToolCalls`, the model may call web_search; we run it and loop. */
  run(o: {
    tier: Tier;
    system: string;
    messages: Msg[];
    onText?: (delta: string) => void;
    onToolCalls?: (calls: ToolCall[]) => Promise<string[]>;
    maxRounds?: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage: Usage }>;
}

const tierModel = (env: NodeJS.ProcessEnv, tier: Tier, fallback: string) =>
  env[{ fast: 'MODEL_FAST', main: 'MODEL_MAIN', deep: 'MODEL_DEEP' }[tier]] || fallback;

export type Provider = 'groq' | 'anthropic';

/** Groq unless MODEL_PROVIDER says otherwise (or only an Anthropic key is present). */
export function providerFromEnv(env = process.env): Provider {
  const p = env.MODEL_PROVIDER?.toLowerCase();
  if (p === 'groq' || p === 'anthropic') return p;
  return env.ANTHROPIC_API_KEY && !env.GROQ_API_KEY ? 'anthropic' : 'groq';
}

export function modelFromEnv(env = process.env): Model {
  return providerFromEnv(env) === 'groq' ? new GroqModel(env) : new AnthropicModel(env);
}

const DEFAULT_MODEL = 'claude-opus-5-5';
// Opus 5.5 always thinks; effort is the only depth control (its default is medium).
const EFFORT: Record<Tier, 'low' | 'medium' | 'high'> = { fast: 'low', main: 'medium', deep: 'high' };
// On a safety decline, the API re-runs the request on a fallback model it picks by category.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

export class AnthropicModel implements Model {
  private client = new Anthropic({ maxRetries: 2 });
  constructor(private env = process.env) {}

  private model(tier: Tier) {
    return tierModel(this.env, tier, DEFAULT_MODEL);
  }

  // Stable system prompt first and cached; the volatile per-turn block goes last in the user message.
  private system(text: string): Anthropic.Beta.BetaTextBlockParam[] {
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }

  async structured<T>(o: { tier: Tier; system: string; prompt: string; schema: z.ZodType<T>; signal?: AbortSignal }) {
    const res = await this.client.beta.messages.parse(
      {
        ...FALLBACK,
        model: this.model(o.tier),
        max_tokens: 16000,
        system: this.system(o.system),
        messages: [{ role: 'user', content: o.prompt }],
        output_config: { effort: EFFORT[o.tier], format: betaZodOutputFormat(o.schema) },
      },
      { signal: o.signal },
    );
    if (res.stop_reason === 'refusal') throw new Error('model declined the request');
    if (res.parsed_output == null) throw new Error(`structured output did not parse (stop_reason=${res.stop_reason})`);
    return { value: res.parsed_output as T, usage: usageOf(res.usage) };
  }

  async run(o: Parameters<Model['run']>[0]) {
    const messages: Anthropic.Beta.BetaMessageParam[] = o.messages.map((m) => ({ role: m.role, content: m.content }));
    const tools = o.onToolCalls ? [{ ...WEB_SEARCH_TOOL, eager_input_streaming: true }] : undefined;
    const maxRounds = o.maxRounds ?? 4;
    const usage: Usage = { input: 0, output: 0, cacheRead: 0 };
    let text = '';

    for (let round = 0; ; round++) {
      const lastRound = round >= maxRounds;
      const stream = this.client.beta.messages.stream(
        {
          ...FALLBACK,
          model: this.model(o.tier),
          max_tokens: 16000,
          system: this.system(o.system),
          messages,
          ...(tools ? { tools, tool_choice: { type: lastRound ? ('none' as const) : ('auto' as const) } } : {}),
          output_config: { effort: EFFORT[o.tier] },
        },
        { signal: o.signal },
      );
      stream.on('text', (delta) => {
        text += delta;
        o.onText?.(delta);
      });
      const msg = await stream.finalMessage();
      const u = usageOf(msg.usage);
      usage.input += u.input;
      usage.output += u.output;
      usage.cacheRead += u.cacheRead;

      if (msg.stop_reason === 'refusal') {
        const note = '\n\nI can’t help with that request.';
        text += note;
        o.onText?.(note);
        return { text, usage };
      }
      const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || !calls.length || !o.onToolCalls) return { text, usage };
      if (text && !text.endsWith('\n')) {
        text += '\n\n';
        o.onText?.('\n\n');
      }

      // Pass the assistant turn back unchanged (thinking blocks included), then all results in one user message.
      messages.push({ role: 'assistant', content: msg.content });
      const results = await o.onToolCalls(calls.map((c) => ({ id: c.id, name: c.name, input: c.input })));
      const content: Anthropic.Beta.BetaContentBlockParam[] = calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: results[i] }));
      if (round + 1 >= maxRounds) content.push({ type: 'text', text: 'Search budget reached. Answer now with what you have, and say what you could not check.' });
      messages.push({ role: 'user', content });
    }
  }
}

function usageOf(u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null }): Usage {
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
}

// ---------------- Groq ----------------
// gpt-oss models: local tool calling and strict JSON-schema output, but one tool call per turn
// (no parallel calls) and no structured output while streaming or with tools.
// Free/on-demand tiers cap tokens per minute (8000 on gpt-oss-120b), so every request is trimmed
// to GROQ_MAX_INPUT_TOKENS and requests rotate across GROQ_API_KEYS.

const GROQ_DEFAULTS: Record<Tier, string> = { fast: 'openai/gpt-oss-20b', main: 'openai/gpt-oss-120b', deep: 'openai/gpt-oss-120b' };
const STRICT_SCHEMA_MODELS = /^(openai\/gpt-oss-(20b|120b)|qwen\/qwen3\.8-27b|meta-models\/muse-spark-open)$/;
const CHARS_PER_TOKEN = 2.5; // URLs, tables and markdown tokenize densely; 3.5 under-counted by ~1.6×
const MAX_OUTPUT = 8000; // hidden reasoning counts against this, so it needs room above the visible answer

type GroqMsg = Groq.Chat.ChatCompletionMessageParam;

export function groqKeysFromEnv(env = process.env): string[] {
  const all = [...(env.GROQ_API_KEYS ?? '').split(/[\s,]+/), env.GROQ_API_KEY ?? ''].map((k) => k.trim()).filter(Boolean);
  return [...new Set(all)];
}

/** How long a rate-limited key should rest: retry-after, else Groq's token reset header, else 20 s. */
function restMs(err: unknown): number {
  const h = (err as { headers?: Headers | Record<string, string> })?.headers;
  const get = (name: string) => (h && typeof (h as Headers).get === 'function' ? (h as Headers).get(name) : (h as Record<string, string> | undefined)?.[name]) ?? null;
  const after = Number(get('retry-after'));
  if (Number.isFinite(after) && after > 0) return after * 1000;
  const reset = get('x-ratelimit-reset-tokens') ?? get('x-ratelimit-reset-requests');
  const m = reset?.match(/(?:(\d+)m)?([\d.]+)s/);
  if (m) return ((Number(m[1] ?? 0) * 60) + Number(m[2])) * 1000;
  return 20_000;
}

/**
 * Round-robin over API keys. A key that gets 429 (or a 5xx) rests for the time the API asks
 * and the call moves straight to the next key; if every key is resting, wait for the first to wake.
 */
export class GroqKeyRotator {
  private keys: { client: Groq; until: number; label: string }[];
  private next = 0;
  constructor(keys: string[], baseURL?: string, private log?: (l: string) => void) {
    if (!keys.length) throw new Error('No Groq API key: set GROQ_API_KEY or GROQ_API_KEYS in .env');
    this.keys = keys.map((k, i) => ({ client: new Groq({ apiKey: k, maxRetries: 0, ...(baseURL ? { baseURL } : {}) }), until: 0, label: `key${i + 1}` }));
  }
  get size() {
    return this.keys.length;
  }

  async call<R>(fn: (client: Groq) => Promise<R>, signal?: AbortSignal): Promise<R> {
    let last: unknown;
    for (let attempt = 0; attempt < this.keys.length + 3; attempt++) {
      const now = Date.now();
      const order = this.keys.map((_, i) => this.keys[(this.next + i) % this.keys.length]);
      const key = order.find((k) => k.until <= now);
      if (!key) {
        const wait = Math.min(Math.min(...this.keys.map((k) => k.until)) - now, 30_000);
        this.log?.(`[groq] all ${this.keys.length} keys rate-limited; waiting ${Math.ceil(wait / 1000)}s`);
        await sleep(wait, signal);
        continue;
      }
      this.next = (this.keys.indexOf(key) + 1) % this.keys.length;
      try {
        return await fn(key.client);
      } catch (err) {
        if (signal?.aborted) throw err;
        const status = (err as { status?: number })?.status;
        if (status === 429 || (status !== undefined && status >= 500)) {
          key.until = Date.now() + restMs(err);
          this.log?.(`[groq] ${key.label} got ${status}; resting ${Math.ceil(restMs(err) / 1000)}s, rotating`);
          last = err;
          continue;
        }
        throw err; // 400/401/413: another key won't help
      }
    }
    throw last;
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, Math.max(ms, 0));
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/** Keep the head (instructions) and the tail (the actual question), cut the middle. */
function squeeze(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = Math.min(1200, Math.floor(maxChars / 3));
  return `${text.slice(0, maxChars - tail - 40)}\n…[trimmed to fit the model's limit]…\n${text.slice(-tail)}`;
}

const msgChars = (m: GroqMsg) => String((m as { content?: unknown }).content ?? '').length + ('tool_calls' in m && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);

export class GroqModel implements Model {
  private keys: GroqKeyRotator;
  private budgetChars: number;
  constructor(private env = process.env, log?: (l: string) => void) {
    this.keys = new GroqKeyRotator(groqKeysFromEnv(env), env.GROQ_BASE_URL, log ?? ((l) => console.log(l)));
    this.budgetChars = Number(env.GROQ_MAX_INPUT_TOKENS || 5000) * CHARS_PER_TOKEN;
  }

  private model(tier: Tier) {
    return tierModel(this.env, tier, GROQ_DEFAULTS[tier]);
  }

  /** gpt-oss reasons before answering; keep that out of the visible text. */
  private reasoning(model: string, tier: Tier) {
    return model.startsWith('openai/gpt-oss') ? { reasoning_effort: EFFORT[tier], reasoning_format: 'hidden' as const } : {};
  }

  /**
   * Fit one request into the input budget: drop the oldest history pairs, then shorten older
   * search results, then squeeze the turn context (keeping its head and the user's question).
   */
  private fit(budgetChars: number, system: string, history: GroqMsg[], current: string, loop: GroqMsg[]): GroqMsg[] {
    let h = history;
    const l = loop.map((m) => ({ ...m })) as GroqMsg[];
    const total = () => system.length + current.length + h.reduce((n, m) => n + msgChars(m), 0) + l.reduce((n, m) => n + msgChars(m), 0);
    while (total() > budgetChars && h.length) h = h.slice(2);
    const tools = l.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    for (const [n, i] of tools.entries()) {
      if (total() <= budgetChars) break;
      const keep = n === tools.length - 1 ? 2500 : 500; // the newest result stays readable
      (l[i] as { content: string }).content = squeeze(String((l[i] as { content: string }).content), keep);
    }
    let cur = current;
    const over = total() - budgetChars;
    if (over > 0) cur = squeeze(current, Math.max(1500, current.length - over));
    return [{ role: 'system', content: system }, ...h, { role: 'user', content: cur }, ...l];
  }

  async structured<T>(o: { tier: Tier; system: string; prompt: string; schema: z.ZodType<T>; signal?: AbortSignal }) {
    const model = this.model(o.tier);
    const { $schema: _drop, ...schema } = z.toJSONSchema(o.schema) as Record<string, unknown>;
    const strict = STRICT_SCHEMA_MODELS.test(model);
    // Other models only get JSON-object mode, so they see the schema in the prompt and zod checks the result.
    const system = strict ? o.system : `${o.system}\n\nReply with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
    const room = Math.max(1500, this.budgetChars - system.length - JSON.stringify(schema).length);
    const send = (prompt: string) => this.keys.call(
      (client) =>
        client.chat.completions.create(
          {
            model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
            response_format: strict ? { type: 'json_schema', json_schema: { name: 'output', strict: true, schema } } : { type: 'json_object' },
            max_completion_tokens: MAX_OUTPUT,
            ...this.reasoning(model, o.tier),
          },
          { signal: o.signal },
        ),
      o.signal,
    );
    // 413 = this one request is bigger than the per-minute token cap: send it once more, much shorter.
    const res = await send(squeeze(o.prompt, room)).catch((err) => {
      if ((err as { status?: number })?.status !== 413) throw err;
      return send(squeeze(o.prompt, Math.floor(room * 0.5)));
    });
    const content = res.choices[0]?.message?.content ?? '';
    const parsed = o.schema.safeParse(JSON.parse(content || 'null'));
    if (!parsed.success) throw new Error(`structured output did not match the schema: ${parsed.error.message.slice(0, 200)}`);
    return { value: parsed.data, usage: groqUsage(res.usage) };
  }

  async run(o: Parameters<Model['run']>[0]) {
    const model = this.model(o.tier);
    const history = o.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }) as GroqMsg);
    const current = o.messages.at(-1)?.content ?? '';
    const loop: GroqMsg[] = [];
    const tools: Groq.Chat.ChatCompletionTool[] | undefined = o.onToolCalls
      ? [{ type: 'function', function: { name: WEB_SEARCH_TOOL.name, description: WEB_SEARCH_TOOL.description, parameters: WEB_SEARCH_TOOL.input_schema } }]
      : undefined;
    const maxRounds = o.maxRounds ?? 4;
    const usage: Usage = { input: 0, output: 0, cacheRead: 0 };
    let text = '';

    // gpt-oss may still call a tool under tool_choice "none" (Groq then errors), so the final round
    // sends no tools at all and hands the gathered results over as plain text.
    const flatten = (): GroqMsg[] => {
      const results = loop.filter((m) => m.role === 'tool').map((m) => String((m as { content: string }).content));
      return results.length ? [{ role: 'user', content: `Search results gathered so far:\n\n${results.join('\n\n')}\n\nNo more searches. Answer now with what you have, and say what you could not check.` }] : [];
    };
    let effort: Tier = o.tier;
    let budget = this.budgetChars;
    const request = (final: boolean) =>
      this.keys.call(
        (client) =>
          client.chat.completions.create(
            {
              model,
              // gpt-oss tries to call tools it has seen mentioned even when none are offered, and Groq rejects
              // that, so every tool-less request says plainly that the answer must be written now.
              messages: this.fit(budget, final || !tools ? `${o.system}\n\nNo tools are available for this reply. Do not try to search or call any tool. Write your final answer to the user now, as plain text, from the information provided; say what you could not verify.` : o.system, history, current, final ? flatten() : loop),
              stream: true,
              max_completion_tokens: MAX_OUTPUT,
              ...(tools && !final ? { tools, tool_choice: 'auto' as const } : {}),
              ...this.reasoning(model, effort),
            },
            { signal: o.signal },
          ),
        o.signal,
      );

    const consume = async (final: boolean) => {
      const stream = await request(final);
      let roundText = '';
      let finish = '';
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          roundText += delta.content;
          text += delta.content;
          o.onText?.(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const c = calls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
          calls.set(tc.index, c);
        }
        const u = (chunk as { x_groq?: { usage?: Groq.CompletionUsage | null } }).x_groq?.usage;
        if (u) {
          usage.input += u.prompt_tokens ?? 0;
          usage.output += u.completion_tokens ?? 0;
        }
      }
      if (process.env.MIMO_DEBUG) console.log(`[groq] round final=${final} finish=${finish} text=${roundText.length} calls=${calls.size}`);
      return { roundText, calls, finish };
    };

    for (let round = 0; ; round++) {
      let final = Boolean(tools) && round >= maxRounds;
      let out;
      try {
        out = await consume(final);
      } catch (err) {
        const status = (err as { status?: number })?.status;
        const msg = (err as Error)?.message ?? '';
        // Groq rejects a malformed tool call (wrong arguments, or any call when no tools were offered),
        // sometimes mid-stream: answer from what we have instead of failing the turn.
        const badTool = status === 400 || /tool call validation failed|tool choice is none|tool_use_failed/i.test(msg);
        if (o.signal?.aborted) throw err;
        if (status === 413 && budget === this.budgetChars) {
          budget = Math.floor(budget * 0.5); // bigger than the per-minute token cap: retry once, much shorter
          out = await consume(final);
        } else if (badTool && !(final && tools)) {
          if (process.env.MIMO_DEBUG) console.log(`[groq] bad tool call (${msg.slice(0, 80)}); retrying without tools`);
          final = true;
          out = await consume(true);
        } else throw err;
      }
      // Hidden reasoning can use up the output budget and leave no answer: retry once, thinking less.
      if (!text && !out.roundText && !out.calls.size && effort !== 'fast') {
        effort = 'fast';
        out = await consume(final);
      }
      const { roundText, calls } = out;

      if (final || !calls.size || !o.onToolCalls) return { text, usage };
      if (text && !text.endsWith('\n')) {
        text += '\n\n';
        o.onText?.('\n\n');
      }
      const list = [...calls.values()];
      loop.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: list.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } })),
      });
      // Arguments arrive as a JSON string; a malformed one goes back to the model as an error result.
      const parsed = list.map((c) => {
        try {
          return { id: c.id, name: c.name, input: JSON.parse(c.args || '{}') as unknown };
        } catch {
          return { id: c.id, name: c.name, input: { __invalid: c.args } };
        }
      });
      const results = await o.onToolCalls(parsed);
      list.forEach((c, i) => loop.push({ role: 'tool', tool_call_id: c.id, content: results[i] }));
    }
  }
}

function groqUsage(u?: Groq.CompletionUsage | null): Usage {
  return { input: u?.prompt_tokens ?? 0, output: u?.completion_tokens ?? 0, cacheRead: 0 };
}
