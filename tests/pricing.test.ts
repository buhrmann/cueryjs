import { assertAlmostEquals, assertEquals } from '@std/assert';

import { calculateCost, getModelInfo, getModelPricing } from '../src/providers/pricing.ts';

Deno.test('model prices come from the model\'s own provider, not resellers', () => {
	assertEquals(getModelInfo('gpt-4.1-mini')?.provider, 'openai');
	assertEquals(getModelInfo('gemini-2.5-flash')?.provider, 'google');
	assertEquals(getModelInfo('claude-haiku-4-5')?.provider, 'anthropic');
});

Deno.test('retired models keep their price', () => {
	for (const model of ['gemini-2.0-flash', 'claude-sonnet-4-20250514', 'o1-mini']) {
		assertEquals(getModelPricing(model) != null, true, `no price for ${model}`);
	}
});

Deno.test('dated model IDs resolve to the base model', () => {
	assertEquals(getModelPricing('gpt-4.1-mini-2025-04-14')?.input, getModelPricing('gpt-4.1-mini')?.input);
});

Deno.test('Gemini stable versions resolve to the base model', () => {
	assertEquals(getModelPricing('gemini-2.0-flash-001'), getModelPricing('gemini-2.0-flash'));
	assertEquals(getModelInfo('gemini-2.0-flash-001')?.provider, 'google');
});

Deno.test('OpenAI snapshots missing from the catalog have OpenAI\'s prices', () => {
	assertEquals(getModelPricing('gpt-3.5-turbo-0125')?.input, 0.5);
	assertEquals(getModelPricing('gpt-3.5-turbo-0125')?.output, 1.5);
	assertEquals(getModelPricing('gpt-3.5-turbo-1106')?.input, 1);
	assertEquals(getModelPricing('gpt-3.5-turbo-instruct')?.output, 2);
});

Deno.test('the models cuery is commonly used with have prices', () => {
	for (const model of ['gpt-4.1-mini', 'gpt-5.4-mini', 'gemini-3.8-flash', 'claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']) {
		assertEquals(getModelPricing(model) != null, true, `no price for ${model}`);
	}
});

Deno.test('calculateCost without cache details charges all input at the input rate', () => {
	const pricing = getModelPricing('gpt-4.1-mini')!;
	const cost = calculateCost('gpt-4.1-mini', { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });
	assertAlmostEquals(cost!.inputCost, pricing.input);
	assertAlmostEquals(cost!.outputCost, pricing.output);
});

Deno.test('calculateCost charges cached and cache-write tokens at their own rates', () => {
	const pricing = getModelPricing('claude-sonnet-5-5')!;
	const cost = calculateCost('claude-sonnet-5-5', {
		inputTokens: 1_000_000,
		outputTokens: 100_000,
		totalTokens: 1_100_000,
		cachedInputTokens: 500_000,
		cacheWriteTokens: 200_000,
	});
	assertAlmostEquals(cost!.inputCost, 0.3 * pricing.input + 0.5 * pricing.cacheRead! + 0.2 * pricing.cacheWrite!);
	assertAlmostEquals(cost!.outputCost, 0.1 * pricing.output);
});

Deno.test('calculateCost clamps cache breakdowns to the input total', () => {
	const pricing = getModelPricing('claude-sonnet-5-5')!;
	const cost = calculateCost('claude-sonnet-5-5', { inputTokens: 100, outputTokens: 0, totalTokens: 100, cachedInputTokens: 500 });
	assertAlmostEquals(cost!.inputCost, (100 * pricing.cacheRead!) / 1_000_000);
});

Deno.test('calculateCost falls back to the input rate for cached tokens without a cache price', () => {
	const pricing = getModelPricing('gpt-4.1-mini')!;
	const cost = calculateCost('gpt-4.1-mini', { inputTokens: 1_000, outputTokens: 0, totalTokens: 1_000, cachedInputTokens: 1_000 });
	assertAlmostEquals(cost!.inputCost, (1_000 * (pricing.cacheRead ?? pricing.input)) / 1_000_000);
});
