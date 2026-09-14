import assert from 'node:assert/strict';
import test from 'node:test';
import { isPinnedRevision, summarizeRuntimeReport, summarizeWikiReport } from '../refresh-catalog-sources.mjs';

test('recognizes a pinned short SHA against a GitHub commit SHA', () => {
  assert.equal(isPinnedRevision('2039d16', '2039d16d4b64696098ba53cd69888ce967397be9'), true);
  assert.equal(isPinnedRevision('2039d16', 'eff6cdf613cb3b07cc2415ca3f287abe3b1496b71'), false);
});

test('summarizes source reports without exposing every candidate', () => {
  assert.deepEqual(summarizeWikiReport({
    gimi: { characters: { before: 100, after: 120 }, equipment: { before: 200, after: 255 } },
  }), { gimi: { characters: 120, equipment: 255 } });
  assert.deepEqual(summarizeRuntimeReport({
    candidate_count: 3,
    unmapped_count: 2,
    empty_target_count: 1,
    shader_target_count: 4,
    ambiguous_hashes: [{ key: 'gimi:abc' }],
    inventory: { gimi: { files: [{ path: 'hash.json' }] } },
  }), {
    candidate_count: 3,
    unmapped_count: 2,
    empty_target_count: 1,
    shader_target_count: 4,
    ambiguous_hash_count: 1,
    metadata_files: { gimi: 1 },
  });
});
