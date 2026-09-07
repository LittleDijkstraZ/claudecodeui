import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCurrentRewindPreview, savedClaudeMessageId } from './claudeSessionActionChecks';
import type { RewindPreview } from './claudeSessionActionsApi';

const id = '8a4ee612-7076-4605-846b-f4af596afbaa';

test('saved message actions resolve a normalized part to the server-confirmed original message', () => {
  assert.equal(savedClaudeMessageId(`${id}_text_0`, [id]), id);
  assert.equal(savedClaudeMessageId(id, [id]), id);
  assert.equal(savedClaudeMessageId(`${id}_text_0`, []), null);
  assert.equal(savedClaudeMessageId(`${id}different`, [id]), null);
  assert.equal(savedClaudeMessageId('local_optimistic_message', [id]), null);
  assert.equal(savedClaudeMessageId(undefined, [id]), null);
});

test('confirmation requires a successful matching unexpired server preview', () => {
  const now = Date.now();
  const preview: RewindPreview = {
    previewToken: 'server-only-preview', expiresAt: now + 5000, messageId: id,
    mode: 'files', canRewind: true, filesChanged: ['src/example.ts'], insertions: 2, deletions: 1,
    error: null, fileScope: 'native-edit-checkpoints', conversationBoundary: 'includes-selected-message',
  };
  assert.equal(isCurrentRewindPreview(preview, 'files', now), true);
  assert.equal(isCurrentRewindPreview(preview, 'both', now), false);
  assert.equal(isCurrentRewindPreview(preview, 'files', now + 5000), false);
  assert.equal(isCurrentRewindPreview({ ...preview, canRewind: false }, 'files', now), false);
  assert.equal(isCurrentRewindPreview({ ...preview, previewToken: '' }, 'files', now), false);
  assert.equal(isCurrentRewindPreview(null, 'files', now), false);
});
