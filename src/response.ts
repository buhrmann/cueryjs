/**
 * BatchResponse - A wrapper for batch LLM results with usage tracking.
 *
 * Provides an array-like interface for backwards compatibility while
 * adding usage aggregation capabilities.
 */

import { calculateCost } from './providers/pricing.ts';

/**
 * Token usage from a single LLM call.
 */
export interface TokenUsage {
	/** All prompt tokens, including cached and cache-write tokens. */
	inputTokens: number;
	/** All generated tokens, including reasoning/thinking tokens. */
	outputTokens: number;
	totalTokens: number;
	/** Prompt tokens served from the provider's cache (part of `inputTokens`). */
	cachedInputTokens?: number;
	/** Prompt tokens written to the cache (part of `inputTokens`; Anthropic only). */
	cacheWriteTokens?: number;
	/** Reasoning/thinking tokens (part of `outputTokens`). */
	reasoningTokens?: number;
}

/**
 * Cost calculation result in USD.
 */
export interface UsageCost {
	inputCost: number;
	outputCost: number;
	totalCost: number;
	currency: 'USD';
}

/**
 * Aggregated usage across multiple LLM calls.
 */
export interface AggregatedUsage {
	tokens: TokenUsage;
	cost: UsageCost | null;
	callCount: number;
	model: string | null;
}

/**
 * A batch of LLM results with usage tracking.
 *
 * Implements Iterable<T> and provides array-like methods for backwards
 * compatibility with code expecting Array<T>.
 */
export class BatchResponse<T> implements Iterable<T> {
	readonly results: ReadonlyArray<T>;
	private readonly _tokenUsages: Array<TokenUsage | undefined> | null;
	private readonly _model: string | null;

	constructor(
		results: T[],
		tokenUsages?: Array<TokenUsage | null | undefined>,
		model?: string
	) {
		this.results = results;
		// Normalize null to undefined for internal storage, or null if not provided
		this._tokenUsages = tokenUsages ? tokenUsages.map(u => u ?? undefined) : null;
		this._model = model ?? null;
	}

	// Array-like interface

	get length(): number {
		return this.results.length;
	}

	[Symbol.iterator](): Iterator<T> {
		return this.results[Symbol.iterator]();
	}

	at(index: number): T | undefined {
		return this.results.at(index);
	}

	map<U>(fn: (value: T, index: number) => U): BatchResponse<U> {
		const mapped = this.results.map((item, i) => fn(item, i));
		return new BatchResponse(mapped, this._tokenUsages ?? undefined, this._model ?? undefined);
	}

	filter(fn: (value: T, index: number) => boolean): BatchResponse<T> {
		const filtered: T[] = [];
		const usages: Array<TokenUsage | undefined> | undefined = this._tokenUsages ? [] : undefined;

		this.results.forEach((item, i) => {
			if (fn(item, i)) {
				filtered.push(item);
				usages?.push(this._tokenUsages![i]);
			}
		});

		return new BatchResponse(filtered, usages, this._model ?? undefined);
	}

	forEach(fn: (value: T, index: number) => void): void {
		this.results.forEach(fn);
	}

	find(fn: (value: T, index: number) => boolean): T | undefined {
		return this.results.find(fn);
	}

	findIndex(fn: (value: T, index: number) => boolean): number {
		return this.results.findIndex(fn);
	}

	some(fn: (value: T, index: number) => boolean): boolean {
		return this.results.some(fn);
	}

	every(fn: (value: T, index: number) => boolean): boolean {
		return this.results.every(fn);
	}

	reduce<U>(fn: (acc: U, value: T, index: number) => U, initial: U): U {
		return this.results.reduce(fn, initial);
	}

	/**
	 * Convert to a plain array.
	 */
	toArray(): T[] {
		return [...this.results];
	}

	// Usage tracking

	/**
	 * Get aggregated usage across all calls in this batch.
	 * Cost is calculated lazily only if model and costCalculator were provided.
	 * Returns null if usage tracking was not enabled.
	 */
	usage(): AggregatedUsage | null {
		if (!this._tokenUsages) {
			return null;
		}

		const valid = this._tokenUsages.filter((u): u is TokenUsage => u !== undefined);

		const aggregatedTokens: TokenUsage = {
			inputTokens: valid.reduce((sum, u) => sum + u.inputTokens, 0),
			outputTokens: valid.reduce((sum, u) => sum + u.outputTokens, 0),
			totalTokens: valid.reduce((sum, u) => sum + u.totalTokens, 0),
			cachedInputTokens: valid.reduce((sum, u) => sum + (u.cachedInputTokens ?? 0), 0),
			cacheWriteTokens: valid.reduce((sum, u) => sum + (u.cacheWriteTokens ?? 0), 0),
			reasoningTokens: valid.reduce((sum, u) => sum + (u.reasoningTokens ?? 0), 0),
		};

		// Calculate cost if we have a model
		const cost = this._model ? calculateCost(this._model, aggregatedTokens) : null;

		return {
			tokens: aggregatedTokens,
			cost,
			callCount: valid.length,
			model: this._model,
		};
	}

	/**
	 * Get token usage for a specific index.
	 */
	usageAt(index: number): TokenUsage | undefined {
		return this._tokenUsages?.[index];
	}

	/**
	 * Check if any usage info is available.
	 */
	hasUsage(): boolean {
		return this._tokenUsages?.some((u) => u !== undefined) ?? false;
	}
}
