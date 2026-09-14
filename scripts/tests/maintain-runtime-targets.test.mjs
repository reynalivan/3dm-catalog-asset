import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callbackSlot,
  candidateV2Snapshot,
  collectTargets,
  findAmbiguousHashes,
} from '../maintain-runtime-targets.mjs';

test('extracts GIMI geometry keys without requiring hash in the key name', () => {
  const targets = collectTargets({
    root_vs: '653c63ba4a73ca8b',
    draw_vb: '44e3487a',
    position_vb: '6895f405',
    blend_vb: 'e211de60',
    texcoord_vb: '8b17a419',
    ib: 'e811d2a1',
    texture_hashes: { FaceDiffuse: 'a44625da' },
  });

  assert.deepEqual(
    targets.map((target) => [target.resource_kind, target.hash]),
    [
      ['shader', '653c63ba4a73ca8b'],
      ['draw_vb', '44e3487a'],
      ['position_vb', '6895f405'],
      ['vertex_buffer', 'e211de60'],
      ['vertex_buffer', '8b17a419'],
      ['index_buffer', 'e811d2a1'],
      ['texture', 'a44625da'],
    ],
  );
  assert.equal(callbackSlot(targets[2]), 'vb0');
  assert.equal(callbackSlot(targets[3]), 'vb1');
  assert.equal(callbackSlot(targets[4]), 'vb2');
  assert.equal(callbackSlot(targets[6]), null);
});

test('creates index-buffer candidates with every validated draw context', () => {
  const candidate = {
    game: 'gimi',
    path: 'PlayerCharacterData/Arlecchino/hash.json',
    status: 'mapped_candidate',
    mapping: {
      canonical_id: 'Arlecchino',
      variant: 'Default',
    },
    object_indexes: [40179, 0, 40179],
    targets: [
      { resource_kind: 'position_vb', hash: '6895f405', source_key: 'position_vb' },
      { resource_kind: 'index_buffer', hash: 'e811d2a1', source_key: 'ib' },
    ],
  };
  const entries = candidateV2Snapshot([candidate], {
    gimi: {
      repository: 'SilentNightSound/GI-Model-Importer-Assets',
      commit: '2039d16',
    },
  });

  assert.equal(entries.length, 1);
  assert.deepEqual(
    entries[0].runtime_targets
      .filter((target) => target.resource_kind === 'index_buffer')
      .map((target) => target.match_first_index),
    [0, 40179],
  );
});

test('reports only typed collisions between different canonical identities', () => {
  const collisions = findAmbiguousHashes([
    {
      game: 'gimi',
      canonical_id: 'Character A',
      runtime_targets: [{ resource_kind: 'position_vb', hash: 'shared00', slot: 'vb0' }],
    },
    {
      game: 'gimi',
      canonical_id: 'Character B',
      runtime_targets: [{ resource_kind: 'position_vb', hash: 'shared00', slot: 'vb0' }],
    },
  ]);

  assert.deepEqual(collisions, [{
    key: 'gimi:shared00:position_vb:vb0:',
    canonical_ids: ['Character A', 'Character B'],
  }]);
});
