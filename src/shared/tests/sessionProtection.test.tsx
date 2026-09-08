import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import { readSessionRuntimeState } from '@/shared/utils';

const CLIENT_NOW = Date.parse('2026-09-07T12:00:00Z');
const BACKGROUND = { executionId: 'execution-one', phase: 'background' as const, acceptsInput: true, backgroundTasks: 2 };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CLIENT_NOW); });
afterEach(() => vi.useRealTimers());

test.each([-86_400_000, 86_400_000])('a remote clock offset of %i cannot keep a finished process active', offset => {
  const { result } = renderHook(useSessionProtection);
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', startedAt: CLIENT_NOW + offset, ...BACKGROUND }]));
  act(() => vi.advanceTimersByTime(1));
  const checkedAt = Date.now();
  act(() => result.current.markSessionIdle('session-a', { ifStartedBefore: checkedAt }));
  expect(result.current.isSessionProcessing('session-a')).toBe(false);
});

test('a disappeared process expires after the local grace period even when its remote clock is ahead', () => {
  const { result } = renderHook(useSessionProtection);
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', startedAt: CLIENT_NOW + 86_400_000, ...BACKGROUND }]));
  act(() => vi.advanceTimersByTime(10_001));
  act(() => result.current.syncProcessingSessions([]));
  expect(result.current.isSessionProcessing('session-a')).toBe(false);
});

test('an older idle acknowledgement cannot clear a newly dispatched local request', () => {
  const { result } = renderHook(useSessionProtection);
  const checkedAt = Date.now();
  act(() => vi.advanceTimersByTime(1));
  act(() => result.current.markSessionProcessing('session-a', { executionId: 'new-execution', acceptsInput: false }));
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', executionId: 'new-execution', startedAt: CLIENT_NOW - 86_400_000 }]));
  act(() => result.current.markSessionIdle('session-a', { ifStartedBefore: checkedAt }));
  expect(result.current.isSessionProcessing('session-a')).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  act(() => result.current.markSessionIdle('session-a', { ifStartedBefore: Date.now() }));
  expect(result.current.isSessionProcessing('session-a')).toBe(false);
});

test('partial snapshots preserve a confirmed input stream only for the same execution', () => {
  const { result } = renderHook(useSessionProtection);
  act(() => result.current.markSessionProcessing('session-a', BACKGROUND));
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', executionId: 'execution-one', statusText: 'Workflow progress' }]));
  expect(result.current.processingSessions.get('session-a')).toMatchObject(BACKGROUND);
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', executionId: 'execution-one', acceptsInput: false }]));
  expect(result.current.processingSessions.get('session-a')?.acceptsInput).toBe(false);
  act(() => result.current.markSessionIdle('session-a'));
  expect(result.current.processingSessions.has('session-a')).toBe(false);
});

test.each(['execution-two', undefined])('a replacement snapshot with execution %s never inherits the prior input stream', executionId => {
  const { result } = renderHook(useSessionProtection);
  act(() => result.current.markSessionProcessing('session-a', BACKGROUND));
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', executionId }]));
  const replacement = result.current.processingSessions.get('session-a');
  expect(replacement?.acceptsInput).toBeUndefined();
  expect(replacement?.backgroundTasks).toBeUndefined();
  act(() => vi.advanceTimersByTime(10_001));
  act(() => result.current.syncProcessingSessions([]));
  expect(result.current.isSessionProcessing('session-a')).toBe(false);
});

test('switching to background in a partial snapshot clears the foreground timer', () => {
  const { result } = renderHook(useSessionProtection);
  act(() => result.current.markSessionProcessing('session-a', { ...BACKGROUND, phase: 'foreground', foregroundTurnId: 'turn-one', foregroundStartedAt: '2026-09-07T12:00:00Z' }));
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', executionId: 'execution-one', phase: 'background' }]));
  const activity = result.current.processingSessions.get('session-a');
  expect(activity?.acceptsInput).toBe(true);
  expect(activity?.foregroundTurnId).toBeUndefined();
  expect(activity?.foregroundStartedAt).toBeUndefined();
});

test('input modes are validated, retained for the owning execution and removed on a replacement', () => {
  const { result } = renderHook(useSessionProtection);
  const parsed = readSessionRuntimeState({ ...BACKGROUND, inputModes: ['queue', 'interrupt', 'interrupt', 'unsafe', null] });
  expect(parsed.inputModes).toEqual(['queue', 'interrupt']);
  act(() => result.current.markSessionProcessing('session-a', parsed));
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', executionId: BACKGROUND.executionId }]));
  expect(result.current.processingSessions.get('session-a')?.inputModes).toEqual(['queue', 'interrupt']);
  act(() => result.current.markSessionProcessing('session-a', { ...BACKGROUND, inputModes: ['queue'] }));
  expect(result.current.processingSessions.get('session-a')?.inputModes).toEqual(['queue']);
  act(() => result.current.syncProcessingSessions([{ sessionId: 'session-a', executionId: 'replacement' }]));
  expect(result.current.processingSessions.get('session-a')?.inputModes).toBeUndefined();
});
