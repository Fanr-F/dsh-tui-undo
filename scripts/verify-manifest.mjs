/**
 * Validate `dsh-plugin.json` against the manifest reader shipped with dsh-tui.
 *
 * The package is not a dependency of this repo, so the script looks for the
 * installed copy (override with DSH_MANIFEST_DIR) and fails closed when absent.
 *
 * Run: node scripts/verify-manifest.mjs
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const candidates = [
  process.env.DSH_MANIFEST_DIR,
  join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'node_modules', '@dsh-std', 'manifest'),
  join(process.env.LOCALAPPDATA ?? '', 'pnpm', 'global', '5', 'node_modules', '@dsh-std', 'manifest'),
].filter(Boolean);

const directory = candidates.find((candidate) => existsSync(join(candidate, 'lib', 'index.js')));
if (!directory) {
  console.error('could not find @dsh-std/manifest; set DSH_MANIFEST_DIR');
  process.exit(2);
}
console.log(`using ${directory}\n`);

const { parseManifest, projectManifest } = await import(pathToFileURL(join(directory, 'lib', 'index.js')).href);
const source = await readFile(join(process.cwd(), 'dsh-plugin.json'), 'utf8');
const manifest = parseManifest(source, { source: 'dsh-plugin.json' });
const component = projectManifest(manifest);

const entry = manifest.facets.host.entry;
if (!existsSync(join(process.cwd(), entry))) {
  console.error(`manifest entry does not exist: ${entry}`);
  process.exit(1);
}

const facet = component.spec.facets[0];
console.log(`manifest: ${manifest.id}@${manifest.version}`);
console.log(`entry:    ${entry} (${facet.activation.apiVersion} ${facet.activation.kind})`);
console.log(`commands: ${manifest.contributes.commands.map((command) => command.id).join(', ')}`);
console.log('PASS manifest is valid');
