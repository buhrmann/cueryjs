/**
 * Model pricing lookup and cost calculation.
 *
 * Pricing data is bundled from models.dev at build time.
 * Run `deno task update-models` to refresh the data.
 */

import modelsData from '../assets/models.json' with { type: 'json' };
import type { TokenUsage, UsageCost } from '../response.ts';

/**
 * Pricing information for a model (USD per 1M tokens).
 */
export interface ModelPricing {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
}

/**
 * Model information including pricing and limits.
 */
export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	pricing: ModelPricing | null;
	contextLimit: number | null;
	outputLimit: number | null;
	capabilities: {
		structuredOutput: boolean;
		toolCall: boolean;
		reasoning: boolean;
	};
}

// Types for the models.json structure
interface ModelEntry {
	id: string;
	name: string;
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		reasoning?: number;
	};
	limit?: {
		context?: number;
		output?: number;
	};
	structured_output?: boolean;
	tool_call?: boolean;
	reasoning?: boolean;
}

interface ProviderEntry {
	id: string;
	name: string;
	models: Record<string, ModelEntry>;
}

type ModelsData = Record<string, ProviderEntry>;

/**
 * models.json only keeps the providers cuery can call (see scripts/update-models.ts).
 * If a model ID appears under more than one, this order decides which price is used.
 */
const FIRST_PARTY_PROVIDERS = ['openai', 'anthropic', 'google'];

// Build flat index: model ID -> { provider, model }
const modelIndex = new Map<string, { provider: string; model: ModelEntry }>();

const providerEntries = Object.entries(modelsData as ModelsData).sort(([a], [b]) => {
	const rank = (id: string) => {
		const index = FIRST_PARTY_PROVIDERS.indexOf(id);
		return index === -1 ? FIRST_PARTY_PROVIDERS.length : index;
	};
	return rank(a) - rank(b);
});

for (const [providerId, provider] of providerEntries) {
	if (!provider.models) continue;

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (!modelIndex.has(modelId)) {
			modelIndex.set(modelId, { provider: providerId, model });
		}
	}
}

// OpenAI pricing verified against https://developers.openai.com/api/docs/pricing/.
// Keep these entries until the bundled catalog includes the released models.
for (const [id, input, output, cacheRead] of [
	['gpt-6-luna', 0.10, 0.50, 0.01],
	['gpt-6.1-sol', 2.00, 10.00, 0.10],
] as const) {
	modelIndex.set(id, { provider: 'openai', model: {
		id, name: id, cost: { input, output, cache_read: cacheRead },
		structured_output: true, tool_call: true, reasoning: true,
	} });
}

// Snapshots the OpenAI API still serves but models.dev's first-party listing omits
// (verified against https://developers.openai.com/api/docs/pricing/). The catalog wins if it lists them.
for (const [id, input, output, toolCall] of [
	['gpt-3.5-turbo-0125', 0.50, 1.50, true],
	['gpt-3.5-turbo-1106', 1.00, 2.00, true],
	['gpt-3.5-turbo-instruct', 1.50, 2.00, false],
] as const) {
	if (!modelIndex.has(id)) {
		modelIndex.set(id, { provider: 'openai', model: {
			id, name: id, cost: { input, output },
			structured_output: false, tool_call: toolCall, reasoning: false,
		} });
	}
}

/**
 * Normalize a model ID by removing date suffixes and common variations.
 */
function normalizeModel(modelId: string): string {
	return modelId
		.replace(/-\d{4}-\d{2}-\d{2}$/, '')
		// Gemini's stable versions (gemini-2.0-flash-001) are priced as the base model.
		.replace(/^(gemini-.+)-\d{3}$/, '$1');
}

/**
 * Look up a model entry by ID (with normalization fallback). A first-party
 * entry for the undated ID wins over a reseller's entry for the dated ID.
 */
export function lookupModel(modelId: string): { provider: string; model: ModelEntry } | null {
	const exact = modelIndex.get(modelId) ?? null;
	const normalized = modelIndex.get(normalizeModel(modelId)) ?? null;
	if (exact != null && FIRST_PARTY_PROVIDERS.includes(exact.provider)) {
		return exact;
	}
	if (normalized != null && FIRST_PARTY_PROVIDERS.includes(normalized.provider)) {
		return normalized;
	}
	return exact ?? normalized;
}

/**
 * Get pricing information for a model.
 */
export function getModelPricing(modelId: string): ModelPricing | null {
	const entry = lookupModel(modelId);

	if (!entry?.model.cost) {
		return null;
	}

	const cost = entry.model.cost;

	if (cost.input === 0 && cost.output === 0) {
		return null;
	}

	return {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cache_read,
		cacheWrite: cost.cache_write,
		reasoning: cost.reasoning,
	};
}

/**
 * Get full model information including pricing and capabilities.
 */
export function getModelInfo(modelId: string): ModelInfo | null {
	const entry = lookupModel(modelId);

	if (!entry) {
		return null;
	}

	const { provider, model: m } = entry;

	return {
		id: m.id,
		name: m.name,
		provider,
		pricing: getModelPricing(modelId),
		contextLimit: m.limit?.context ?? null,
		outputLimit: m.limit?.output ?? null,
		capabilities: {
			structuredOutput: m.structured_output ?? false,
			toolCall: m.tool_call ?? false,
			reasoning: m.reasoning ?? false,
		},
	};
}

/**
 * Calculate cost for token usage. Cached and cache-write prompt tokens are
 * charged at their own rates when the model has them (otherwise at the input
 * rate); reasoning tokens are billed as output.
 */
export function calculateCost(modelId: string, usage: TokenUsage): UsageCost | null {
	const pricing = getModelPricing(modelId);

	if (!pricing) {
		return null;
	}

	// Cache breakdowns are part of inputTokens; clamp so inconsistent usage can't overcharge.
	const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
	const cacheWrite = Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens - cached);
	const uncached = Math.max(0, usage.inputTokens - cached - cacheWrite);
	const inputCost = (
		uncached * pricing.input
		+ cached * (pricing.cacheRead ?? pricing.input)
		+ cacheWrite * (pricing.cacheWrite ?? pricing.input)
	) / 1_000_000;
	const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;

	return {
		inputCost,
		outputCost,
		totalCost: inputCost + outputCost,
		currency: 'USD',
	};
}
