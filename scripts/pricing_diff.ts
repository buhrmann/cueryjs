/**
 * Prints how the bundled pricing (src/assets/models.json) differs from the last commit's: models
 * added and removed, and every price that changed, for the providers cuery calls.
 *
 * Run with: deno run --allow-read --allow-run scripts/pricing_diff.ts [--github]
 *
 * `--github` writes each line as a GitHub Actions warning annotation (the release workflow's check).
 * Exits 0 either way; prints nothing when the file is unchanged.
 */

const FILE = 'src/assets/models.json';
const PROVIDERS = ['openai', 'anthropic', 'google'];

type Models = Record<string, { models?: Record<string, { cost?: Record<string, unknown> }> }>;

async function committed(): Promise<Models> {
	const output = await new Deno.Command('git', { args: ['show', `HEAD:${FILE}`], stdout: 'piped', stderr: 'null' }).output();
	if (!output.success) return {};
	return JSON.parse(new TextDecoder().decode(output.stdout)) as Models;
}

/** The changes, one line each. */
export function pricingChanges(before: Models, after: Models): string[] {
	const lines: string[] = [];
	for (const provider of PROVIDERS) {
		const old = before[provider]?.models ?? {};
		const next = after[provider]?.models ?? {};
		for (const id of Object.keys(next).sort()) {
			if (!(id in old)) lines.push(`${provider}: added ${id} ${JSON.stringify(next[id]!.cost ?? null)}`);
			else if (JSON.stringify(old[id]!.cost ?? null) !== JSON.stringify(next[id]!.cost ?? null)) {
				lines.push(`${provider}: ${id} ${JSON.stringify(old[id]!.cost ?? null)} -> ${JSON.stringify(next[id]!.cost ?? null)}`);
			}
		}
		for (const id of Object.keys(old).sort()) if (!(id in next)) lines.push(`${provider}: removed ${id}`);
	}
	return lines;
}

if (import.meta.main) {
	const github = Deno.args.includes('--github');
	const after = JSON.parse(await Deno.readTextFile(FILE)) as Models;
	for (const line of pricingChanges(await committed(), after)) {
		console.log(github ? `::warning title=Bundled pricing is out of date::${line}` : line);
	}
}
