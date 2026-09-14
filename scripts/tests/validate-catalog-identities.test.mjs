import assert from 'node:assert/strict';
import test from 'node:test';
import { duplicateAssetPaths, duplicateOwners } from '../validate-catalog-identities.mjs';

test('reports direct-name collisions but does not treat tags as aliases', () => {
  const entries = [
    { name: 'Alice', object_type: 'Character', tags: ['New Eridu'] },
    { name: 'New Eridu', object_type: 'Character' },
    { name: 'ALICE', object_type: 'Character' },
  ];
  assert.deepEqual(duplicateOwners(entries), [{ key: 'Character:alice', entries: ['ALICE', 'Alice'] }]);
});

test('reports two identities that would overwrite the same avatar', () => {
  assert.deepEqual(duplicateAssetPaths([
    { name: 'Alice', thumbnail_path: 'assets/gimi/characters/alice.png' },
    { name: 'Alice Alt', thumbnail_path: 'assets/gimi/characters/alice.png' },
  ]), [{ path: 'assets/gimi/characters/alice.png', entries: ['Alice', 'Alice Alt'] }]);
});
