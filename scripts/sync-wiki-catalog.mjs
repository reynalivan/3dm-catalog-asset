import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const command = isMain ? process.argv[2] : null;

if (isMain && !['check', 'update', 'avatars'].includes(command)) {
  throw new Error('Usage: node scripts/sync-wiki-catalog.mjs <check|update|avatars>');
}

const userAgent = '3dm-catalog-asset-maintainer';
const maxAvatarBytes = 2 * 1024 * 1024;
const minAvatarDimension = 150;
const fandom = {
  gimi: {
    domain: 'genshin-impact.fandom.com',
    characterPage: 'Character/List',
    equipmentPage: 'Weapon/List',
    equipmentKind: 'Weapon',
  },
  srmi: {
    domain: 'honkai-star-rail.fandom.com',
    characterPage: 'Character/List',
    equipmentPage: 'Light_Cone/List',
    equipmentKind: 'Light Cone',
  },
  wwmi: {
    domain: 'wutheringwaves.fandom.com',
    characterPage: 'Resonator/List',
    equipmentPage: 'Weapon/List',
    equipmentKind: 'Weapon',
  },
  zzmi: {
    domain: 'zenless-zone-zero.fandom.com',
    characterPage: 'Agent/List',
    equipmentPage: 'W-Engine/List',
    equipmentKind: 'W-Engine',
  },
};

function decodeHtml(value) {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value) {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{Letter}\p{Number}]/gu, '');
}

function parseRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => ({ html: match[0], cells: [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]) }))
    .filter((row) => row.cells.length > 0);
}

function attribute(tag, name) {
  return new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1] ?? null;
}

function image(cell, prefix) {
  for (const match of cell.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const fileName = attribute(tag, 'data-image-name');
    if (!fileName || !fileName.startsWith(prefix)) continue;
    const url = attribute(tag, 'data-src') ?? attribute(tag, 'src');
    if (!url || url.startsWith('data:')) continue;
    return { file_name: decodeHtml(fileName), url: decodeHtml(url) };
  }
  return null;
}

function linkTitles(cell) {
  return [...cell.matchAll(/<a\b[^>]*\btitle="([^"]+)"[^>]*>/gi)]
    .map((match) => decodeHtml(match[1]))
    .filter((title) => title && !title.startsWith('Category:'));
}

function lastLinkTitle(cell) {
  return linkTitles(cell).at(-1) ?? null;
}

function pageFromCell(cell) {
  const href = [...cell.matchAll(/<a\b[^>]*\bhref="\/wiki\/([^"#?]+)"[^>]*>/gi)].map((match) => match[1]).at(-1);
  return href ? decodeURIComponent(href).replaceAll('_', ' ') : null;
}

function text(cell) {
  return decodeHtml(cell);
}

function rarity(cell, prefix = '') {
  const source = `${text(cell)} ${cell}`;
  const match = /(?:Item Rank|AgentRank)?\s*([SAB]|[1-5])(?:\s*Stars?)?/i.exec(source)
    ?? /([1-5])\s*Stars?/i.exec(source);
  if (!match) return null;
  const value = match[1].toUpperCase();
  return /^[SAB]$/.test(value) ? `${value}-Rank` : `${value}-Star`;
}

function date(value) {
  const normalized = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (normalized) return normalized;
  const writtenDate = value.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i)?.[0] ?? value;
  const parsed = Date.parse(writtenDate);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

async function fetchParse(game, page, prop) {
  const { domain } = fandom[game];
  const url = new URL(`https://${domain}/api.php`);
  url.searchParams.set('action', 'parse');
  url.searchParams.set('page', page);
  url.searchParams.set('prop', prop);
  url.searchParams.set('format', 'json');
  const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!response.ok) throw new Error(`Fandom request failed (${response.status}) for ${domain}/${page}`);
  const body = await response.json();
  const value = body?.parse?.[prop]?.['*'];
  if (typeof value !== 'string') throw new Error(`Fandom response lacks ${prop} for ${domain}/${page}`);
  return value;
}

function infoboxFields(wikitext, template) {
  const index = wikitext.indexOf(`{{${template}`);
  if (index < 0) return {};
  const end = wikitext.indexOf('\n}}', index);
  const body = wikitext.slice(index, end < 0 ? wikitext.length : end);
  return Object.fromEntries([...body.matchAll(/^\|\s*([^=\n]+?)\s*=\s*(.*)$/gm)].map((match) => [match[1].trim(), match[2].trim()]));
}

function wikiText(value) {
  return decodeHtml(value
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<ref[^>]*>[^]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, ''));
}

