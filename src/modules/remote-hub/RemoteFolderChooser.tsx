import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Eye, Folder, Home, Loader2, X } from 'lucide-react';

import { hubApi } from '@/shared/api';
import type { HubDirectoryListing, HubProject } from '@/shared/types';
import { Button, Input } from '@/shared/ui';

/** Used by the Hub new-conversation dialog to browse only the chosen remote's existing folders. */
export function RemoteFolderChooser({ remoteId, remoteName, projects, path, onChange, disabled, online }: {
  remoteId: string;
  remoteName: string;
  projects: HubProject[];
  path: string;
  onChange: (path: string) => void;
  disabled: boolean;
  online: boolean;
}) {
  // Keep an explicitly opened directory listing separate from the editable destination path.
  const [listing, setListing] = useState<HubDirectoryListing | null>(null);
  // Directory requests may be slow across a tunnel; cancelled results cannot change the chosen folder.
  const [loading, setLoading] = useState(false);
  // Filesystem or connection errors are shown beside the machine-bound folder picker.
  const [error, setError] = useState('');
  // Hidden directories remain accessible without overwhelming the usual folder list.
  const [showHidden, setShowHidden] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const unavailable = disabled || !online || !remoteId;

  useEffect(() => () => { requestRef.current?.abort(); }, [remoteId, online]);

  const browse = async (requestedPath: string) => {
    if (unavailable) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await hubApi.browseDirectories(remoteId, requestedPath.trim() || '~', { signal: controller.signal });
      if (!controller.signal.aborted) { setListing(result); onChange(result.path); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '无法浏览此远端文件夹');
    } finally { if (requestRef.current === controller) setLoading(false); }
  };
  const editPath = (next: string) => {
    requestRef.current?.abort();
    setLoading(false);
    setError('');
    setListing(null);
    onChange(next);
  };
  const folders = listing?.suggestions.filter(folder => showHidden || !folder.name.startsWith('.')) ?? [];
  const projectId = projects.find(project => project.fullPath === path)?.projectId ?? '';

  return <fieldset disabled={unavailable} className="min-w-0 space-y-2" aria-label={`${remoteName} 的文件夹`}>
    <label className="block text-sm">项目文件夹
      <div className="mt-1 flex gap-2">
        <Input aria-label="远端文件夹路径" value={path} onChange={event => editPath(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void browse(path); }
        }} placeholder="/srv/project 或 ~/project" required maxLength={4096} className="min-w-0 flex-1 font-mono text-xs" />
        <Button type="button" variant="outline" onClick={() => void browse(path)} disabled={unavailable || loading} className="shrink-0">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Folder className="h-4 w-4" />}浏览</Button>
      </div>
    </label>
    <p className="text-[11px] text-muted-foreground">{remoteName} 上的文件夹 · 创建前会检查此远端路径。</p>
    {projects.length > 0 && <select aria-label="已有项目" value={projectId} onChange={event => {
      const project = projects.find(item => item.projectId === event.target.value);
      if (project) editPath(project.fullPath);
    }} className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs">
      <option value="">也可选择已有项目…</option>
      {projects.map(project => <option key={project.projectId} value={project.projectId}>{project.displayName} — {project.fullPath}</option>)}
    </select>}
    {(listing || loading) && <div className="overflow-hidden rounded-lg border border-border" data-testid="remote-folder-browser">
      <div className="flex items-center gap-1 border-b border-border bg-muted/30 p-1">
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="远端工作区根目录" title="远端工作区根目录" onClick={() => void browse('~')} disabled={unavailable || loading}><Home className="h-3.5 w-3.5" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="上一级文件夹" title="上一级文件夹" onClick={() => void browse(`${listing?.path}/..`)} disabled={unavailable || loading || !listing}><ArrowUp className="h-3.5 w-3.5" /></Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={listing?.path}>{listing?.path || '正在读取…'}</span>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="显示隐藏文件夹" title="显示隐藏文件夹" aria-pressed={showHidden} onClick={() => setShowHidden(value => !value)}><Eye className="h-3.5 w-3.5" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="收起文件夹浏览" onClick={() => { requestRef.current?.abort(); setLoading(false); setListing(null); }}><X className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="max-h-40 overflow-y-auto p-1">
        {loading ? <p role="status" className="p-3 text-xs text-muted-foreground">正在读取 {remoteName} 的文件夹…</p> : folders.length ? folders.map(folder => <button type="button" key={folder.path} onClick={() => void browse(folder.path)} className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent" title={folder.path}>
          <Folder className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{folder.name}</span>
        </button>) : <p className="p-3 text-xs text-muted-foreground">此文件夹内没有可显示的子文件夹。</p>}
      </div>
    </div>}
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
  </fieldset>;
}
