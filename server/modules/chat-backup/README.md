# Portable chat backups

Authenticated remote-server endpoints:

- `GET /api/chat-backups/sessions/:sessionId` returns `{ success: true, data: ChatBackupBundle }`.
- `POST /api/chat-backups/restore` takes `{ bundle, projectPath }` and returns `{ success: true, data: { sessionId, provider, projectPath, sessionName } }`.

Version 1 supports Claude and Codex native saved conversations. It keeps the title,
model, effort and native conversation context. Restore creates independent native
and app session IDs in the selected existing directory. Claude's SDK remaps message
UUIDs and parent chains. Codex's CLI forks the rollout in isolated temporary storage.
Neither operation starts a model turn or imports account settings or credentials.

The portable bundle contains `main.jsonl` and, for current Claude storage layouts,
session-owned `subagents/` and `tool-results/` text sidecars. Subagent IDs stay stable
so the history reader can find their copied transcripts below the new session ID.
This is a conversation backup, not a workspace or machine backup: source files,
external attachments, installed tools, live processes, file undo snapshots and
absolute file paths mentioned in historical messages are not relocated. Legacy
Claude subagent files stored beside several sessions are not copied. Cursor and
OpenCode's database-backed histories are not currently portable through these APIs.

The standalone Remote Hub does not load this module. Its separately disabled-by-
default local backup store holds bundles delivered over the existing authenticated
remote connection. Disabling local sync does not remove already saved backups.

Bundles are bounded to 64 MB including JSON encoding and 512 safe relative files.
Export rejects changed, corrupt, missing and unsupported native history. Restore
validates context before provider operations, publishes to fresh names exclusively,
and cleans temporary storage. It preserves existing destination project identity
and applies normal workspace-path validation when registering a new project folder.
