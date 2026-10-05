/**
 * Fetches model pricing data from models.dev and writes it to src/pricing/models.json.
 *
 * Run with: deno task update-models
 */

const MODELS_API_URL = 'https://models.dev/api.json';
const OUTPUT_PATH = new URL('../src/assets/models.json', import.meta.url).pathname;

async function main() {
	console.log(`Fetching model data from ${MODELS_API_URL}...`);

	const response = await fetch(MODELS_API_URL);

	if (!response.ok) {
		throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
	}

	const data = await response.json();

	// Count models for logging
	let modelCount = 0;
	for (const provider of Object.values(data) as Array<{ models?: Record<string, unknown> }>) {
		if (provider.models) {
			modelCount += Object.keys(provider.models).length;
		}
	}

	console.log(`Fetched ${modelCount} models from ${Object.keys(data).length} providers`);

	const trimmed = trimModelsData(data);
	const kept = keepDroppedModels(trimmed, await readPrevious());
	if (kept > 0) {
		console.log(`Kept ${kept} model(s) models.dev no longer lists, so their prices stay available`);
	}

	console.log(`Writing to ${OUTPUT_PATH}...`);
	await Deno.writeTextFile(OUTPUT_PATH, JSON.stringify(trimmed, null, '\t'));

	console.log('Done!');
}

/** Providers cuery can call; other providers' listings (resellers, gateways) are dropped. */
const PROVIDERS = ['openai', 'google', 'anthropic'];

/** Model fields read by src/providers/pricing.ts; everything else is dropped to keep the bundle small. */
const MODEL_FIELDS = ['id', 'name', 'cost', 'limit', 'structured_output', 'tool_call', 'reasoning'];

type RawModels = Record<string, { id: string; name: string; models?: Record<string, Record<string, unknown>> }>;

function trimModelsData(data: RawModels): RawModels {
	const trimmed: RawModels = {};
	for (const providerId of PROVIDERS) {
		const provider = data[providerId];
		if (provider == null) {
			throw new Error(`models.dev no longer lists provider "${providerId}"`);
		}
		const models: Record<string, Record<string, unknown>> = {};
		for (const [modelId, model] of Object.entries(provider.models ?? {})) {
			models[modelId] = Object.fromEntries(MODEL_FIELDS.filter((field) => field in model).map((field) => [field, model[field]]));
		}
		trimmed[providerId] = { id: provider.id, name: provider.name, models };
	}
	return trimmed;
}

async function readPrevious(): Promise<RawModels | null> {
	try {
		return JSON.parse(await Deno.readTextFile(OUTPUT_PATH)) as RawModels;
	} catch {
		return null;
	}
}

/**
 * models.dev drops retired models from first-party listings, but callers may
 * still use (or record costs for) them. Carry over entries from the previous
 * file that the new data lacks, so a refresh never removes a known price.
 */
function keepDroppedModels(next: RawModels, previous: RawModels | null): number {
	let kept = 0;
	for (const providerId of PROVIDERS) {
		const previousModels = previous?.[providerId]?.models ?? {};
		const nextModels = next[providerId]!.models!;
		for (const [modelId, model] of Object.entries(previousModels)) {
			if (!(modelId in nextModels)) {
				nextModels[modelId] = Object.fromEntries(
					MODEL_FIELDS.filter((field) => field in model).map((field) => [field, model[field]]),
				);
				kept += 1;
			}
		}
	}
	return kept;
}

main().catch((error) => {
	console.error('Error:', error.message);
	Deno.exit(1);
});
