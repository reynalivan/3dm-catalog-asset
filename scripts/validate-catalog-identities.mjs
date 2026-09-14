import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogs = ['efmi', 'gimi', 'srmi', 'wwmi', 'zzmi'];
const requireAssets = process.argv.includes('--require-assets');
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function normalizeIdentity(value) {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]/gu, '');
}

function directNames(entry) {
  return [entry.name, ...(entry.aliases ?? []), ...(entry.custom_skins ?? []).flatMap((skin) => [skin.name, ...(skin.aliases ?? [])])]
    .filter((value) => typeof value === 'string' && value.trim());
}

function duplicateOwners(entries) {
  const owners = new Map();
  for (const entry of entries.filter((entry) => entry.entry_kind !== 'taxonomy')) {
    for (const name of directNames(entry)) {
      const key = `${entry.object_type}:${normalizeIdentity(name)}`;
      if (key.endsWith(':')) continue;
      const names = owners.get(key) ?? new Set();
      names.add(entry.name);
      owners.set(key, names);
    }
  }
  return [...owners.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([key, names]) => ({ key, entries: [...names].sort() }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function duplicateAssetPaths(entries) {
  const owners = new Map();
  for (const entry of entries) {
    if (typeof entry.thumbnail_path !== 'string' || !entry.thumbnail_path.trim()) continue;
    const names = owners.get(entry.thumbnail_path) ?? new Set();
    names.add(entry.name);
    owners.set(entry.thumbnail_path, names);
  }
  return [...owners.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([path, names]) => ({ path, entries: [...names].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function isAvatarPath(path) {
  const components = path.replaceAll('\\', '/').split('/');
  return components.length === 4
    && components[0] === 'assets'
    && /^[a-z0-9]+$/i.test(components[1])
    && ['characters', 'weapons'].includes(components[2])
    && /^[a-z0-9][a-z0-9-]*\.(png|jpg|webp|gif)$/i.test(components[3]);
}

async function missingAssets(entries) {
  const missing = [];
  for (const entry of entries) {
    if (typeof entry.thumbnail_path !== 'string' || !entry.thumbnail_path.trim()) continue;
    const path = resolve(root, entry.thumbnail_path);
    if (!isAvatarPath(entry.thumbnail_path)) {
      missing.push({ entry: entry.name, reason: 'thumbnail path is outside the expected game asset directory' });
      continue;
    }
    try {
      await access(path);
    } catch {
      missing.push({ entry: entry.name, reason: `missing ${entry.thumbnail_path}` });
    }
  }
  return missing;
}

async function main() {
  const report = {};
  const conflicts = [];
  for (const game of catalogs) {
    const document = JSON.parse(await readFile(resolve(root, 'catalog', `${game}.json`), 'utf8'));
    const nameConflicts = duplicateOwners(document.entries);
    const assetConflicts = duplicateAssetPaths(document.entries);
    const missing = requireAssets ? await missingAssets(document.entries) : [];
    report[game] = {
      entries: document.entries.length,
      name_conflicts: nameConflicts,
      asset_path_conflicts: assetConflicts,
      missing_assets: missing,
    };
    if (nameConflicts.length || assetConflicts.length || missing.length) conflicts.push(game);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (conflicts.length) {
    throw new Error(`Catalog identity validation failed for: ${conflicts.join(', ')}`);
  }
}

if (isMain) await main();

export { duplicateAssetPaths, duplicateOwners, normalizeIdentity };
