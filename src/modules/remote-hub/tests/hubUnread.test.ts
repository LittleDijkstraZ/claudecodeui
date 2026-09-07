import { beforeEach, expect, test } from 'vitest';

import { getHubUnread, readHubConversation, recordHubUnread } from '@/modules/remote-hub/utils/hubUnread';
beforeEach(() => localStorage.clear());
test('read completion survives reconnect and a new completion becomes unread independently on each machine', () => {
  expect(recordHubUnread('alpha', 'same', 'one')).toEqual(['same']);
  recordHubUnread('beta', 'same', 'one');
  readHubConversation('alpha', 'same');
  expect(recordHubUnread('alpha', 'same', 'one')).toEqual([]);
  expect(getHubUnread('beta')).toEqual(['same']);
  expect(recordHubUnread('alpha', 'same', 'two')).toEqual(['same']);
});
test('old activity timestamps and opening a conversation never create unread state', () => {
  readHubConversation('alpha', 'old');
  expect(getHubUnread('alpha')).toEqual([]);
});
