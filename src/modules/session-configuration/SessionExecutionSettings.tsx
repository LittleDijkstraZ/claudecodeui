import { useCallback, useEffect, useRef, useState } from 'react';

import { api, claudeExecutionSettingsApi } from '@/shared/api';
import type { ClaudeSessionExecutionSnapshot, ClaudeSessionSettings, LLMProvider, ProviderModelOption } from '@/shared/types';

/** Used by Chat and retained Shell panes to distinguish requested, reported and next-launch configuration. */
export function SessionExecutionSettings({ sessionId, provider, surface, executionId, presentation = 'inline' }: {
  sessionId: string | null;
  provider: LLMProvider;
  surface: 'chat' | 'shell';
  executionId?: string | null;
  /** In the model menu the existing controls already select next settings. */
  presentation?: 'inline' | 'menu';
}) {
  // One server snapshot contains both the frozen execution and independent next-launch choice.
  const [snapshot, setSnapshot] = useState<ClaudeSessionExecutionSnapshot | null>(null);
  // Only model choices returned by this remote are offered; no probing conversations are created.
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  // The details panel controls polling and exposes settings without expanding the transcript by default.
  const [open, setOpen] = useState(false);
  // Mutations are serialized so a rapid second click cannot overwrite a newer selection.
  const [saving, setSaving] = useState(false);
  // Validation/resume errors remain visible instead of implying the requested choice applied.
  const [error, setError] = useState<string | null>(null);

  // Each read/write is scoped to the currently rendered session and retained execution.
  const identity = `${provider}:${sessionId || ''}:${executionId || ''}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const requestSequence = useRef(0);
  const mutation = useRef<{ identity: string; sequence: number } | null>(null);

  const acceptSnapshot = useCallback((incoming: ClaudeSessionExecutionSnapshot) => {
    setSnapshot((previous) => {
      if (previous?.sessionId !== incoming.sessionId) return incoming;
      // Saving the shared next choice must not replace a retained Shell's execution
      // with whichever execution happens to be latest on the server.
      const candidate = executionId && incoming.execution?.executionId !== executionId
        ? previous.execution : incoming.execution;
      const prior = previous.execution;
      const execution = candidate && prior?.executionId === candidate.executionId
        ? { ...candidate,
          ...(prior.endedAt && !candidate.endedAt ? { endedAt: prior.endedAt, status: prior.status } : {}),
          observed: prior.observed.observedAt && (!candidate.observed.observedAt || prior.observed.observedAt > candidate.observed.observedAt)
            ? prior.observed : candidate.observed }
        : candidate;
      return { ...incoming, execution };
    });
  }, [executionId]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!sessionId || provider !== 'claude' || mutation.current?.identity === identity) return;
    const sequence = ++requestSequence.current;
    const isCurrent = () => !signal?.aborted && identityRef.current === identity && requestSequence.current === sequence;

    try {
      const response = await claudeExecutionSettingsApi.read(sessionId, executionId, { signal });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || 'Configuration unavailable');
      if (isCurrent() && payload.data?.sessionId === sessionId) { acceptSnapshot(payload.data); setError(null); }
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : 'Configuration unavailable');
    }
  }, [acceptSnapshot, executionId, identity, provider, sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setSaving(mutation.current?.identity === identity);
    setError(null);
    void refresh(controller.signal);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal); }, open ? 3000 : 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [identity, open, refresh]);

  useEffect(() => {
    if (!open || provider !== 'claude' || presentation === 'menu') return;
    let cancelled = false;
    void api.providers.models('claude').then((response) => response.json()).then((payload) => {
      if (!cancelled) setModels(payload.data?.models?.OPTIONS || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, provider, presentation]);

  if (provider !== 'claude' || !sessionId) return null;
  const current = snapshot?.sessionId === sessionId && (!executionId || snapshot.execution?.executionId === executionId) ? snapshot : null;
  const execution = current?.execution;
  const observed = execution?.observed;
  const next = current?.next;
  const selectedOption = models.find((option) => option.value === next?.model);
  const effortOptions = selectedOption?.effort?.values.filter((entry) => entry.value !== 'ultracode') || [];
  const differs = Boolean(next && execution && next.revision !== execution.requested.revision);
  const save = async (patch: Partial<ClaudeSessionSettings>) => {
    if (!next || mutation.current?.identity === identity) return;
    const sequence = ++requestSequence.current;
    const request = { identity, sequence };
    mutation.current = request;
    const isCurrent = () => identityRef.current === identity && mutation.current === request;
    setSaving(true);
    try {
      const response = await claudeExecutionSettingsApi.update(sessionId, { ...next, ...patch });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || 'Unable to save settings');
      if (isCurrent()) { acceptSnapshot(payload.data); setError(null); }
      window.dispatchEvent(new CustomEvent('claude-session-settings-updated', { detail: payload.data }));
    } catch (failure) { if (isCurrent()) setError(failure instanceof Error ? failure.message : 'Unable to save settings'); }
    finally {
      if (mutation.current === request) {
        mutation.current = null;
        // Invalidate reads begun before or during the write, including its response parsing.
        if (identityRef.current === identity) { requestSequence.current++; setSaving(false); }
      }
    }
  };

  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className={presentation === 'menu' ? 'px-2.5 pb-2 text-xs' : 'border-t border-border/50 px-3 py-1.5 text-xs'} data-testid="session-execution-settings">
    <summary className="cursor-pointer select-none break-words text-muted-foreground">
      {presentation === 'menu' ? '本次执行与下轮设置' : <>执行配置 · {observed?.model || '实际模型未确认'}</>}{differs ? ' · 下次启动有新设置' : ''}
    </summary>
    <div className="mt-2 min-w-0 space-y-2 break-words">
      <div className="break-all text-muted-foreground">当前机器上的会话：{sessionId}<br />Claude ID：{current?.providerSessionId || '尚未建立'}</div>
      {execution ? <>
        <div>最近执行（{execution.surface === 'chat' ? 'Chat' : 'Claude 终端'}）：<code className="break-all">{execution.executionId}</code> · {execution.status === 'running' && execution.isLive === false ? '运行状态未确认（历史记录）' : execution.status}</div>
        <div>启动时请求：{execution.requested.model} · {execution.requested.effort} · Ultracode {execution.requested.ultracode ? '开' : '关'}</div>
        {execution.permissionRequest && <div>启动权限：{execution.permissionRequest.mode}；请求允许/拒绝规则 {execution.permissionRequest.allowedRuleCount}/{execution.permissionRequest.deniedRuleCount}</div>}
        <div>实际权限模式：{observed?.permissionMode || '未确认'}</div>
        <div>实际报告：模型 {observed?.model || '未确认'}；effort {observed?.effort === null ? '未发送 effort 参数' : observed?.effort || '未确认'}；Ultracode {typeof observed?.ultracode === 'boolean' ? observed.ultracode ? '开' : '关' : '未确认'}</div>
      </> : <div className="text-muted-foreground">尚无此功能记录的执行；历史设置不作为实际生效证明。</div>}
      {next && presentation === 'menu' && <div>下次启动：{next.model} · {next.effort} · Ultracode {next.ultracode ? '开' : '关'}</div>}
      {next && presentation !== 'menu' && <fieldset disabled={saving} className="space-y-2">
        <legend className="font-medium">下次 Chat / Claude 终端启动</legend>
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-0 max-w-full items-center gap-1">模型 <select aria-label="Next execution model" className="min-w-0 max-w-full rounded border bg-background p-1" value={next.model} onChange={(event) => void save({ model: event.target.value })}>
            {!models.some((option) => option.value === next.model) && <option value={next.model}>{next.model}</option>}
            {models.map((option) => <option key={option.value} value={option.value}>{option.value === 'default' ? '跟随远端配置' : option.value}</option>)}
          </select></label>
          <label>Effort <select aria-label="Next execution effort" className="min-w-0 max-w-full rounded border bg-background p-1" value={next.effort} onChange={(event) => void save({ effort: event.target.value, ultracode: false })}>
            <option value="default">远端默认</option>
            {next.effort !== 'default' && !effortOptions.some((option) => option.value === next.effort) && <option value={next.effort}>{next.effort}（支持待确认）</option>}
            {effortOptions.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
          </select></label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={next.ultracode} onChange={(event) => void save({ ultracode: event.target.checked, ...(event.target.checked ? { effort: 'xhigh' } : {}) })} />Ultracode</label>
        </div>
      </fieldset>}
      <p className="text-muted-foreground">{surface === 'shell' ? '仅沿用已保存的权限；一次允许不会自动保留。已运行终端需重新启动才使用新设置。' : '设置用于下一轮 Chat；当前执行保持原配置。'} 终端内的 /model、/effort 是该进程的操作；实际报告以该次执行的观测为准。xhigh 本身不证明 Ultracode 已开启。</p>
      {error && <p role="alert" className="text-red-500">{presentation === 'menu' && !current ? '此远端暂时无法读取完整执行配置；上方仍显示可读取的模型记录。' : error}</p>}
    </div>
  </details>;
}
