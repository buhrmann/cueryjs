/**
 * Provider registry - instantiates LLM providers by name or model ID.
 */

import type { LLMProvider } from './types.ts';
import { OpenAIProvider } from './openai.ts';
import { GoogleProvider } from './google.ts';
import { AnthropicProvider } from './anthropic.ts';

/**
 * Get a provider by name.
 * Creates a fresh provider instance each time to support different API keys.
 * @param name - Provider name ('openai', 'google', 'anthropic')
 * @param apiKey - Optional API key. If not provided, uses environment variable.
 */
export function getProvider(name: string, apiKey?: string): LLMProvider {
	switch (name) {
		case 'google':
			return new GoogleProvider(apiKey);
		case 'anthropic':
			return new AnthropicProvider(apiKey);
		case 'openai':
		default:
			return new OpenAIProvider(apiKey);
	}
}

/**
 * Get the appropriate provider for a model ID.
 * Infers provider from model name prefix.
 * Creates a fresh provider instance each time to support different API keys.
 * @param modelId - Model identifier (e.g., 'gpt-4.1', 'gemini-2.0-flash')
 * @param apiKey - Optional API key. If not provided, uses environment variable.
 */
export function getProviderForModel(modelId: string, apiKey?: string): LLMProvider {
	const modelLower = modelId.toLowerCase();

	if (modelLower.startsWith('gemini')) {
		return new GoogleProvider(apiKey);
	}

	if (modelLower.startsWith('claude')) {
		return new AnthropicProvider(apiKey);
	}

	// Default to OpenAI for gpt-*, o1-*, o3-*, and unknown models
	return new OpenAIProvider(apiKey);
}
