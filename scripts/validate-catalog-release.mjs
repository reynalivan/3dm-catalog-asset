import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = join(root, 'manifest.json');
const allowedRoots = new Set(['manifest.json', 'catalog', 'assets']);
const avatarExtensions = new Set(['png', 'jpg', 'webp', 'gif']);
const maxAvatarBytes = 2 * 1024 * 1024;

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function filesUnder(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Release input must not contain symlinks or special files: ${child}`);
  }
  return files;
}

function validTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const validKinds = new Set(['position_vb', 'draw_vb', 'vertex_buffer', 'index_buffer', 'texture', 'shader']);
  if (!validKinds.has(target.resource_kind)) return false;
  const shader = target.resource_kind === 'shader';
  const pattern = shader ? /^[0-9a-f]{16}$/i : /^[0-9a-f]{8}$/i;
  return typeof target.variant === 'string' && target.variant.trim()
    && typeof target.hash === 'string' && pattern.test(target.hash)
    && (target.slot === undefined || (typeof target.slot === 'string' && target.slot.trim()))
    && (target.match_first_index === undefined
      || (target.resource_kind === 'index_buffer'
        && Number.isInteger(target.match_first_index)
        && target.match_first_index >= 0))
    && target.provenance && typeof target.provenance.source_repo === 'string' && target.provenance.source_repo.trim()
    && typeof target.provenance.commit === 'string' && target.provenance.commit.trim()
    && typeof target.provenance.path === 'string' && target.provenance.path.trim();
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (
  Object.hasOwn(manifest, 'format_version')
  || typeof manifest.id !== 'string' || !manifest.id.trim()
  || typeof manifest.version !== 'string' || !manifest.version.trim()
  || typeof manifest.author !== 'string' || !manifest.author.trim()
  || typeof manifest.source !== 'string' || !manifest.source.trim()
  || !manifest.catalogs || typeof manifest.catalogs !== 'object' || Array.isArray(manifest.catalogs)
) {
  throw new Error('Release manifest must use the current schema without format_version.');
}

const rootEntries = await readdir(root, { withFileTypes: true });
for (const entry of rootEntries) {
  if (
    entry.name.startsWith('.') ||
    entry.name === 'dist' ||
    entry.name === 'scripts' ||
    entry.name === 'metadata-snapshots' ||
    entry.name === 'README.md'
  ) continue;
  if (!allowedRoots.has(entry.name)) throw new Error(`Unexpected release root entry: ${entry.name}`);
}

for (const [game, catalog] of Object.entries(manifest.catalogs ?? {})) {
  if (!catalog?.path || !catalog?.sha256) throw new Error(`Catalog ${game} lacks path or checksum.`);
  const file = resolve(root, catalog.path);
  if (!file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) throw new Error(`Catalog ${game} escapes the repository.`);
  const bytes = await readFile(file);
  if (checksum(bytes) !== catalog.sha256.toLowerCase()) throw new Error(`Catalog checksum mismatch: ${game}`);
  const catalogDocument = JSON.parse(bytes.toString('utf8'));
  const entries = catalogDocument.entries;
  if (!Array.isArray(entries)) throw new Error(`Catalog ${game} has no entries array.`);
  for (const entry of entries) {
    if (!Array.isArray(entry.runtime_targets) || entry.runtime_targets.some((target) => !validTarget(target))) {
      throw new Error(`Catalog ${game} entry '${entry.name ?? '<unnamed>'}' has invalid runtime_targets.`);
    }
    if (entry.thumbnail_path !== undefined && entry.thumbnail_path !== null) {
      if (typeof entry.thumbnail_path !== 'string' || !isAllowedAvatarPath(entry.thumbnail_path)) {
        throw new Error(`Catalog ${game} entry '${entry.name ?? '<unnamed>'}' has an invalid avatar path.`);
      }
      const avatarPath = resolve(root, entry.thumbnail_path);
      const bytes = await readFile(avatarPath);
      if (bytes.length === 0 || bytes.length > maxAvatarBytes) {
        throw new Error(`Catalog ${game} entry '${entry.name ?? '<unnamed>'}' avatar exceeds the size limit.`);
      }
      const expectedChecksum = entry.metadata?.thumbnail_asset_sha256;
      if (typeof expectedChecksum !== 'string' || checksum(bytes) !== expectedChecksum.toLowerCase()) {
        throw new Error(`Catalog ${game} entry '${entry.name ?? '<unnamed>'}' avatar checksum does not match metadata.`);
      }
    }
  }
}

for (const file of await filesUnder(join(root, 'catalog'))) {
  if (file.split('.').pop()?.toLowerCase() !== 'json') {
    throw new Error(`Catalog release contains non-JSON data: ${relative(root, file)}`);
  }
  if ((await stat(file)).size > 10 * 1024 * 1024) {
    throw new Error(`Catalog release file exceeds 10 MiB: ${relative(root, file)}`);
  }
}

const assetsRoot = join(root, 'assets');
try {
  for (const file of await filesUnder(assetsRoot)) {
    const relativePath = relative(root, file).replaceAll('\\', '/');
    if (!isAllowedAvatarPath(relativePath)) throw new Error(`Catalog release contains unsupported asset: ${relativePath}`);
    if ((await stat(file)).size > maxAvatarBytes) throw new Error(`Catalog avatar exceeds 2 MiB: ${relativePath}`);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

process.stdout.write('Catalog release validation passed.\n');

function isAllowedAvatarPath(path) {
  const normalized = path.replaceAll('\\', '/');
  const components = normalized.split('/');
  if (components.length !== 4 || components[0] !== 'assets') return false;
  if (!/^[a-z0-9]+$/i.test(components[1])) return false;
  if (!['characters', 'weapons'].includes(components[2])) return false;
  const filename = components[3];
  if (!/^[a-z0-9][a-z0-9-]*\.(png|jpg|webp|gif)$/i.test(filename)) return false;
  return avatarExtensions.has(filename.split('.').at(-1).toLowerCase());
}
