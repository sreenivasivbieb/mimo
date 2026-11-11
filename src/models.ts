// Model calls behind a small interface so tests can swap in a fake.
// Anthropic (Claude) only; tiers map to MODEL_FAST / MODEL_MAIN / MODEL_DEEP.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
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

export function modelFromEnv(env = process.env): Model {
  return new AnthropicModel(env);
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
