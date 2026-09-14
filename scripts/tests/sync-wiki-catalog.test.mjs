import assert from 'node:assert/strict';
import test from 'node:test';
import { disambiguateVariantSkins, fullSizeAvatarUrl, mergeMetadata, parseGenshinCharacters, parseZzzWEngines, splitGenshinTraveler } from '../sync-wiki-catalog.mjs';

test('normalizes Fandom thumbnails to the original image endpoint', () => {
  assert.equal(
    fullSizeAvatarUrl('https://static.wikia.nocookie.net/gensin-impact/images/a/a3/Aino_Icon.png/revision/latest/scale-to-width-down/50?cb=20250910025341'),
    'https://static.wikia.nocookie.net/gensin-impact/images/a/a3/Aino_Icon.png/revision/latest/',
  );
});

test('parses released Genshin characters and excludes rows without a release date', () => {
  const html = `<tr><td><img data-image-name="Albedo Icon.png" data-src="https://static.wikia.nocookie.net/gensin-impact/images/a/a3/Albedo_Icon.png/revision/latest/scale-to-width-down/50?cb=1"></td><td data-name="Albedo">Albedo</td><td title="5 Stars">5 Stars</td><td>Geo</td><td>Sword</td><td>Mondstadt</td><td>Medium Male</td><td data-release="2020-12-23">December 23, 2020</td><td data-version="1.2">1.2</td></tr><tr><td></td><td data-name="Future">Future</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`;
  assert.deepEqual(parseGenshinCharacters(html), [{
    name: 'Albedo',
    metadata: {
      release_date: '2020-12-23',
      rarity: '5-Star',
      element: 'Geo',
      weapon: 'Sword',
      region: 'Mondstadt',
      model_type: 'Medium Male',
      release_version: '1.2',
      thumbnail_provider: 'fandom',
      thumbnail_file: 'Albedo Icon.png',
      thumbnail_url: 'https://static.wikia.nocookie.net/gensin-impact/images/a/a3/Albedo_Icon.png/revision/latest/',
      thumbnail_source_page: 'https://genshin-impact.fandom.com/wiki/Character/List',
    },
  }]);
});

test('splits the Genshin Traveler into distinct Aether and Lumine identities', () => {
  const identities = splitGenshinTraveler([{
    name: 'Traveler',
    object_type: 'Character',
    tags: ['Traveler'],
    metadata: {
      release_date: '2020-09-28',
      thumbnail_asset_path: 'assets/gimi/characters/traveler.webp',
      thumbnail_asset_sha256: 'a'.repeat(64),
    },
    thumbnail_path: 'assets/gimi/characters/traveler.webp',
  }]);
  assert.deepEqual(identities.map((entry) => entry.name), ['Aether', 'Lumine']);
  assert.equal(identities[0].metadata.thumbnail_url, 'https://static.wikia.nocookie.net/gensin-impact/images/a/a5/Aether_Icon.png/revision/latest/');
  assert.equal(identities[1].metadata.thumbnail_url, 'https://static.wikia.nocookie.net/gensin-impact/images/9/9c/Lumine_Icon.png/revision/latest/');
  assert.equal(identities.every((entry) => entry.thumbnail_path === undefined), true);
});

test('parses ZZZ W-Engine metadata from an equipment row', () => {
  const html = `<tr><td><img data-image-name="W-Engine Deep Sea Visitor.png" data-src="https://static.wikia.nocookie.net/zenless-zone-zero/images/a/a3/W-Engine_Deep_Sea_Visitor.png/revision/latest/scale-to-width-down/50?cb=1"></td><td><a title="Deep Sea Visitor">Deep Sea Visitor</a></td><td title="Item Rank S">S</td><td>Attack</td><td>Ice</td><td><a title="Ellen Joe">Ellen Joe</a></td><td>Base ATK 48-713</td><td>CRIT Rate 9.6%-24%</td><td>Effect</td><td>1.0</td></tr>`;
  assert.equal(parseZzzWEngines(html)[0].name, 'Deep Sea Visitor');
  assert.equal(parseZzzWEngines(html)[0].metadata.rarity, 'S-Rank');
  assert.equal(parseZzzWEngines(html)[0].metadata.exclusive, 'Ellen Joe');
});

test('retains previously enriched metadata when a list omits the field', () => {
  assert.deepEqual(
    mergeMetadata({ release_date: '2024-05-23', gender: 'Female' }, { release_version: '1.0' }, {}),
    { release_date: '2024-05-23', gender: 'Female', release_version: '1.0' },
  );
});

test('keeps form-specific skins from creating an ambiguous direct match', () => {
  const [preservation, hunt] = disambiguateVariantSkins('srmi', [
    { name: 'March 7th (Preservation)', custom_skins: [{ name: "Be the Show's Star", aliases: ['March2'] }] },
    { name: 'March 7th (The Hunt)', custom_skins: [{ name: "Be the Show's Star", aliases: ['March2'] }] },
  ]);
  assert.deepEqual(preservation.custom_skins, [{ name: "Be the Show's Star (Preservation)", aliases: [] }]);
  assert.deepEqual(hunt.custom_skins, [{ name: "Be the Show's Star (The Hunt)", aliases: [] }]);
});
