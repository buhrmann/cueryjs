/**
 * Prepares a release: refreshes the bundled pricing from models.dev, prints what changed for review,
 * and sets the new version in deno.json. Committing the result to main is what releases (the
 * Release workflow publishes when deno.json's version changes).
 *
 * Run with: deno task release:prepare <version>
 */

import { pricingChanges } from './pricing_diff.ts';

const version = Deno.args[0];
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error('Usage: deno task release:prepare <version>   (e.g. 0.13.0)');
	Deno.exit(1);
}

const FILE = 'src/assets/models.json';

async function run(cmd: string, args: string[]): Promise<Uint8Array> {
	const output = await new Deno.Command(cmd, { args, stdout: 'piped', stderr: 'inherit' }).output();
	if (!output.success) {
		console.error(`${cmd} ${args.join(' ')} failed`);
		Deno.exit(1);
	}
	return output.stdout;
}

// 1. The latest prices, so the release ships them.
console.log(new TextDecoder().decode(await run('deno', ['task', 'update-models'])));

// 2. What changed, for review before committing (models.dev is a community dataset).
const before = await run('git', ['show', `HEAD:${FILE}`]).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
const after = JSON.parse(await Deno.readTextFile(FILE));
const changes = pricingChanges(before, after);
console.log(changes.length === 0 ? 'Pricing: no change since the last commit.' : `Pricing changes to review:\n  ${changes.join('\n  ')}`);

// 3. The version.
const denoJson = JSON.parse(await Deno.readTextFile('deno.json'));
const previous = denoJson.version;
denoJson.version = version;
await Deno.writeTextFile('deno.json', JSON.stringify(denoJson, null, '\t') + '\n');
console.log(`\nVersion ${previous} -> ${version}. Review the pricing changes, run \`deno task check\` and \`deno task test\`, then commit deno.json and ${FILE} together; the Release workflow publishes on main.`);