async function mapWithConcurrency(values, concurrency, operation) {
  const result = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      result[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

function mergeMetadata(previous, current, fetched) {
  return { ...(previous ?? {}), ...current, ...(fetched ?? {}) };
}

async function enrichMissingMetadata(game, entries, previousEntries, template, fields) {
  const previous = new Map(previousEntries.map((entry) => [normalizeKey(entry.name), entry]));
  const targets = entries.filter((entry) => entry.page && fields.some((field) => !previous.get(normalizeKey(entry.name))?.metadata?.[field.target]));
  const enrichment = new Map(await mapWithConcurrency(targets, 5, async (entry) => {
    const wikitext = await fetchParse(game, entry.page, 'wikitext');
    const source = infoboxFields(wikitext, template);
    const values = {};
    for (const field of fields) {
      const value = wikiText(source[field.source] ?? '');
      if (value) values[field.target] = field.isDate ? date(value) : value;
    }
    return [entry.page, values];
  }));
  return entries.map((entry) => ({
    ...entry,
    metadata: mergeMetadata(
      previous.get(normalizeKey(entry.name))?.metadata,
      entry.metadata,
      entry.page ? enrichment.get(entry.page) : {},
    ),
  }));
}

function thumbnail(imageData, game, page) {
  if (!imageData) return {};
  return {
    thumbnail_provider: 'fandom',
    thumbnail_file: imageData.file_name,
    thumbnail_url: fullSizeAvatarUrl(imageData.url),
    thumbnail_source_page: `https://${fandom[game].domain}/wiki/${page}`,
  };
}

function mergeTags(current, names) {
  return [...new Set([...(current?.tags ?? []), ...names].filter((value) => typeof value === 'string' && value.trim()))];
}

function metadata(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function emptyIdentity(name, objectType) {
  return {
    name,
    hash_db: {},
    tags: [name],
    object_type: objectType,
    custom_skins: [],
    runtime_targets: [],
  };
}

function reconcileIdentities(currentEntries, generated, objectType) {
  const current = new Map(currentEntries.map((entry) => [normalizeKey(entry.name), entry]));
  return generated.map((entry) => {
    const previous = current.get(normalizeKey(entry.name));
    const base = previous ?? {
      ...emptyIdentity(entry.name, objectType),
      hash_db: entry.hash_db ?? {},
      tags: entry.tags ?? [entry.name],
      custom_skins: entry.custom_skins ?? [],
      runtime_targets: entry.runtime_targets ?? [],
    };
    return {
      ...base,
      name: entry.name,
      tags: mergeTags(base, entry.tags ?? [entry.name]),
      object_type: objectType,
      custom_skins: base.custom_skins ?? [],
      runtime_targets: base.runtime_targets ?? [],
      metadata: metadata({ ...(base.metadata ?? {}), ...entry.metadata }),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function duplicateNames(entries, label) {
  const seen = new Set();
  for (const entry of entries) {
    const key = normalizeKey(entry.name);
    if (seen.has(key)) throw new Error(`Duplicate ${label} identity: ${entry.name}`);
    seen.add(key);
  }
}

function uniqueByName(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = normalizeKey(entry.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function namePathVariants(entries) {
  const occurrences = new Map();
  for (const entry of entries) {
    const key = normalizeKey(entry.name);
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if ((occurrences.get(normalizeKey(entry.name)) ?? 0) < 2 || !entry.metadata.path) return entry;
    const path = entry.metadata.path === 'Hunt' ? 'The Hunt' : entry.metadata.path;
    return { ...entry, name: `${entry.name} (${path})`, tags: [entry.name, `${entry.name} ${path}`] };
  });
}

function wwmiRoverVariants() {
  const common = {
    tags: ['Black Shores', 'Arbiters', 'Spectro', 'Aero', 'Havoc', '漂泊者', 'Piāobózhě', 'Hyōhakusha', '방랑자', 'Bangrangja'],
    custom_skins: [{ name: 'Tides of Destiny', aliases: ['RoverTides', 'Rover2', 'MCRover2'], thumbnail_skin_path: null, rarity: '5' }],
    metadata: {
      release_date: '2024-05-23',
      rarity: '5-Star',
      element: 'Adaptive',
      weapon: 'Sword',
      region: 'Unknown',
    },
  };
  return [
    {
      ...common,
      name: 'Rover Male',
      hash_db: { Default: ['c9db8418'] },
      custom_skins: [{ name: 'Tides of Destiny (Male)', aliases: [], thumbnail_skin_path: null, rarity: '5' }],
      metadata: { ...common.metadata, gender: 'Male' },
    },
    {
      ...common,
      name: 'Rover Female',
      hash_db: { Default: ['e8b5a730'] },
      custom_skins: [{ name: 'Tides of Destiny (Female)', aliases: [], thumbnail_skin_path: null, rarity: '5' }],
      metadata: { ...common.metadata, gender: 'Female' },
    },
  ];
}

function disambiguateVariantSkins(game, entries) {
  const names = game === 'srmi'
    ? new Map([
      ['March 7th (Preservation)', 'Be the Show\'s Star (Preservation)'],
      ['March 7th (The Hunt)', 'Be the Show\'s Star (The Hunt)'],
    ])
    : new Map([
      ['Rover Male', 'Tides of Destiny (Male)'],
      ['Rover Female', 'Tides of Destiny (Female)'],
    ]);
  return entries.map((entry) => {
    const skinName = names.get(entry.name);
    if (!skinName) return entry;
    return {
      ...entry,
      custom_skins: (entry.custom_skins ?? []).map((skin) => ({
        ...skin,
        name: skinName,
        aliases: [],
      })),
    };
  });
}

function parseGenshinCharacters(html) {
  return uniqueByName(parseRows(html)
    .filter((row) => /\bdata-name=/.test(row.html) && /\bdata-release=/.test(row.html) && row.cells.length >= 9)
    .map((row) => {
      const name = attribute(row.html, 'data-name');
      if (!name) return null;
      const icon = image(row.cells[0], '') ?? image(row.cells[0], '');
      return {
        name: decodeHtml(name),
        metadata: {
          release_date: date(attribute(row.html, 'data-release') ?? text(row.cells[7])),
          rarity: rarity(row.cells[2]),
          element: text(row.cells[3]),
          weapon: text(row.cells[4]),
          region: text(row.cells[5]),
          model_type: text(row.cells[6]),
          release_version: attribute(row.html, 'data-version') ?? text(row.cells[8]),
          ...thumbnail(icon, 'gimi', 'Character/List'),
        },
      };
    })
    .filter(Boolean)
    .filter((entry) => entry.metadata.release_date));
}

function splitGenshinTraveler(entries) {
  const travelers = [
    {
      name: 'Aether',
      gender: 'Male',
      model_type: 'Medium Male',
      thumbnail_file: 'Aether Icon.png',
      thumbnail_url: 'https://static.wikia.nocookie.net/gensin-impact/images/a/a5/Aether_Icon.png/revision/latest/',
    },
    {
      name: 'Lumine',
      gender: 'Female',
      model_type: 'Medium Female',
      thumbnail_file: 'Lumine Icon.png',
      thumbnail_url: 'https://static.wikia.nocookie.net/gensin-impact/images/9/9c/Lumine_Icon.png/revision/latest/',
    },
  ];
  return entries.flatMap((entry) => {
    if (entry.name !== 'Traveler') return [entry];
    const baseMetadata = { ...entry.metadata };
    for (const key of ['thumbnail_asset_path', 'thumbnail_asset_sha256', 'thumbnail_asset_content_type', 'thumbnail_asset_source_url', 'thumbnail_width', 'thumbnail_height']) {
      delete baseMetadata[key];
    }
    const { thumbnail_path: _legacyThumbnailPath, ...identity } = entry;
    return travelers.map((traveler) => ({
      ...identity,
      name: traveler.name,
      tags: mergeTags(entry, ['Traveler', `${traveler.gender} Traveler`]),
      metadata: {
        ...baseMetadata,
        gender: traveler.gender,
        model_type: traveler.model_type,
        thumbnail_provider: 'fandom',
        thumbnail_file: traveler.thumbnail_file,
        thumbnail_url: traveler.thumbnail_url,
        thumbnail_source_page: 'https://genshin-impact.fandom.com/wiki/Traveler',
      },
    }));
  });
}

function parseHsrCharacters(html) {
  return parseRows(html)
    .filter((row) => row.cells.length === 5 && /Character .* Icon\.png/.test(row.cells[0]))
    .map((row) => {
      const name = lastLinkTitle(row.cells[0]);
      if (!name) return null;
      return {
        name,
        page: pageFromCell(row.cells[0]),
        metadata: {
          rarity: rarity(row.cells[1]),
          path: text(row.cells[2]),
          element: text(row.cells[3]),
          release_version: text(row.cells[4]),
          ...thumbnail(image(row.cells[0], 'Character '), 'srmi', 'Character/List'),
        },
      };
    })
    .filter(Boolean);
}

function parseWwCharacters(html) {
  return parseRows(html)
    .filter((row) => row.cells.length === 8 && /Resonator .*\.png/.test(row.cells[0]))
    .map((row) => {
      const name = lastLinkTitle(row.cells[0]);
      if (!name) return null;
      return {
        name,
        page: pageFromCell(row.cells[0]),
        metadata: {
          rarity: rarity(row.cells[1]),
          element: text(row.cells[2]),
          weapon: text(row.cells[3]),
          affiliation: text(row.cells[4]),
          faction: text(row.cells[5]),
          class: text(row.cells[6]),
          release_version: text(row.cells[7]),
          ...thumbnail(image(row.cells[0], 'Resonator '), 'wwmi', 'Resonator/List'),
        },
      };
    })
    .filter(Boolean);
}

function parseZzzCharacters(html) {
  return parseRows(html)
    .filter((row) => row.cells.length === 8 && /Agent .* Icon\.png/.test(row.cells[0]))
    .map((row) => {
      const name = lastLinkTitle(row.cells[1]);
      const releaseDate = date(text(row.cells[7]));
      if (!name || !releaseDate) return null;
      return {
        name,
        metadata: {
          release_date: releaseDate,
          rarity: rarity(row.cells[2]),
          element: text(row.cells[3]),
          specialty: text(row.cells[4]),
          attack_type: text(row.cells[5]),
          faction: text(row.cells[6]),
          ...thumbnail(image(row.cells[0], 'Agent '), 'zzmi', 'Agent/List'),
        },
      };
    })
    .filter(Boolean);
}

function parseGenshinWeapons(html, types) {
  return parseRows(html)
    .filter((row) => row.cells.length === 6 && /data-image-name="Weapon /.test(row.cells[0]))
    .map((row) => {
      const name = lastLinkTitle(row.cells[1]);
      if (!name) return null;
      const passiveName = /<b>([\s\S]*?)<\/b>/i.exec(row.cells[5])?.[1];
      return {
        name,
        metadata: {
          equipment_kind: 'Weapon',
          weapon_type: types.get(normalizeKey(name)) ?? 'Unknown',
          rarity: rarity(row.cells[2]),
          base_atk: text(row.cells[3]),
          secondary_stat: text(row.cells[4]),
          passive_name: passiveName ? text(passiveName) : null,
          ...thumbnail(image(row.cells[0], 'Weapon '), 'gimi', 'Weapon/List'),
        },
      };
    })
    .filter(Boolean);
}

function parseHsrLightCones(html) {
  return parseRows(html)
    .filter((row) => row.cells.length === 6 && /data-image-name="Light Cone /.test(row.cells[0]))
    .map((row) => {
      const name = lastLinkTitle(row.cells[0]);
      if (!name) return null;
      const passiveName = /<b>([\s\S]*?)<\/b>/i.exec(row.cells[4])?.[1];
      return {
        name,
        metadata: {
          equipment_kind: 'Light Cone',
          rarity: rarity(row.cells[1]),
          path: text(row.cells[2]),
          stats: text(row.cells[3]),
          passive_name: passiveName ? text(passiveName) : null,
          featured_characters: linkTitles(row.cells[5]).join(', '),
          ...thumbnail(image(row.cells[0], 'Light Cone '), 'srmi', 'Light_Cone/List'),
        },
      };
    })
    .filter(Boolean);
}

function parseWwWeapons(html) {
  return parseRows(html)
    .filter((row) => row.cells.length === 6 && /data-image-name="Weapon /.test(row.cells[0]))
    .map((row) => {
      const name = lastLinkTitle(row.cells[1]);
      if (!name) return null;
      return {
        name,
        metadata: {
          equipment_kind: 'Weapon',
          rarity: rarity(row.cells[2]),
          weapon_type: text(row.cells[3]),
          secondary_stat: text(row.cells[4]),
          acquisition_method: text(row.cells[5]),
          ...thumbnail(image(row.cells[0], 'Weapon '), 'wwmi', 'Weapon/List'),
        },
      };
    })
    .filter(Boolean);
}

function parseZzzWEngines(html) {
  return parseRows(html)
    .filter((row) => row.cells.length === 10 && /data-image-name="W-Engine /.test(row.cells[0]))
    .map((row) => {
      const name = lastLinkTitle(row.cells[1]);
      if (!name) return null;
      return {
        name,
        metadata: {
          equipment_kind: 'W-Engine',
          rarity: rarity(row.cells[2]),
          specialty: text(row.cells[3]),
          attribute: text(row.cells[4]),
          exclusive: linkTitles(row.cells[5]).join(', '),
          base_stat: text(row.cells[6]),
          advanced_stat: text(row.cells[7]),
          release_version: text(row.cells[9]),
          ...thumbnail(image(row.cells[0], 'W-Engine '), 'zzmi', 'W-Engine/List'),
        },
      };
    })
    .filter(Boolean);
}

async function genshinWeaponTypes() {
  const types = new Map();
  for (const type of ['Sword', 'Claymore', 'Polearm', 'Catalyst', 'Bow']) {
    const url = new URL('https://genshin-impact.fandom.com/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'categorymembers');
    url.searchParams.set('cmtitle', `Category:${type}s`);
    url.searchParams.set('cmtype', 'page');
    url.searchParams.set('cmlimit', '500');
    url.searchParams.set('format', 'json');
    const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (!response.ok) throw new Error(`Fandom category request failed (${response.status}) for ${type}`);
    const body = await response.json();
    for (const member of body?.query?.categorymembers ?? []) types.set(normalizeKey(member.title), type);
  }
  return types;
}

async function readCatalog(game) {
  const path = join(root, 'catalog', `${game}.json`);
  return { path, document: JSON.parse(await readFile(path, 'utf8')) };
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function avatarFileStem(name) {
  const stem = normalizeKey(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (stem) return stem;
  return createHash('sha256').update(name).digest('hex').slice(0, 16);
}

function avatarFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { extension: 'jpg', contentType: 'image/jpeg' };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return { extension: 'webp', contentType: 'image/webp' };
  }
  if (bytes.length >= 6 && (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) || bytes.subarray(0, 6).equals(Buffer.from('GIF89a')))) {
    return { extension: 'gif', contentType: 'image/gif' };
  }
  return null;
}

function avatarDimensions(bytes, format) {
  if (format.extension === 'png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (format.extension === 'gif' && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (format.extension === 'webp') return webpDimensions(bytes);
  if (format.extension === 'jpg') return jpegDimensions(bytes);
  return null;
}

function webpDimensions(bytes) {
  if (bytes.length < 21) return null;
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    const length = bytes.readUInt16BE(offset + 1);
    if (length < 2 || offset + 1 + length > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: bytes.readUInt16BE(offset + 6), height: bytes.readUInt16BE(offset + 4) };
    }
    offset += length + 1;
  }
  return null;
}

function avatarSourceUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || url.hostname !== 'static.wikia.nocookie.net'
  ) {
    throw new Error(`Unsupported avatar source: ${value}`);
  }
  return url;
}

function fullSizeAvatarUrl(value) {
  const url = avatarSourceUrl(value);
  url.pathname = url.pathname.replace(/\/revision\/latest\/scale-to-width-down\/\d+\/?$/, '/revision/latest/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function fetchAvatar(url) {
  const source = avatarSourceUrl(url);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(source, {
        headers: { 'User-Agent': userAgent },
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Avatar request failed (${response.status}) for ${source}`);
      const header = response.headers.get('content-length');
      if (header && Number(header) > maxAvatarBytes) throw new Error(`Avatar exceeds ${maxAvatarBytes} bytes: ${source}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > maxAvatarBytes) throw new Error(`Avatar exceeds ${maxAvatarBytes} bytes: ${source}`);
      const format = avatarFormat(bytes);
      if (!format) throw new Error(`Avatar is not a supported image: ${source}`);
      const dimensions = avatarDimensions(bytes, format);
      if (!dimensions || dimensions.width < minAvatarDimension || dimensions.height < minAvatarDimension) {
        throw new Error(`Avatar is below ${minAvatarDimension}x${minAvatarDimension}: ${source}`);
      }
      return { bytes, ...format, ...dimensions };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function existingAvatar(path, sourceUrl, checksum) {
  if (!path || !checksum || !sourceUrl) return null;
  const absolute = resolve(root, path);
  const avatarRoot = resolve(root, 'assets');
  if (!absolute.startsWith(`${avatarRoot}${process.platform === 'win32' ? '\\' : '/'}`)) return null;
  try {
    const bytes = await readFile(absolute);
    if (bytes.length === 0 || bytes.length > maxAvatarBytes) return null;
    const format = avatarFormat(bytes);
    if (!format || createHash('sha256').update(bytes).digest('hex') !== checksum) return null;
    const dimensions = avatarDimensions(bytes, format);
    if (!dimensions || dimensions.width < minAvatarDimension || dimensions.height < minAvatarDimension) return null;
    return { path, checksum, ...format, ...dimensions };
  } catch {
    return null;
  }
}

async function writeAvatar(path, bytes) {
  const absolute = resolve(root, path);
  const avatarRoot = resolve(root, 'assets');
  if (!absolute.startsWith(`${avatarRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Avatar asset path escapes assets: ${path}`);
  }
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, absolute);
}

async function moveAvatar(sourcePath, targetPath) {
  if (sourcePath === targetPath) return;
  const avatarRoot = resolve(root, 'assets');
  const source = resolve(root, sourcePath);
  const target = resolve(root, targetPath);
  const prefix = `${avatarRoot}${process.platform === 'win32' ? '\\' : '/'}`;
  if (!source.startsWith(prefix) || !target.startsWith(prefix)) {
    throw new Error(`Avatar asset path escapes assets during migration: ${sourcePath} -> ${targetPath}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}

function thumbnailMetadata(entry) {
  return entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
    ? entry.metadata
    : {};
}

function avatarCategory(entry) {
  if (entry.object_type === 'Character') return 'characters';
  if (entry.object_type === 'Weapon') return 'weapons';
  throw new Error(`Unsupported avatar entry type for ${entry.name}: ${entry.object_type}`);
}

async function avatarFiles(path) {
  const files = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await avatarFiles(child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Avatar asset contains an unsupported filesystem entry: ${child}`);
  }
  return files;
}

async function pruneUnreferencedAvatars(game, entries) {
  const avatarRoot = resolve(root, 'assets');
  const gameRoot = join(avatarRoot, game);
  const referenced = new Set(entries.map((entry) => entry.thumbnail_path).filter((path) => typeof path === 'string'));
  try {
    const files = await avatarFiles(gameRoot);
    let removed = 0;
    for (const file of files) {
      const relative = file.slice(root.length + 1).replaceAll('\\', '/');
      if (!referenced.has(relative)) {
        await rm(file);
        removed += 1;
      }
    }
    return removed;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function removeLegacyAvatarRoot(entries) {
  const legacyPrefix = 'assets/avatars/';
  if (entries.some((entry) => typeof entry.thumbnail_path === 'string' && entry.thumbnail_path.startsWith(legacyPrefix))) {
    throw new Error('Cannot remove legacy avatar assets while a catalog still references them.');
  }
  const legacyRoot = resolve(root, 'assets', 'avatars');
  try {
    const files = await avatarFiles(legacyRoot);
    await rm(legacyRoot, { recursive: true, force: true });
    return files.length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function materializeAvatars(game, entries) {
  const usedPaths = new Map();
  const avatarEntries = entries.filter((entry) => typeof thumbnailMetadata(entry).thumbnail_url === 'string');
  const hydrated = await mapWithConcurrency(avatarEntries, 8, async (entry) => {
    const previous = thumbnailMetadata(entry);
    const sourceUrl = fullSizeAvatarUrl(previous.thumbnail_url);
    const relative = join('assets', game, avatarCategory(entry), `${avatarFileStem(entry.name)}.${previous.thumbnail_asset_content_type?.split('/').at(-1) ?? 'webp'}`).replaceAll('\\', '/');
    const cached = await existingAvatar(relative, sourceUrl, previous.thumbnail_asset_sha256)
      ?? await existingAvatar(entry.thumbnail_path, sourceUrl, previous.thumbnail_asset_sha256);
    if (cached && previous.thumbnail_asset_source_url === sourceUrl) {
      const owner = usedPaths.get(relative);
      if (owner && owner !== entry.name) throw new Error(`Duplicate avatar asset path '${cached.path}' for ${owner} and ${entry.name}`);
      usedPaths.set(relative, entry.name);
      await moveAvatar(cached.path, relative);
      return {
        ...entry,
        thumbnail_path: relative,
        metadata: {
          ...previous,
          thumbnail_asset_path: relative,
          thumbnail_asset_sha256: cached.checksum,
          thumbnail_asset_content_type: cached.contentType,
          thumbnail_asset_source_url: sourceUrl,
          thumbnail_width: cached.width,
          thumbnail_height: cached.height,
          thumbnail_url: sourceUrl,
        },
        avatar_action: 'reused',
      };
    }
    const avatar = await fetchAvatar(sourceUrl);
    const downloadedRelative = join('assets', game, avatarCategory(entry), `${avatarFileStem(entry.name)}.${avatar.extension}`).replaceAll('\\', '/');
    const owner = usedPaths.get(downloadedRelative);
    if (owner && owner !== entry.name) throw new Error(`Duplicate avatar asset path '${downloadedRelative}' for ${owner} and ${entry.name}`);
    usedPaths.set(downloadedRelative, entry.name);
    await writeAvatar(downloadedRelative, avatar.bytes);
    return {
      ...entry,
      thumbnail_path: downloadedRelative,
      metadata: {
        ...previous,
        thumbnail_asset_path: downloadedRelative,
        thumbnail_asset_sha256: createHash('sha256').update(avatar.bytes).digest('hex'),
        thumbnail_asset_content_type: avatar.contentType,
        thumbnail_asset_source_url: sourceUrl,
        thumbnail_width: avatar.width,
        thumbnail_height: avatar.height,
        thumbnail_url: sourceUrl,
      },
      avatar_action: 'downloaded',
    };
  });
  const byName = new Map(hydrated.map((entry) => [entry.name, entry]));
  const report = hydrated.reduce((result, entry) => ({ ...result, [entry.avatar_action]: result[entry.avatar_action] + 1 }), { downloaded: 0, reused: 0 });
  const resolvedEntries = entries.map((entry) => {
    const hydratedEntry = byName.get(entry.name);
    if (!hydratedEntry) return entry;
    const { avatar_action, ...identity } = hydratedEntry;
    return identity;
  });
  return {
    entries: resolvedEntries,
    report: { ...report, pruned: await pruneUnreferencedAvatars(game, resolvedEntries) },
  };
}

async function refreshManifest() {
  const path = join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const game of Object.keys(fandom)) {
    const bytes = await readFile(join(root, 'catalog', `${game}.json`));
    manifest.catalogs[game].sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await atomicJson(path, manifest);
}

async function main() {
  if (command === 'avatars') {
    const report = {};
    for (const game of Object.keys(fandom)) {
      const { path, document } = await readCatalog(game);
      const materialized = await materializeAvatars(game, disambiguateVariantSkins(game, document.entries));
      document.entries = materialized.entries;
      await atomicJson(path, document);
      report[game] = materialized.report;
    }
    await refreshManifest();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const [gimiCharacterHtml, srmiCharacterHtml, wwmiCharacterHtml, zzmiCharacterHtml, gimiEquipmentHtml, srmiEquipmentHtml, wwmiEquipmentHtml, zzmiEquipmentHtml, gimiTypes] = await Promise.all([
    fetchParse('gimi', fandom.gimi.characterPage, 'text'),
    fetchParse('srmi', fandom.srmi.characterPage, 'text'),
    fetchParse('wwmi', fandom.wwmi.characterPage, 'text'),
    fetchParse('zzmi', fandom.zzmi.characterPage, 'text'),
    fetchParse('gimi', fandom.gimi.equipmentPage, 'text'),
    fetchParse('srmi', fandom.srmi.equipmentPage, 'text'),
    fetchParse('wwmi', fandom.wwmi.equipmentPage, 'text'),
    fetchParse('zzmi', fandom.zzmi.equipmentPage, 'text'),
    genshinWeaponTypes(),
  ]);

  const generated = {
    gimi: { characters: splitGenshinTraveler(parseGenshinCharacters(gimiCharacterHtml)), equipment: parseGenshinWeapons(gimiEquipmentHtml, gimiTypes) },
    srmi: { characters: namePathVariants(parseHsrCharacters(srmiCharacterHtml)), equipment: parseHsrLightCones(srmiEquipmentHtml) },
    wwmi: { characters: parseWwCharacters(wwmiCharacterHtml), equipment: parseWwWeapons(wwmiEquipmentHtml) },
    zzmi: { characters: parseZzzCharacters(zzmiCharacterHtml), equipment: parseZzzWEngines(zzmiEquipmentHtml) },
  };

  const report = {};
  const updatedEntries = [];
  for (const [game, entries] of Object.entries(generated)) {
    duplicateNames(entries.characters, `${game} character`);
    duplicateNames(entries.equipment, `${game} equipment`);
    const { path, document } = await readCatalog(game);
    const previousCharacters = document.entries.filter((entry) => entry.object_type === 'Character' && entry.entry_kind !== 'taxonomy');
    const previousEquipment = document.entries.filter((entry) => entry.object_type === 'Weapon' && entry.entry_kind !== 'taxonomy');
    const retained = document.entries.filter((entry) => entry.entry_kind === 'taxonomy' || (entry.object_type !== 'Character' && entry.object_type !== 'Weapon'));
    if (game === 'srmi') {
      entries.characters = await enrichMissingMetadata(game, entries.characters, previousCharacters, 'Character Infobox', [
        { source: 'release_date', target: 'release_date', isDate: true },
        { source: 'faction', target: 'faction' },
        { source: 'world', target: 'world' },
        { source: 'lightcone', target: 'signature_light_cone' },
      ]);
    }
    if (game === 'wwmi') {
      entries.characters = await enrichMissingMetadata(game, entries.characters, previousCharacters, 'Resonator Infobox', [
        { source: 'releaseDate', target: 'release_date', isDate: true },
        { source: 'gender', target: 'gender' },
        { source: 'nation', target: 'region' },
        { source: 'title', target: 'title' },
      ]);
      entries.characters = [
        ...entries.characters.filter((entry) => entry.metadata.release_date),
        ...wwmiRoverVariants(),
      ];
    }
    const next = {
      ...document,
      entries: disambiguateVariantSkins(game, [
        ...reconcileIdentities(previousCharacters, entries.characters, 'Character'),
        ...reconcileIdentities(previousEquipment, entries.equipment, 'Weapon'),
        ...retained,
      ]),
    };
    if (command === 'update') {
      const materialized = await materializeAvatars(game, next.entries);
      next.entries = materialized.entries;
      report[game] = {
        characters: { before: previousCharacters.length, after: entries.characters.length },
        equipment: { before: previousEquipment.length, after: entries.equipment.length },
        avatars: materialized.report,
      };
    } else {
      report[game] = {
        characters: { before: previousCharacters.length, after: entries.characters.length },
        equipment: { before: previousEquipment.length, after: entries.equipment.length },
      };
    }
    if (command === 'update') {
      await atomicJson(path, next);
      updatedEntries.push(...next.entries);
    }
  }
  if (command === 'update') {
    report.legacy_avatar_assets_pruned = await removeLegacyAvatarRoot(updatedEntries);
    await refreshManifest();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isMain) await main();

export {
  decodeHtml,
  parseGenshinCharacters,
  splitGenshinTraveler,
  parseHsrCharacters,
  parseWwCharacters,
  parseZzzCharacters,
  parseGenshinWeapons,
  parseHsrLightCones,
  parseWwWeapons,
  parseZzzWEngines,
  disambiguateVariantSkins,
  fullSizeAvatarUrl,
  mergeMetadata,
};
