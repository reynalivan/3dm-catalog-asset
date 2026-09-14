import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'manifest.json');
const snapshotRoot = join(root, 'metadata-snapshots');

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const manifest = await readJson(manifestPath);
const current = await readJson(join(snapshotRoot, 'current.json'));
const snapshot = await readJson(
  join(snapshotRoot, 'generations', current.generation_id, 'runtime-targets-v2.json'),
);
const targetsByGame = new Map();
for (const item of snapshot.entries ?? []) {
  const targets = targetsByGame.get(item.game) ?? new Map();
  targets.set(item.canonical_id, item.runtime_targets ?? []);
  targetsByGame.set(item.game, targets);
}

let promotedEntries = 0;
for (const [game, catalog] of Object.entries(manifest.catalogs ?? {})) {
  const path = join(root, catalog.path);
  const document = await readJson(path);
  const targets = targetsByGame.get(game) ?? new Map();
  for (const entry of document.entries ?? []) {
    const runtimeTargets = targets.get(entry.name) ?? [];
    if (runtimeTargets.length > 0) promotedEntries += 1;
    entry.runtime_targets = runtimeTargets;
    delete entry.thumbnail_path;
    for (const skin of entry.custom_skins ?? []) delete skin.thumbnail_skin_path;
  }
  const json = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(path, json, 'utf8');
  catalog.sha256 = checksum(json);
}

await writeJson(manifestPath, manifest);
process.stdout.write(`Promoted runtime targets for ${promotedEntries} catalog entries.\n`);
