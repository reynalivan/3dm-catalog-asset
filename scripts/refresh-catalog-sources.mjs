import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const command = isMain ? process.argv[2] : null;
const sourceConfigPath = join(root, 'scripts', 'upstream-sources.json');
const userAgent = '3dm-catalog-asset-maintainer';

if (isMain && command !== 'check' && command !== 'update') {
  throw new Error('Usage: node scripts/refresh-catalog-sources.mjs <check|update>');
}

function shortSha(value) {
  return value.slice(0, 7);
}

function isPinnedRevision(pinnedCommit, latestCommit) {
  return latestCommit.startsWith(pinnedCommit) || pinnedCommit.startsWith(latestCommit);
}

function summarizeRuntimeReport(report) {
  return {
    candidate_count: report.candidate_count,
    unmapped_count: report.unmapped_count,
    empty_target_count: report.empty_target_count,
    shader_target_count: report.shader_target_count,
    ambiguous_hash_count: report.ambiguous_hashes.length,
    metadata_files: Object.fromEntries(
      Object.entries(report.inventory).map(([game, source]) => [game, source.files.length]),
    ),
  };
}

function summarizeWikiReport(report) {
  return Object.fromEntries(
    Object.entries(report).map(([game, entries]) => [game, {
      characters: entries.characters.after,
      equipment: entries.equipment.after,
    }]),
  );
}

async function runNode(script, scriptCommand = null) {
  const child = spawn(process.execPath, scriptCommand ? [script, scriptCommand] : [script], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  const output = Buffer.concat(stdout).toString('utf8').trim();
  if (exitCode !== 0) {
    throw new Error(`${script}${scriptCommand ? ` ${scriptCommand}` : ''} failed: ${Buffer.concat(stderr).toString('utf8').trim() || output}`);
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${script} did not return JSON: ${String(error)}`);
  }
}

async function fetchLatestCommit(repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/HEAD`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': userAgent,
    },
  });
  if (!response.ok) throw new Error(`GitHub ref request failed (${response.status}) for ${repository}`);
  const body = await response.json();
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(body.sha)) {
    throw new Error(`GitHub ref response lacks a commit SHA for ${repository}`);
  }
  return body.sha.toLowerCase();
}

async function upstreamStatus(sources) {
  const entries = await Promise.all(Object.entries(sources).map(async ([game, source]) => {
    const latestCommit = await fetchLatestCommit(source.repository);
    const pinnedCommit = source.commit.toLowerCase();
    return [game, {
      repository: source.repository,
      pinned_commit: pinnedCommit,
      latest_commit: latestCommit,
      at_pinned_revision: isPinnedRevision(pinnedCommit, latestCommit),
    }];
  }));
  return Object.fromEntries(entries);
}

async function main() {
  const sources = JSON.parse(await readFile(sourceConfigPath, 'utf8'));
  // Resolve branch heads first so `update` never writes local data when the
  // upstream verification source cannot be reached.
  const upstream = await upstreamStatus(sources);
  const [wiki, runtime] = await Promise.all([
    runNode(join('scripts', 'sync-wiki-catalog.mjs'), command),
    runNode(join('scripts', 'maintain-runtime-targets.mjs'), command),
  ]);
  const identities = await runNode(join('scripts', 'validate-catalog-identities.mjs'));
  const advanced = Object.entries(upstream)
    .filter(([, source]) => !source.at_pinned_revision)
    .map(([game, source]) => ({ game, repository: source.repository, pinned: shortSha(source.pinned_commit), latest: shortSha(source.latest_commit) }));
  const report = {
    generated_at: new Date().toISOString(),
    command,
    catalog: summarizeWikiReport(wiki),
    identity_validation: Object.fromEntries(
      Object.entries(identities).map(([game, result]) => [game, {
        name_conflicts: result.name_conflicts.length,
        asset_path_conflicts: result.asset_path_conflicts.length,
      }]),
    ),
    upstream,
    runtime_targets: summarizeRuntimeReport(runtime),
    upstream_advanced: advanced,
    next_step: advanced.length > 0
      ? 'Review advanced upstream revisions, then update upstream-sources.json explicitly before refreshing snapshots.'
      : 'Review unmapped candidates and use promote-runtime-targets.mjs only for explicit mappings.',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isMain) await main();

export { isPinnedRevision, summarizeRuntimeReport, summarizeWikiReport };
