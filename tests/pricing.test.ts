import { assertAlmostEquals, assertEquals } from '@std/assert';

import { calculateCost, getModelInfo, getModelPricing } from '../src/providers/pricing.ts';

Deno.test('model prices come from the model\'s own provider, not resellers', () => {
	assertEquals(getModelInfo('gpt-4.1-mini')?.provider, 'openai');
	assertEquals(getModelInfo('gemini-2.5-flash')?.provider, 'google');
	assertEquals(getModelInfo('claude-haiku-4-5')?.provider, 'anthropic');
	// Resellers list Gemini 2.5 Flash far below Google's price.
	assertEquals(getModelPricing('gemini-2.5-flash')?.output, 2.5);
});

Deno.test('dated model IDs resolve to the base model', () => {
	assertEquals(getModelPricing('gpt-4.1-mini-2025-04-14')?.input, getModelPricing('gpt-4.1-mini')?.input);
});

Deno.test('the models cuery is commonly used with have prices', () => {
	for (const model of ['gpt-4.1-mini', 'gpt-5.4-mini', 'gemini-3.8-flash', 'claude-haiku-4-5', 'claude-sonnet-5-5']) {
		assertEquals(getModelPricing(model) != null, true, `no price for ${model}`);
	}
});

Deno.test('calculateCost without cache details charges all input at the input rate', () => {
	const cost = calculateCost('gpt-4.1-mini', { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });
	assertAlmostEquals(cost!.inputCost, 0.4);
	assertAlmostEquals(cost!.outputCost, 1.6);
});

Deno.test('calculateCost charges cached and cache-write tokens at their own rates', () => {
	// claude-sonnet-5-5: input 2, cache read 0.2, cache write 2.5, output 10 (USD per 1M).
	const cost = calculateCost('claude-sonnet-5-5', {
		inputTokens: 1_000_000,
		outputTokens: 100_000,
		totalTokens: 1_100_000,
		cachedInputTokens: 500_000,
		cacheWriteTokens: 200_000,
	});
	assertAlmostEquals(cost!.inputCost, 0.3 * 2 + 0.5 * 0.2 + 0.2 * 2.5);
	assertAlmostEquals(cost!.outputCost, 1);
});

Deno.test('calculateCost falls back to the input rate for cached tokens without a cache price', () => {
	const pricing = getModelPricing('gpt-4.1-mini')!;
	const cost = calculateCost('gpt-4.1-mini', { inputTokens: 1_000, outputTokens: 0, totalTokens: 1_000, cachedInputTokens: 1_000 });
	assertAlmostEquals(cost!.inputCost, (1_000 * (pricing.cacheRead ?? pricing.input)) / 1_000_000);
});
