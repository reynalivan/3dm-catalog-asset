import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const command = isMain ? process.argv[2] : null;
if (isMain && command !== 'check' && command !== 'update') {
  throw new Error('Usage: node scripts/maintain-runtime-targets.mjs <check|update>. Use promote-runtime-targets.mjs after review.');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceConfigPath = join(root, 'scripts', 'upstream-sources.json');
const mappingPath = join(root, 'scripts', 'runtime-target-mapping.json');
const snapshotRoot = join(root, 'metadata-snapshots');
const snapshotGenerationsRoot = join(snapshotRoot, 'generations');
const userAgent = '3dm-catalog-asset-maintainer';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safeRelativePath(path) {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe upstream metadata path: ${path}`);
  }
  return normalized;
}

function isMetadataPath(path, patterns) {
  const lowered = path.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    if (normalized === 'playercharacterdata/**/hash.json') {
      return lowered.includes('playercharacterdata/') && lowered.endsWith('/hash.json');
    }
    if (normalized === '**/metadata.json') return lowered.endsWith('/metadata.json');
    if (normalized === '**/textureusage.json') return lowered.endsWith('/textureusage.json');
    return false;
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': userAgent,
    },
  });
  if (!response.ok) throw new Error(`Metadata request failed (${response.status}) for ${url}`);
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!response.ok) throw new Error(`Metadata download failed (${response.status}) for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function listMetadata(source) {
  const tree = await fetchJson(`https://api.github.com/repos/${source.repository}/git/trees/${source.commit}?recursive=1`);
  if (tree.truncated) throw new Error(`GitHub returned a truncated tree for ${source.repository}@${source.commit}`);
  return tree.tree
    .filter((entry) => entry.type === 'blob' && isMetadataPath(entry.path, source.metadataPatterns))
    .map((entry) => ({ path: safeRelativePath(entry.path), sha: entry.sha }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function resourceKind(key) {
  const normalized = key.toLowerCase();
  if (/(shader|(^|_)(vs|ps|cs|hs|ds|gs)($|_))/.test(normalized)) return 'shader';
  if (/(position|vb0)/.test(normalized)) return 'position_vb';
  if (/(^|_)(draw|vb1|vb2)(_|$)/.test(normalized)) return 'draw_vb';
  if (/(^|_)(ib|index)(_|$)/.test(normalized)) return 'index_buffer';
  if (/(blend_vb|texcoord_vb)/.test(normalized)) return 'vertex_buffer';
  if (/(texture|tex)/.test(normalized)) return 'texture';
  return 'vertex_buffer';
}

function isTargetKey(key) {
  const normalized = key.toLowerCase();
  return normalized.includes('hash')
    || /(shader|(^|_)(vs|ps|cs|hs|ds|gs)($|_))/.test(normalized)
    || /(^|_)(position_vb|draw_vb|blend_vb|texcoord_vb|ib|vb0|vb1|vb2)($|_)/.test(normalized)
    || normalized.includes('texture');
}

function collectTargets(value, keys = [], targets = [], targetKey = null) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTargets(item, [...keys, String(index)], targets, targetKey));
    return targets;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      collectTargets(item, [...keys, key], targets, isTargetKey(key) ? key : targetKey);
    });
    return targets;
  }
  if (typeof value !== 'string') return targets;

  const key = targetKey ?? keys.at(-1) ?? '';
  if (!isTargetKey(key)) return targets;
  const hash = value.trim().replace(/^0x/i, '');
  const kind = resourceKind(key);
  const expectedLength = kind === 'shader' ? 16 : 8;
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`, 'i').test(hash)) return targets;
  targets.push({ resource_kind: kind, hash: hash.toLowerCase(), source_key: keys.join('.') });
  return targets;
}

function mappingForPath(mappings, game, path) {
  return mappings
    .filter((mapping) => mapping.game === game && path.startsWith(mapping.path_prefix))
    .sort((left, right) => right.path_prefix.length - left.path_prefix.length)[0];
}

function callbackSlot(target) {
  const key = target.source_key.toLowerCase();
  if (target.resource_kind === 'position_vb') return 'vb0';
  if (target.resource_kind === 'index_buffer') return 'ib';
  if (target.resource_kind === 'draw_vb' || target.resource_kind === 'vertex_buffer') {
    if (key.includes('blend_vb') || /(^|_)vb1($|_)/.test(key)) return 'vb1';
    if (key.includes('texcoord_vb') || /(^|_)vb2($|_)/.test(key)) return 'vb2';
  }
  // Metadata normally says a texture name, not the 3DMigoto ps-tN slot.
  // Leave it absent rather than guessing a callback that may not run.
  return null;
}

function readObjectIndexes(metadata) {
  const indexes = metadata?.object_indexes;
  if (!Array.isArray(indexes)) return [];
  return [...new Set(indexes.filter((index) => Number.isInteger(index) && index >= 0))]
    .sort((left, right) => left - right);
}

function componentForTarget(mapping, target) {
  const rules = mapping.component_by_source_key ?? {};
  const exact = rules[target.source_key] ?? rules[target.source_key.split('.').at(-1)];
  return exact ?? mapping.component ?? null;
}

function runtimeTargetsForCandidate(candidate, source, mapping) {
  if (!mapping || candidate.status !== 'mapped_candidate') return [];
  const targets = [];
  for (const target of candidate.targets) {
    const slot = callbackSlot(target);
    const base = {
      variant: mapping.variant,
      component: componentForTarget(mapping, target),
      resource_kind: target.resource_kind,
      hash: target.hash,
      ...(slot ? { slot } : {}),
      provenance: {
        source_repo: source.repository,
        commit: source.commit,
        path: candidate.path,
      },
    };
    if (target.resource_kind === 'index_buffer') {
      const indexes = [...new Set(candidate.object_indexes)]
        .filter((index) => Number.isInteger(index) && index >= 0)
        .sort((left, right) => left - right);
      if (indexes.length === 0) continue;
      indexes.forEach((match_first_index) => targets.push({ ...base, match_first_index }));
      continue;
    }
    targets.push(base);
  }
  return targets;
}

function candidateV2Snapshot(candidates, sources) {
  const entries = new Map();
  for (const candidate of candidates) {
    if (candidate.status !== 'mapped_candidate') continue;
    const source = sources[candidate.game];
    const mapping = candidate.mapping;
    const runtime_targets = runtimeTargetsForCandidate(candidate, source, mapping);
    if (runtime_targets.length === 0) continue;
    const key = `${candidate.game}:${mapping.canonical_id}`;
    const entry = entries.get(key) ?? {
      game: candidate.game,
      canonical_id: mapping.canonical_id,
      runtime_targets: [],
    };
    entry.runtime_targets.push(...runtime_targets);
    entries.set(key, entry);
  }
  return [...entries.values()]
    .map((entry) => ({
      ...entry,
      runtime_targets: entry.runtime_targets.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    }))
    .sort((left, right) => left.game.localeCompare(right.game) || left.canonical_id.localeCompare(right.canonical_id));
}

function findAmbiguousHashes(entries) {
  const owners = new Map();
  for (const entry of entries) {
    for (const target of entry.runtime_targets) {
      if (target.resource_kind === 'shader') continue;
      const key = [
        entry.game,
        target.hash,
        target.resource_kind,
        target.slot ?? '',
        target.match_first_index ?? '',
      ].join(':');
      const names = owners.get(key) ?? new Set();
      names.add(entry.canonical_id);
      owners.set(key, names);
    }
  }
  return [...owners.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([key, names]) => ({ key, canonical_ids: [...names].sort() }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function main() {
  const [sources, mappingConfig] = await Promise.all([
    readJson(sourceConfigPath),
    readJson(mappingPath),
  ]);
  const inventory = {};
  const work = [];
  const generationId = command === 'update'
    ? `g${Date.now()}-${process.pid}`
    : null;
  const staging = generationId
    ? join(snapshotRoot, `.runtime-targets-${generationId}`)
    : null;

  for (const [game, source] of Object.entries(sources)) {
    const entries = await listMetadata(source);
    inventory[game] = {
      repository: source.repository,
      commit: source.commit,
      files: entries,
    };
    for (const entry of entries) work.push({ game, source, entry });
  }

  const candidates = await mapWithConcurrency(work, 8, async ({ game, source, entry }) => {
      const bytes = await fetchBytes(`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${entry.path}`);
      const checksum = sha256(bytes);
      if (command === 'update') {
        const localMetadataPath = join(staging, game, 'metadata', ...entry.path.split('/'));
        await mkdir(dirname(localMetadataPath), { recursive: true });
        await writeFile(localMetadataPath, bytes);
      }

      let json;
      try {
        json = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch (error) {
        return { game, path: entry.path, checksum, status: 'malformed_json', detail: String(error) };
      }
      const mapping = mappingForPath(mappingConfig.mappings, game, entry.path);
      const targets = collectTargets(json);
      return {
        game,
        path: entry.path,
        checksum,
        status: mapping ? 'mapped_candidate' : 'unmapped',
        canonical_id: mapping?.canonical_id ?? null,
        variant: mapping?.variant ?? null,
        mapping: mapping ?? null,
        object_indexes: readObjectIndexes(json),
        targets,
      };
    });

  const v2Candidates = candidateV2Snapshot(candidates, sources);
  const report = {
    generated_at: new Date().toISOString(),
    command,
    inventory,
    candidate_count: candidates.length,
    unmapped_count: candidates.filter((candidate) => candidate.status === 'unmapped').length,
    empty_target_count: candidates.filter((candidate) => candidate.status === 'mapped_candidate' && candidate.targets.length === 0).length,
    shader_target_count: candidates.reduce(
      (count, candidate) => count + candidate.targets.filter((target) => target.resource_kind === 'shader').length,
      0,
    ),
    ambiguous_hashes: findAmbiguousHashes(v2Candidates),
    candidates,
  };

  if (command === 'update') {
    const publishedGeneration = join(snapshotGenerationsRoot, generationId);
    try {
      await atomicJson(join(staging, 'inventory.json'), inventory);
      await atomicJson(join(staging, 'runtime-target-candidates.json'), report);
      await atomicJson(join(staging, 'runtime-targets-v2.json'), {
        format_version: 2,
        generated_at: report.generated_at,
        entries: v2Candidates,
      });
      await mkdir(snapshotGenerationsRoot, { recursive: true });
      if (await exists(publishedGeneration)) {
        throw new Error(`Snapshot generation already exists: ${publishedGeneration}`);
      }
      await rename(staging, publishedGeneration);
      await atomicJson(join(snapshotRoot, 'current.json'), {
        generation_id: generationId,
        generated_at: report.generated_at,
        inventory_sha256: sha256(JSON.stringify(inventory)),
        candidate_report_sha256: sha256(JSON.stringify(report)),
      });
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isMain) await main();

export { callbackSlot, candidateV2Snapshot, collectTargets, findAmbiguousHashes };
