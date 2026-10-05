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
 * JSON Schema keywords Claude's structured outputs don't accept. The reply is
 * still validated with the full Zod schema, so these constraints are enforced
 * after generation instead.
 */
const UNSUPPORTED_KEYWORDS = new Set([
	'$schema',
	'propertyNames',
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

/**
 * Prepare a JSON schema for Claude's structured outputs: objects get
 * `additionalProperties: false`, unsupported constraint keywords are dropped,
 * and `minItems` is only kept as 0 or 1.
 */
export function sanitizeSchemaForAnthropic(schema: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(schema)) {
		if (UNSUPPORTED_KEYWORDS.has(key)) {
			continue;
		}
		if (key === 'minItems') {
			if (typeof value === 'number' && value <= 1) {
				result[key] = value;
			}
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

	if (result['type'] === 'object' && !('additionalProperties' in result)) {
		result['additionalProperties'] = false;
	}

	return result;
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
			const { output_config: outputConfig, ...rest } = (params ?? {}) as Record<string, unknown>;
			const format = schema != null ? { type: 'json_schema', schema: toAnthropicSchema(schema) } : null;

			const stream = this.client.messages.stream({
				max_tokens: DEFAULT_MAX_TOKENS,
				...rest,
				model,
				...(system.length > 0 ? { system } : {}),
				messages: messages
					.filter((m) => m.role !== 'system')
					.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
				...(format != null || outputConfig != null
					? { output_config: { ...(outputConfig as Record<string, unknown> | undefined), ...(format != null ? { format } : {}) } }
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
