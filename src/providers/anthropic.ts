/**
 * Anthropic provider implementation (for Claude models).
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from '@zod/zod';
import type { TokenUsage } from '../response.ts';
import { SchemaValidationError } from './errors.ts';
import type { LLMProvider, LLMResponse, Message, ProviderParams } from './types.ts';

/** Default output budget; override with `params.max_tokens`. */
const DEFAULT_MAX_TOKENS = 32_000;

/**
 * Constraint keywords Claude's structured outputs don't accept. They are moved
 * into the field's description so the model still sees them, and the reply is
 * validated with the full Zod schema, so they are enforced after generation.
 */
const UNSUPPORTED_CONSTRAINTS = new Set([
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'multipleOf',
	'minLength',
	'maxLength',
	'maxItems',
	'uniqueItems',
]);

/** Keywords dropped without a trace (metadata, or not expressible for the model). */
const DROPPED_KEYWORDS = new Set(['$schema', 'propertyNames']);

/** Keywords whose value is a map of names to subschemas (the names are data, not keywords). */
const SUBSCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/** Keywords whose value is literal data and must be copied as is. */
const VALUE_KEYWORDS = new Set(['default', 'const', 'enum', 'examples', 'required']);

/**
 * Prepare a JSON schema for Claude's structured outputs: objects get
 * `additionalProperties: false`, unsupported constraints move into the
 * description, and `minItems` is only kept as 0 or 1.
 */
export function sanitizeSchemaForAnthropic(schema: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const dropped: Array<string> = [];

	for (const [key, value] of Object.entries(schema)) {
		if (DROPPED_KEYWORDS.has(key)) {
			continue;
		}
		if (VALUE_KEYWORDS.has(key)) {
			result[key] = value;
			continue;
		}
		if (SUBSCHEMA_MAPS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
			result[key] = Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([name, subschema]) => [
					name,
					subschema && typeof subschema === 'object' && !Array.isArray(subschema)
						? sanitizeSchemaForAnthropic(subschema as Record<string, unknown>)
						: subschema,
				]),
			);
			continue;
		}
		if (UNSUPPORTED_CONSTRAINTS.has(key) || (key === 'minItems' && !(typeof value === 'number' && value <= 1))) {
			dropped.push(`${key}: ${JSON.stringify(value)}`);
			continue;
		}
		if (key === 'additionalProperties') {
			result[key] = false;
			continue;
		}
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			result[key] = sanitizeSchemaForAnthropic(value as Record<string, unknown>);
		} else if (Array.isArray(value)) {
			result[key] = value.map((item) =>
				item && typeof item === 'object' && !Array.isArray(item)
					? sanitizeSchemaForAnthropic(item as Record<string, unknown>)
					: item
			);
		} else {
			result[key] = value;
		}
	}

	if (dropped.length > 0) {
		const note = `{${dropped.join(', ')}}`;
		result['description'] = typeof result['description'] === 'string' ? `${result['description']}\n\n${note}` : note;
	}
	if (result['type'] === 'object' && !('additionalProperties' in result)) {
		result['additionalProperties'] = false;
	}

	return result;
}

/** OpenAI reasoning efforts mapped to Claude's `output_config.effort`. */
const EFFORT_FROM_OPENAI: Record<string, string> = {
	none: 'low',
	minimal: 'low',
	low: 'low',
	medium: 'medium',
	high: 'high',
	xhigh: 'xhigh',
};

/**
 * Split caller params into Messages API fields and output_config. Tools in this
 * library pass OpenAI-style `reasoning: { effort }`; it becomes Claude's
 * `output_config.effort` instead of an unknown request field.
 */
export function toAnthropicParams(params: ProviderParams | undefined): {
	request: Record<string, unknown>;
	outputConfig: Record<string, unknown> | null;
} {
	const { output_config: outputConfig, reasoning, ...request } = (params ?? {}) as Record<string, unknown>;
	const config = { ...(outputConfig as Record<string, unknown> | undefined) };
	const effort = (reasoning as { effort?: unknown } | undefined)?.effort;
	if (typeof effort === 'string' && config.effort == null && EFFORT_FROM_OPENAI[effort] != null) {
		config.effort = EFFORT_FROM_OPENAI[effort];
	}
	return { request, outputConfig: Object.keys(config).length > 0 ? config : null };
}

