import { beforeEach, expect, test } from 'vitest';

import { getHubUnread, markHubConversationUnread, readHubConversation, recordHubUnread } from '@/modules/remote-hub/utils/hubUnread';
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


test('manual unread persists independently per remote until explicit reading, preserving replay deduplication', () => {
  recordHubUnread('alpha', 'same', 'one');
  readHubConversation('alpha', 'same');
  markHubConversationUnread('alpha', 'same');
  expect(readHubConversation('alpha', 'same', true)).toBe(false);
  expect(getHubUnread('alpha')).toEqual(['same']);
  expect(getHubUnread('beta')).toEqual([]);
  recordHubUnread('alpha', 'same', 'two');
  expect(readHubConversation('alpha', 'same', true)).toBe(false);
  readHubConversation('alpha', 'same');
  expect(recordHubUnread('alpha', 'same', 'two')).toEqual([]);
  markHubConversationUnread('alpha', 'no-completion');
  expect(getHubUnread('alpha')).toEqual(['no-completion']);
});
