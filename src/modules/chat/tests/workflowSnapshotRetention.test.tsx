import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: vi.fn() } } }));

const progress = (id: string, taskId: string, seq: number, title?: string): NormalizedMessage => ({
  id, taskId, seq, runId: 'run-one', sessionId: 'session-one', provider: 'claude',
  kind: 'status', workflow: true, timestamp: '2026-09-11T12:00:00Z', text: `Progress ${id}`,
  ...(title ? { workflowProgress: [{ type: 'workflow_phase', index: 0, title }], workflowProgressTruncated: false } : {}),
});

beforeEach(() => localStorage.clear());

test('live history retains only the latest Workflow snapshot per task without removing progress rows', () => {
  const view = renderHook(() => useSessionStore('workflow-retention-fixture'));
  const previous = progress('a-before', 'task-a', 1, 'A before');
  act(() => {
    view.result.current.appendRealtime('session-one', previous);
    view.result.current.appendRealtime('session-one', progress('b-current', 'task-b', 2, 'B current'));
    view.result.current.appendRealtime('session-one', progress('a-current', 'task-a', 3, 'A current'));
    view.result.current.appendRealtime('session-one', progress('a-heartbeat', 'task-a', 4));
  });
  const records = view.result.current.getMessages('session-one');
  expect(records.map(record => record.id)).toEqual(['a-before', 'b-current', 'a-current', 'a-heartbeat']);
  expect(records.map(record => record.text)).toEqual(['Progress a-before', 'Progress b-current', 'Progress a-current', 'Progress a-heartbeat']);
  expect(records[0].workflowProgress).toBeUndefined();
  expect(records[0].workflowProgressTruncated).toBeUndefined();
  expect(records[1].workflowProgress?.[0]).toMatchObject({ title: 'B current' });
  expect(records[2].workflowProgress?.[0]).toMatchObject({ title: 'A current' });
  expect(records[3].workflowProgress).toBeUndefined();
  expect(previous.workflowProgress?.[0]).toMatchObject({ title: 'A before' });
});

test('an older replay cannot replace the current Workflow details and another run remains separate', () => {
  const view = renderHook(() => useSessionStore('workflow-replay-fixture'));
  act(() => {
    view.result.current.appendRealtime('session-one', progress('new', 'task-a', 10, 'Current'));
    view.result.current.appendRealtime('session-one', progress('old-replay', 'task-a', 5, 'Old'));
    view.result.current.appendRealtime('session-one', { ...progress('other-run', 'task-a', 1, 'Separate'), runId: 'other-run' });
  });
  const records = view.result.current.getMessages('session-one');
  expect(records.find(record => record.id === 'new')?.workflowProgress?.[0]).toMatchObject({ title: 'Current' });
  expect(records.find(record => record.id === 'old-replay')?.workflowProgress).toBeUndefined();
  expect(records.find(record => record.id === 'other-run')?.workflowProgress?.[0]).toMatchObject({ title: 'Separate' });
});
