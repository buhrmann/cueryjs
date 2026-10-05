/**
 * OpenAI provider implementation.
 */

import OpenAI from '@openai/openai';
import { normalizeOpenAIParams } from './openai-params.ts';
import { z } from '@zod/zod';
import type { TokenUsage } from '../response.ts';
import { SchemaValidationError } from './errors.ts';
import type { LLMProvider, LLMResponse, Message, ProviderParams } from './types.ts';

type AutoParseableTextFormat<ParsedT> = OpenAI.Responses.ResponseFormatTextJSONSchemaConfig & {
	__output: ParsedT;
	$brand: 'auto-parseable-response-format';
	$parseRaw(content: string): ParsedT;
};

const zodTextFormatCache = new Map<z.ZodTypeAny, AutoParseableTextFormat<unknown>>();

/**
 * Sanitizes a JSON schema for OpenAI compatibility.
 * OpenAI's structured output has strict requirements:
 * - additionalProperties must be false (not empty object or missing)
 * - propertyNames is not permitted
 */
export function sanitizeSchemaForOpenAI(schema: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(schema)) {
		// Literal data: copy as is.
		if (key === 'default' || key === 'const' || key === 'enum' || key === 'examples' || key === 'required') {
			result[key] = value;
			continue;
		}

		// Maps of names to subschemas: the names are data, not keywords.
		if (
			(key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions')
			&& value && typeof value === 'object' && !Array.isArray(value)
		) {
			result[key] = Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([name, subschema]) => [
					name,
					subschema && typeof subschema === 'object' && !Array.isArray(subschema)
						? sanitizeSchemaForOpenAI(subschema as Record<string, unknown>)
						: subschema,
				]),
			);
			continue;
		}

		// Remove unsupported keys
		if (key === 'propertyNames') {
			continue;
		}

		// Handle additionalProperties - set to false for strict mode
		if (key === 'additionalProperties') {
			result[key] = false;
			continue;
		}

		// Recursively sanitize nested objects
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			result[key] = sanitizeSchemaForOpenAI(value as Record<string, unknown>);
		} else if (Array.isArray(value)) {
			result[key] = value.map(item =>
				item && typeof item === 'object' && !Array.isArray(item)
					? sanitizeSchemaForOpenAI(item as Record<string, unknown>)
					: item
			);
		} else {
			result[key] = value;
		}
	}

	// For object types without additionalProperties, add it as false
	if (result['type'] === 'object' && !('additionalProperties' in result)) {
		result['additionalProperties'] = false;
	}

	return result;
}

function getCachedZodTextFormat<T>(zodObject: z.ZodType<T>, name: string): AutoParseableTextFormat<T> {
	const cached = zodTextFormatCache.get(zodObject) as AutoParseableTextFormat<T> | undefined;

	if (cached && cached.name === name) {
		return cached;
	}

	const format = zodTextFormat(zodObject, name);
	zodTextFormatCache.set(zodObject, format);

	return format as AutoParseableTextFormat<T>;
}

function zodTextFormat(zodObject: z.ZodType, name: string): AutoParseableTextFormat<z.infer<typeof zodObject>> {
	const rawSchema = z.toJSONSchema(zodObject, { target: 'draft-7' });
	const sanitizedSchema = sanitizeSchemaForOpenAI(rawSchema as Record<string, unknown>);

	return {
		type: 'json_schema',
		name,
		strict: true,
		schema: sanitizedSchema,
		$brand: 'auto-parseable-response-format',
		$parseRaw: (content) => {
			try {
				return zodObject.parse(JSON.parse(content));
			} catch (error) {
				return new SchemaValidationError(
					error instanceof Error ? error.message : String(error),
					error
				);
			}
		},
		__output: undefined,
	};
}

/**
 * OpenAI LLM provider.
 */
export class OpenAIProvider implements LLMProvider {
	readonly name = 'openai';
	private client: OpenAI;

	constructor(apiKey?: string) {
		const fetchOptions: Record<string, unknown> = {};
		const abortSignal = (globalThis as Record<string, unknown>).abortSignal;
		if (abortSignal) {
			fetchOptions.signal = abortSignal;
		}

		this.client = new OpenAI({
			apiKey: apiKey ?? Deno.env.get('OPENAI_API_KEY'),
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
			const response = await this.client.responses.parse({
				...normalizeOpenAIParams(model, params),
				model,
				input: messages.map((m) => ({
					role: m.role,
					content: m.content,
				})),
				...(schema != null
					? {
						text: {
							format: getCachedZodTextFormat(schema, 'response'),
						},
					}
					: {}),
			});

			const usage: TokenUsage | null = response.usage
				? {
					inputTokens: response.usage.input_tokens,
					outputTokens: response.usage.output_tokens,
					totalTokens: response.usage.total_tokens,
					cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
					reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
				}
				: null;

			if (response.output_parsed instanceof Error) {
				const parseError = response.output_parsed;
				const error =
					parseError instanceof SchemaValidationError
						? parseError
						: new SchemaValidationError(parseError.message, parseError);
				return {
					parsed: null,
					text: response.output_text,
					usage,
					error,
				};
			}

			return {
				parsed: schema != null ? (response.output_parsed as T) : (response.output_text as T),
				text: response.output_text,
				usage,
				error: null,
			};
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
