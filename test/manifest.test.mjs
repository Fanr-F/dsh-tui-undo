import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const candidates = [
  process.env.DSH_MANIFEST_DIR,
  join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'node_modules', '@dsh-std', 'manifest'),
].filter(Boolean);
const directory = candidates.find((candidate) => existsSync(join(candidate, 'lib', 'index.js')));
const skip = directory === undefined ? 'dsh-tui manifest reader is not installed' : false;

test('dsh-plugin.json is accepted by the dsh-tui manifest reader', { skip }, async () => {
  const { parseManifest, projectManifest } = await import(pathToFileURL(join(directory, 'lib', 'index.js')).href);
  const source = await readFile(join(process.cwd(), 'dsh-plugin.json'), 'utf8');
  const manifest = parseManifest(source, { source: 'dsh-plugin.json' });

  assert.equal(manifest.id, 'dsh.tui-undo');
  assert.equal(manifest.version, '0.1.0');
  assert.ok(existsSync(join(process.cwd(), manifest.facets.host.entry)));
  assert.deepEqual(
    manifest.contributes.commands.map((command) => command.id),
    ['dsh.undo', 'dsh.redo'],
  );

  const component = projectManifest(manifest);
  const [facet] = component.spec.facets;
  assert.equal(facet.name, 'host');
  assert.equal(facet.activation.kind, 'FacetModule');
  assert.equal(facet.activation.spec.module, manifest.facets.host.entry);
});
