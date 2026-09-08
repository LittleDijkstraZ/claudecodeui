import assert from 'node:assert/strict';
import test from 'node:test';
import { readClaudeTitleRecords } from '@/modules/providers/services/claude-session-identity.service.js';

test('distinguishes native automatic and renamed titles without guessing from prompts', () => {
  const records = [
    { sessionId: 'native-a', type: 'ai-title', aiTitle: 'Old auto' },
    { sessionId: 'other', type: 'ai-title', aiTitle: 'Unrelated title' },
    { sessionId: 'native-a', type: 'custom-title', customTitle: 'Native rename' },
    { sessionId: 'native-a', type: 'ai-title', aiTitle: 'New auto' },
    { sessionId: 'native-a', type: 'last-prompt', lastPrompt: 'Not an automatic title' },
  ];
  assert.deepEqual(readClaudeTitleRecords(records.map(row => JSON.stringify(row)).join('\n'), 'native-a'), { automaticTitle: 'New auto', renamedTitle: 'Native rename' });
  assert.deepEqual(readClaudeTitleRecords('invalid\n'+JSON.stringify(records.at(-1)), 'native-a'), { automaticTitle: null, renamedTitle: null });
});
