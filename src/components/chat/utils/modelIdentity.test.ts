import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderModelOption } from '../../../types/app';

import { modelVersionKey, selectModelVersion, uniqueModelVersions } from './modelIdentity';

const options: ProviderModelOption[] = [
  { value: 'opus[1m]', label: 'Opus', contextMode: '1m' },
  { value: 'opus', label: 'Opus', contextMode: 'default' },
  { value: 'claude-version-exact', label: 'Exact', contextMode: 'default' },
];

test('version picker deduplicates capacity variants without inventing or changing version IDs', () => {
  assert.deepEqual(uniqueModelVersions(options).map(({ value }) => value), ['opus', 'claude-version-exact']);
  assert.equal(modelVersionKey({ value: 'custom-1m-version' }), 'custom-1m-version');
});

test('switching versions preserves requested capacity only when the destination supplies it', () => {
  assert.equal(selectModelVersion(options, options[1], options[0]), 'opus[1m]');
  assert.equal(selectModelVersion(options, options[2], options[0]), 'claude-version-exact');
});
