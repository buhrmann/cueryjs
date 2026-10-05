import { assertEquals } from '@std/assert';
import { z } from '@zod/zod';

import { anthropicUsage, sanitizeSchemaForAnthropic } from '../src/providers/anthropic.ts';
import { getProviderForModel } from '../src/providers/registry.ts';

Deno.test('claude models use the Anthropic provider', () => {
	assertEquals(getProviderForModel('claude-sonnet-5-5', 'test-key').name, 'anthropic');
	assertEquals(getProviderForModel('gpt-4.1-mini', 'test-key').name, 'openai');
});

Deno.test('sanitizeSchemaForAnthropic closes objects and drops unsupported constraints', () => {
	const schema = z.object({
		name: z.string().min(1).max(40),
		count: z.number().int().min(0).max(10),
		tags: z.array(z.string()).min(1).max(5),
		pairs: z.array(z.string()).min(2),
		nested: z.object({ ok: z.boolean() }),
	});
	const json = sanitizeSchemaForAnthropic(z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>);
	const properties = json.properties as Record<string, Record<string, unknown>>;

	assertEquals(json.additionalProperties, false);
	assertEquals('$schema' in json, false);
	assertEquals(properties.name, { type: 'string' });
	assertEquals('minimum' in properties.count || 'maximum' in properties.count, false);
	assertEquals(properties.tags.minItems, 1);
	assertEquals('maxItems' in properties.tags, false);
	assertEquals('minItems' in properties.pairs, false);
	assertEquals(properties.nested.additionalProperties, false);
});

Deno.test('anthropicUsage reports the whole prompt as input, with cache reads and writes split out', () => {
	assertEquals(
		anthropicUsage({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200 }),
		{ inputTokens: 1_300, outputTokens: 50, totalTokens: 1_350, cachedInputTokens: 1_000, cacheWriteTokens: 200 },
	);
	assertEquals(
		anthropicUsage({ input_tokens: 100, output_tokens: 50 }),
		{ inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0 },
	);
});
