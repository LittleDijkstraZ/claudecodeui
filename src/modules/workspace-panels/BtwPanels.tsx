import { useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';

import { askClaudeBtw } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { WorkspaceBtwTab } from '@/shared/types';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels/context/WorkspacePanelsContext';

function BtwPanel({ tab, visible }: { tab: WorkspaceBtwTab; visible: boolean }) {
  const { t } = useTranslation('common');
  const actions = useWorkspacePanelActions();
  // Each mounted tab retains its own draft until explicitly closed.
  const [question, setQuestion] = useState('');
  // Keep the submitted question beside its answer, independently of later navigation.
  const [result, setResult] = useState<{ question: string; answer?: string; error?: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  const submit = async () => {
    const text = question.trim();
    if (!text || pending.current || result?.answer) return;
    const controller = new AbortController(); pending.current = controller;
    setResult({ question: text });
    actions?.renameBtw(tab.id, `BTW · ${text.replace(/\s+/g, ' ').slice(0, 36)}`);
    try {
      const { answer } = await askClaudeBtw(tab.sessionId, text, controller.signal);
      if (!controller.signal.aborted) setResult({ question: text, answer });
    } catch (error) {
      if (!controller.signal.aborted) setResult({ question: text, error: error instanceof Error ? error.message : String(error) });
    } finally { if (pending.current === controller) pending.current = null; }
  };
  const loading = Boolean(result && !result.answer && !result.error);
  return <section hidden={!visible} className={`h-full min-h-0 flex-col ${visible ? 'flex' : 'hidden'}`} aria-label={tab.label}>
    <div className="shrink-0 border-b border-border px-4 py-3">
      <p className="truncate text-xs font-medium" title={tab.sourceLabel}>{tab.sourceLabel}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('btw.description')}</p>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
      {!result && <p className="text-sm text-muted-foreground">{t('btw.empty')}</p>}
      {result && <p className="mb-5 whitespace-pre-wrap break-words rounded-xl bg-accent px-4 py-3 text-sm">{result.question}</p>}
      {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('btw.thinking')}</p>}
      {result?.answer && <div className="prose prose-sm max-w-none break-words dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{result.answer}</ReactMarkdown></div>}
      {result?.error && <p role="alert" className="text-sm text-destructive">{result.error}</p>}
    </div>
    {!result?.answer && <form className="flex shrink-0 items-end gap-2 border-t border-border p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea aria-label={t('btw.question')} placeholder={t('btw.placeholder')} value={question} onChange={event => setQuestion(event.target.value)} maxLength={16000} disabled={loading} rows={3}
        className="min-w-0 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
      <Button type="submit" size="icon" disabled={!question.trim() || loading} aria-label={t('btw.send')}><Send className="h-4 w-4" /></Button>
    </form>}
  </section>;
}

/** Used by project-workspace to retain independent, disposable native /btw answers across navigation. */
export function BtwPanels() {
  const panel = useWorkspacePanels();
  return <>{panel?.btwTabs.map(tab => <BtwPanel key={tab.id} tab={tab} visible={panel.open && panel.tab === tab.id} />)}</>;
}