const schemaCache = new Map<z.ZodTypeAny, Record<string, unknown>>();

function toAnthropicSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
	const cached = schemaCache.get(schema);
	if (cached) {
		return cached;
	}
	const jsonSchema = sanitizeSchemaForAnthropic(
		z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>,
	);
	schemaCache.set(schema, jsonSchema);
	return jsonSchema;
}

/**
 * Token usage in cuery's convention, where `inputTokens` is the whole prompt.
 * Anthropic reports uncached, cache-read and cache-write input separately.
 */
export function anthropicUsage(usage: {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
}): TokenUsage {
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheWrite = usage.cache_creation_input_tokens ?? 0;
	const inputTokens = usage.input_tokens + cacheRead + cacheWrite;
	return {
		inputTokens,
		outputTokens: usage.output_tokens,
		totalTokens: inputTokens + usage.output_tokens,
		cachedInputTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
	};
}

/**
 * Anthropic LLM provider (for Claude models).
 *
 * System messages become the `system` prompt. Structured output uses
 * `output_config.format` with a JSON schema generated from the Zod schema, and
 * the reply is validated with Zod. Anthropic request fields (`max_tokens`,
 * `thinking`, `output_config.effort`, ...) can be passed via `params`.
 * Requests stream, so large `max_tokens` values don't hit request timeouts.
 */
export class AnthropicProvider implements LLMProvider {
	readonly name = 'anthropic';
	private client: Anthropic;

	constructor(apiKey?: string) {
		const fetchOptions: Record<string, unknown> = {};
		const abortSignal = (globalThis as Record<string, unknown>).abortSignal;
		if (abortSignal) {
			fetchOptions.signal = abortSignal;
		}

		this.client = new Anthropic({
			apiKey: apiKey ?? Deno.env.get('ANTHROPIC_API_KEY'),
			fetchOptions,
		});
	}

	async complete<T>(
		messages: Message[],
		model: string,
		schema: z.ZodType<T> | null,
		params?: ProviderParams
	): Promise<LLMResponse<T>> {
		try {
			const system = messages
				.filter((m) => m.role === 'system')
				.map((m) => m.content)
				.join('\n\n');
			const conversation = messages
				.filter((m) => m.role !== 'system')
				.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
			if (conversation.length === 0) {
				return { parsed: null, text: null, usage: null, error: new Error('Anthropic requests need at least one user message') };
			}
			const { request, outputConfig } = toAnthropicParams(params);
			const format = schema != null ? { type: 'json_schema', schema: toAnthropicSchema(schema) } : null;

			const stream = this.client.messages.stream({
				max_tokens: DEFAULT_MAX_TOKENS,
				...request,
				model,
				...(system.length > 0 ? { system } : {}),
				messages: conversation,
				...(format != null || outputConfig != null
					? { output_config: { ...outputConfig, ...(format != null ? { format } : {}) } }
					: {}),
			} as Anthropic.MessageStreamParams);
			const response = await stream.finalMessage();

			const text = response.content
				.filter((block): block is Anthropic.TextBlock => block.type === 'text')
				.map((block) => block.text)
				.join('');
			const usage = anthropicUsage(response.usage);

			if (response.stop_reason === 'refusal') {
				return { parsed: null, text, usage, error: new Error('The model declined the request') };
			}
			if (response.stop_reason === 'max_tokens') {
				return { parsed: null, text, usage, error: new Error('The response hit max_tokens before completing') };
			}
			if (response.stop_reason === 'model_context_window_exceeded') {
				return { parsed: null, text, usage, error: new Error('The request exceeded the model\'s context window') };
			}

			if (schema != null) {
				try {
					return { parsed: schema.parse(JSON.parse(text)), text, usage, error: null };
				} catch (error) {
					return {
						parsed: null,
						text,
						usage,
						error: new SchemaValidationError(
							error instanceof Error ? error.message : String(error),
							error
						),
					};
				}
			}

			return { parsed: text as T, text, usage, error: null };
		} catch (error) {
			return {
				parsed: null,
				text: null,
				usage: null,
				error: error instanceof Error ? error : new Error(String(error)),
			};
		}
	}
}
