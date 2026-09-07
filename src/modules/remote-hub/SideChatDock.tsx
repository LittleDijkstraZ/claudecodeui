import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, X } from 'lucide-react';

import { Button } from '@/shared/ui';
type Branch = {
  sessionId: string;
  parentSessionId: string;
  sessionName?: string;
};
/** Used by the project workspace to give a branch its own streaming and composer state. */
export default function SideChatDock() {
  // Retains the branch navigation stack while its independent app displays the discussion.
  const [branches, setBranches] = useState<Branch[]>([]);
  const branch = branches.at(-1);
  const frame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<Branch>).detail;
      if (!detail || typeof detail.sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(detail.sessionId)) return;
      if (window.__CLOUDCLI_SIDE_CHAT__ && window.parent !== window) {
        window.parent.postMessage({
          kind: 'cloudcli:side-chat-open',
          detail
        }, location.origin);
      } else setBranches([detail]);
    };
    const forwarded = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === frame.current?.contentWindow && event.data?.kind === 'cloudcli:side-chat-open') setBranches(current => [...current, event.data.detail]);
    };
    window.addEventListener('cloudcli:side-chat-open', open);
    window.addEventListener('message', forwarded);
    return () => {
      window.removeEventListener('cloudcli:side-chat-open', open);
      window.removeEventListener('message', forwarded);
    };
  }, []);
  if (!branch) return null;
  const url = `${window.__REMOTE_BASE__ ?? ''}/session/${encodeURIComponent(branch.sessionId)}?embedded=1&sideChat=1`;
  return <aside className="absolute inset-0 z-40 flex flex-col border-l border-border bg-background shadow-xl md:relative md:w-[46%] md:min-w-[360px]" aria-label="旁支讨论">
    <div className="flex items-center gap-2 border-b border-border px-3 py-2"><Button variant="ghost" size="icon" aria-label={branches.length > 1 ? "回到上个旁支" : "回到主对话"} onClick={() => setBranches(current => current.slice(0, -1))}><ArrowLeft className="h-4 w-4" /></Button><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{branch.sessionName || '旁支讨论'}</div><p className="text-[10px] text-muted-foreground">独立对话上下文 · 与主对话共用远端文件夹</p></div><Button variant="ghost" size="icon" aria-label="在新窗口打开旁支" onClick={() => window.open(`${window.__REMOTE_BASE__ ?? ''}/session/${encodeURIComponent(branch.sessionId)}`, '_blank', 'noopener')}><ExternalLink className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" aria-label="关闭旁支面板" onClick={() => setBranches([])}><X className="h-4 w-4" /></Button></div>
    <iframe name="cloudcli-side-chat" ref={frame} key={branch.sessionId} src={url} title="旁支讨论" className="min-h-0 w-full flex-1 border-0" allow="clipboard-read; clipboard-write; fullscreen" />
  </aside>;
}
