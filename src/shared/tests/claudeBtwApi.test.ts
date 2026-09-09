import { afterEach, expect, it, vi } from 'vitest';

import { askClaudeBtw } from '@/shared/api';

const history = [{ question: 'Previous question', response: 'Previous answer' }];
const rejected = () => new Response(JSON.stringify({ success: false, error: { message: 'Unexpected action field.' } }), { status: 400 });
const success = () => new Response(JSON.stringify({ success: true, data: { answer: 'Answer' } }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

it('uses explicit native history on current remotes without replaying the request', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(success()); vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  expect(await askClaudeBtw('source', 'Follow-up', signal, history)).toEqual({ answer: 'Answer' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ question: 'Follow-up', history });
});

it('supports older remotes by packaging prior exchanges into a fresh native BTW question', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(success()); vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  await askClaudeBtw('source', 'Follow-up', signal, history);
  expect(fetch).toHaveBeenCalledTimes(2);
  const [url, init] = fetch.mock.calls[1];
  expect(url).toBe('/api/claude-sessions/source/btw');
  expect(init.signal).toBe(signal);
  const body = JSON.parse(init.body);
  expect(Object.keys(body)).toEqual(['question']);
  expect(body.question).toContain('Previous question');
  expect(body.question).toContain('Previous answer');
  expect(body.question).toContain('Current follow-up question:\nFollow-up');
});

it('bounds escaped legacy context and keeps the newest question intact', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(success()); vi.stubGlobal('fetch', fetch);
  await askClaudeBtw('source', 'Latest question', new AbortController().signal, [
    { question: 'Oldest question', response: 'Oldest answer' },
    { question: 'Recent question', response: '"\\\n'.repeat(16000) },
  ]);
  const body = JSON.parse(fetch.mock.calls[1][1].body);
  expect(body.question.length).toBeLessThanOrEqual(16000);
  expect(body.question).toContain('Recent question');
  expect(body.question).not.toContain('Oldest answer');
  expect(body.question.endsWith('Latest question')).toBe(true);
});

it('never replays provider failures or cancelled requests', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Network timeout')); vi.stubGlobal('fetch', fetch);
  await expect(askClaudeBtw('source', 'Follow-up', new AbortController().signal, history)).rejects.toThrow('Network timeout');
  expect(fetch).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  fetch.mockReset().mockImplementationOnce(() => { controller.abort(); return Promise.resolve(rejected()); });
  await expect(askClaudeBtw('source', 'Follow-up', controller.signal, history)).rejects.toThrow('Unexpected action field.');
  expect(fetch).toHaveBeenCalledTimes(1);
});
