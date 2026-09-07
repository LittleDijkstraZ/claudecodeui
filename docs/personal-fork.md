# Personal fork maintenance

Base: upstream `main` at `b6083e0`. Branch: `personal/cloudcli`.
Rebased on 2026-09-07, including upstream's frontend/backend module layout,
session editing and forking, lazy history projection, and shared chat writers.
The personal changes add incremental Claude output, conversation groups,
change review, side chats, rewind, a local multi-remote hub, usage accounting,
shared execution settings, and a retained right-hand workspace.

## Behavior to preserve

The Claude runtime enables partial SDK messages. Streamed text is deduplicated
against complete assistant messages by message and block identity; complete
messages can arrive before the SDK block-stop event. Thinking and tool events
retain their original ordering. Nested-agent partial text must not be appended
to the main assistant response.

The frontend keeps independent text and timer state for each session. Switching
the selected conversation does not clear another session's prefix or timer.
Stream end and run completion flush only their own session, and unmount clears
all timers.

Ultracode is a Claude setting, not a new Anthropic API effort value. The runtime
maps the menu selection to `settings.ultracode = true` and `effort = "xhigh"`.
An explicit ordinary selection overrides that setting to false for the request.
The user and project settings files are not rewritten.

Dynamic workflows can produce a result for the launch turn and another result
after completing in the background. Their task events must keep the request
alive until the workflow finishes and Claude delivers the follow-up result.
Permission denial, launch failure, cancellation, and multiple workflows need
their own coverage. Existing background Bash and monitor behavior is preserved.

## Conversation change review

The compact bar above the composer summarizes the latest user turn's recorded
file edits. Empty turns remain visible as empty; earlier edits are not presented
as changes from the current turn. The review dialog can select another turn or
all loaded conversation history. When older messages are missing, it offers the
existing history loader without closing the dialog.

Changes are grouped by file while retaining each successful recorded edit in
sequence. Repeated edits are not collapsed into an invented full-file or net
diff. Each entry links back to its original tool context in the conversation;
the dialog closes before that context is expanded and scrolled into view.

The summary only covers successful recorded file-tool operations. Pending,
failed, and denied operations are excluded. Arbitrary shell commands are not
interpreted to infer filesystem changes, and the panel is not a Git working-tree
snapshot. Recorded replacements may be fragments rather than complete files.
A write with unknown earlier content is shown as written content, without
assuming the file was previously empty.

Small before/after records reuse the existing diff viewer. Large inputs avoid
the quadratic diff calculator and show paged recorded content instead. File and
edit sections expand on demand; further content has explicit navigation controls.
Keep the panel keyed by session so selection and pending context jumps do not
leak into another conversation.

Extraction and display use messages already loaded in the browser. Loading
earlier messages uses the self-hosted server's existing history endpoint. This
summary adds no telemetry or third-party service connections and does not read
working files or run Git commands.

Browser checks also cover targets outside the initial rendered range, folded
main and subagent tools, repeated reveals, session switching, realtime result
arrival, an in-flight history request completing after a newer jump, and mobile
Chinese layout. The progress tab remains in normal layout flow so it cannot
overlap the changes bar.

## Claude side chats and rewind

Side chats use the Agent SDK's disk-only `forkSession` operation. A branch can
copy the whole saved main conversation or stop at one selected saved message.
It receives an independent provider session ID and can continue for multiple
turns. A branch at an explicit saved message can be opened while the parent
is still running; a whole-history branch without a fixed boundary requires the
parent to be idle. Its remote machine and project directory stay the same as its parent;
conversation branching does not isolate project files. Branch ancestry is
stored in `claude_session_branches`, outside the Claude transcript.

Rewind offers conversation-only, files-only, and combined modes. The boundary
is explicit: the selected user message is retained and later context is
removed. Conversation rewind creates an SDK fork through that message and
atomically remaps the existing stable app session to the shortened provider
transcript. Subsequent sends therefore use the shortened Claude context. The
previous complete conversation remains available as an archived recovery entry;
rewind does not hand-edit the provider's transcript or only hide UI messages.
Completed replay buffers are discarded and all connected windows receive a
context-reset revision so stale cached replies cannot reappear on reconnect.

Files-only rewind preserves conversation context. Native `rewindFiles` dry-run
results supply the affected-file preview; confirmation uses a short-lived token
bound to the signed-in user, message, mode, provider mapping, transcript, and
current file metadata. A changed source requires a new preview. A file restore
also excludes simultaneous CloudCLI runs in the same project, while unrelated
projects and machines remain usable. An active or background Claude session
must finish or stop before a rewind. External processes editing the same files
are outside this coordination mechanism.

Normal Claude runs enable native file checkpointing and replay user-message
UUIDs. Only changes captured by Claude's Write, Edit, and NotebookEdit tools
are in scope. Bash commands, experiment scripts, database operations, and most
subagent edits are not covered. Old conversations may have no usable native
checkpoint. SDK forks do not copy previous file-history snapshots: a side chat
or conversation rewind starts collecting its own checkpoints on future edits,
while a rewind recovery entry retains the old conversation's checkpoints.
Require Claude Code 2.1.216 or later for the native symlink/hard-link protections.
A real restore can still fail or skip files even when its dry-run succeeds;
the UI must report the returned failure instead of claiming full success.

Combined restore prepares the new transcript before restoring files, then
switches the app mapping only after successful file restoration. A failed file
restore keeps the old conversation context. A failed context commit after a
successful file restore reports that partial outcome. An unused prepared fork
is cleaned up with the SDK; a fork already adopted, grouped, or continued by
another caller is retained. Database migrations create the relationship table
after the existing session/project repairs and preserve group memberships on
the stable app session.

Reference behavior is documented in [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
[the TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript),
and [file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing).
Tests use injected SDK operations and fictional temporary data; the actual SDK
fork can also be checked against a temporary transcript without launching the
machine's installed Claude or sending a model question.

## Model version, context capacity, and reported model

Keep three separate choices: model version/alias, context capacity, and
reasoning effort. A `[1m]` suffix is a context-capacity variant, not a model
version. Preserve the exact wire ID when sending a selected version and offer
only capacity variants supplied by that remote's catalog. Never infer a new
variant simply by appending `[1m]` to an arbitrary model ID. Ultracode remains
the separate settings behavior described above.

The default option follows the owning remote's Claude configuration by omitting
the model override. Named aliases remain available alongside explicit model
IDs from remote settings, the configured remote API's models endpoint, and
metadata from an already requested SDK query. Catalog discovery does not start
an extra Claude conversation or send a test prompt. Requests use that remote's
configured endpoint and credential type; credentials, raw API errors, and
endpoint URLs do not enter the browser catalog. A catalog is informational,
not a guarantee that every listed model supports every account or request.

Display the selected model independently from the model actually reported in
the session. The latter comes from the latest non-synthetic main-thread
assistant response in its mapped transcript, with initialization metadata as
a clearly marked fallback. If neither is available, show unknown. Do not fill
an unknown report from a selected alias, guessed release number, or another
machine's session. Reported model, source, and timestamp help distinguish the
last observed response from a newly selected model that has not replied yet.

## Chat and Shell execution settings

One remote database session stores the next model, effort, and Ultracode choice.
Chat and the Claude terminal read that same configuration. Each launch freezes
its own execution record with the remote's stable app session, native Claude
session, project, configuration revision, and unique execution ID. A change
during a running request applies to the next launch, not retroactively to the
current process. An already open Claude terminal must be restarted to adopt
changed launch settings.

The configuration details distinguish requested settings, observations from the
actual process, and the next-launch choice. SDK settings observations and Shell
hooks record only approved configuration fields and identity, not tool contents
or prompts. A requested `xhigh` effort alone does not prove Ultracode enabled.
Unavailable observations stay unconfirmed; older execution history is not
invented. Unsupported combinations return an explicit error. Catalog discovery
never starts a new model question to check whether an option works.

The Shell launch validates the owning project, native session, and configuration
again after asynchronous preparation. Concurrent launches cannot claim the same
terminal/session twice. A missing native session or a failed resume is an error:
it must never silently fall back to a new Claude conversation. Shell commands
such as `/model` and `/effort` affect that terminal process; they do not prove
what a separate Chat execution used.

## Claude usage accounting

The compact composer number is the current main-thread context measurement,
not accumulated billing tokens. Its details separate current context, this
execution's turn, and the session's cumulative recorded consumption. Cache
reads, cache writes, uncached input, and output remain separate. Capacity comes
from observations of the owning session's actual model/configuration when
available; unknown capacity remains unknown. A large cumulative cache count,
such as 8M, must not be presented as an 8M current context.

A remote SQLite ledger persists execution results and request identities outside
the provider transcript. Complete SDK query totals are reconciled with streamed
usage; split assistant events and already covered subagent requests are not
counted twice. Request/model identities and execution coverage reconcile later
history imports with already settled query totals. Usage from child agents is
part of consumption, but never replaces the main thread's context measurement.
Each SDK query, including a resumed query, starts a new billing baseline.

Snapshot revisions and the stable/native session and execution identities guard
stream events and delayed history requests. The hub additionally isolates all
transport and browser state by machine. Refreshing or switching conversations
must not let an older request overwrite a newer measurement. Compact and rewind
may change the current context; they do not erase consumption already recorded
in the ledger. A fork's copied history is identified as inherited rather than
new usage caused by the branch.

Costs are estimates from reported SDK costs, with the reported pricing basis,
per-model breakdown, and coverage shown in details. Unknown prices are not
guessed from a model alias. Older transcripts, missing request identities, or
incomplete execution boundaries can limit historical coverage; partial data is
marked explicitly rather than presented as a complete invoice. No extra model
query or account-wide usage request is created to populate this display.

## Right-hand workspace and compact controls

Chat remains the main mounted view. Shell, Source Control, Files, Agents, and
side chats use one right-hand panel with resize, collapse, maximize, and restore
controls. On narrow containers it becomes an overlay. Opened terminal instances
retain their original machine, project, and session binding across navigation;
switching views or collapsing the panel does not destroy the terminal. Open side
chat frames also retain their state when switching branches or panel tabs.

Agents exposes each observed child task's name, status, elapsed time, action,
output, and result, with a link back to its initiating message/tool. Only a
compact status remains above the input. Agent information is derived from
provider events/history; a provider that supplies no child output cannot have
that output reconstructed by the UI.

The composer uses its actual container width, including when a right panel is
open. Controls wrap and the shortcut hint occupies its own row; long model IDs
truncate without hiding the menu. Group, Project, and Recent conversation rows
share running and attention indicators, including colors and tooltips. Live
activity takes precedence over late running-list snapshots. Group conversations
remain single-line, draggable, and retain their separate ellipsis menu.

## Local Remote Hub

The standalone hub presents multiple self-hosted remotes in one sidebar. It
serves the built frontend and forwards HTTP/WebSocket traffic only to configured
loopback SSH tunnel ports. Use the dedicated hub entry below, rather than the
ordinary application server entry on the Mac. The hub imports no provider
runtime, invokes no local Claude, and performs no project operations locally.
Each conversation stays on its owning remote; project files, native transcripts,
Claude credentials, model configuration, and execution remain there. No CloudCLI
Cloud account or third-party relay is involved.

Keep the existing SSH forwards running. For example, if each remote CloudCLI
server listens on its own `127.0.0.1:3001`, the Mac can forward them separately:

```sh
ssh -N -L 127.0.0.1:3001:127.0.0.1:3001 remote-a
ssh -N -L 127.0.0.1:3002:127.0.0.1:3001 remote-b
```

After building this checkout, save a local hub configuration with absolute paths:

```json
{
  "port": 3000,
  "dist": "/path/to/cloudcli/dist",
  "stateDirectory": "/path/to/cloudcli-hub/state",
  "remotes": [
    { "id": "machine-a", "name": "Machine A", "port": 3001 },
    { "id": "machine-b", "name": "Machine B", "port": 3002 }
  ]
}
```

Launch from the checkout, then open `http://127.0.0.1:3000`:

```sh
node dist-server/server/remote-hub.js /path/to/cloudcli-hub/hub.json
```

Sign in once to each machine within the hub using its existing remote CloudCLI
account; a login previously saved at port 3001 or 3002 is a different browser
origin. Tokens, drafts, and model choices are scoped by machine. Reauthentication
may be needed when a token expires. The conversation header identifies the
machine and folder. New conversation asks for machine, then an existing remote
project folder, and remembers the last selection. A disconnected machine is
marked offline while the other connections continue independently.

Cross-machine groups are hub metadata in `stateDirectory/groups.json`, including
member IDs, titles, and folder labels. Back up that file to retain grouping.
Each remote user's existing groups are imported once; subsequent hub organization
is independent of the remote-only SQLite groups. Saves use revision checks and
atomic replacement; other open hub windows refresh shared group changes. A
member is identified by both machine ID and session ID, so equal IDs on two
machines do not collide. Removing a group retains every remote conversation.
The group menu can open the entire group in a separate focused window.

The hub observes remote session activity without taking over the conversation's
stream. Its bell lists live completion, error, and permission-needed events while
the hub is open, tagged with the owning machine. The list is an in-memory recent
notification view, not a durable inbox or an OS notification service. Projects,
recent conversations, and running-state metadata also refresh periodically and
when the window regains focus.

## Mermaid inspection

Both chat diagrams and Markdown file previews reuse the existing strict Mermaid
renderer. Click a rendered diagram to open its viewer. Use the zoom buttons or
wheel, drag to pan, pinch on touchscreens, fit-to-window, and 100% reset. The
fullscreen control requests browser fullscreen and also supports an expanded
viewport when the browser cannot grant it. Keyboard controls include `+`/`-`
for zoom, `0` for 100%, `F` to fit, and arrow keys to pan the focused diagram.
Close with the close button or `Escape`; focus returns to the original diagram.
The viewer inspects the existing SVG locally. Invalid or incomplete Mermaid
continues to show the source block rather than a blank diagram.

## Checks

Use the locked dependencies with `npm ci`. Relevant regression tests live under
`server/modules/providers/tests/`, `server/modules/conversation-groups/tests/`,
`server/modules/database/tests/`, `server/modules/websocket/tests/`,
`server/modules/claude-session-actions/tests/`, `server/modules/remote-hub/tests/`,
`server/modules/claude-usage/tests/`, `src/modules/sidebar/tests/`,
`src/modules/chat/tests/`, `src/modules/remote-hub/tests/`,
`src/modules/project-workspace/tests/`, `src/modules/workspace-panels/tests/`,
`src/modules/session-configuration/tests/`, and `src/shared/tests/`.

```sh
npm test
npm run test:client
npm run build
npm run typecheck
npm run lint
```

For local backend tests, point `CLAUDE_CONFIG_DIR` at an empty fixture directory
and keep real Anthropic authentication variables out of the test environment.
Model-catalog tests inject settings and HTTP responses. Hub integration tests use
two temporary loopback HTTP/WebSocket fixtures, not live SSH connections.
The regression tests use simulated SDK events and do not send paid model
requests. A successful build or mocked test is not an end-to-end test of a live
Ultracode workflow with a particular model/account.

Run these checks after changing the source. Compare repository-wide lint output
against the upstream baseline; the frontend build can also report existing CSS
and large-chunk warnings. Neither warning counts nor previous successful runs
replace validation of the current revision.

## Conversation groups

Groups are organization metadata, independent of a conversation's provider and
working directory. The existing Projects and Conversations views remain
available. Each signed-in user can put a stable app session in one group; another
user's organization choices are independent. Group names and membership are
stored in the same SQLite database as authentication. They are never written to
provider transcripts or sent to a separate group-sync service.

The database creates `conversation_groups` and `conversation_group_memberships`
after legacy session/project migrations. Back up the existing database before
upgrading a working installation. Use the same `DATABASE_PATH` after upgrading
to retain accounts, groups, project metadata, and session mappings. Deleting a
group removes its memberships only; deleting a session cleans up memberships.
Provider-native duplicate rows transfer their memberships before being merged
into the stable app session, preserving that app session's choice on conflicts.

The Groups view has independently expandable sections. Group header menus offer
new conversation, pin/unpin, rename, and a final red delete action. Conversations
use one-line rows with folder details in a tooltip and a separate membership
menu. Drag the row (or its provider icon on touch devices) to reorder within a
group; the menu's move-up/down actions provide a keyboard alternative. Moving
between groups uses the membership menu.

Pin state and manual member order are stored per user in SQLite. The first
upgrade seeds existing groups from their previous recency order only once.
New or moved-in conversations append; later activity cannot reshuffle the list.
Reordering sends a source and relative anchor, so search-hidden or unloaded
members retain their order. Provider-row merges preserve member position.
Only expanded groups fetch member pages. Search temporarily opens all groups
and restores the ordinary expansion state when cleared. Failed order saves
keep the displayed order and offer an explicit retry.

Group browsing queries the database with pagination instead of filtering the
sidebar's partially loaded project lists. Archived members remain visible with
an archive label. Search covers title, project path/name, provider, and session
ID. In-flight results cannot replace a newly selected group/search, and metadata
refreshes preserve the number of already loaded pages. Membership refreshes on
window focus, visible-page polling, and session metadata events.

Creating a conversation in a group validates an existing registered project
directory and atomically allocates a stable app session and membership. It does
not start a provider run. A pristine draft has no custom title; its first accepted
send names it, unless the user already renamed it. OpenCode histories are joined
only by the provider ID announced by the runtime, not by guessing a pending
draft from its folder. Opening a member whose project is not loaded resolves its
own project before displaying the working directory.

Browser validation uses the built application with fictional projects, mocked
authenticated HTTP endpoints, and a mocked WebSocket. It covers cross-folder
membership, more than one page, archived members, search, create/rename/delete,
moving via the recent-conversation menu, folder selection, first-send stable ID,
unloaded-project navigation, reload persistence, mobile assignment/cancel, and
Chinese labels. These checks do not invoke
the machine's installed Claude or verify a production deployment.

When updating upstream, review the provider's SDK event protocol and frontend
realtime handlers together. Test the rebuilt application before replacing a
working remote service. Retain a separate previous installation for rollback.

### Claude token and cost accounting

The composer counter shows the **current context**, using the last main-model sampling iteration or the existing Claude process's local `getContextUsage({ detail: 'summary' })` estimate. A large cumulative bill (for example 8M tokens across repeated cached prompts) is never substituted for the context window. The observed model capacity and the compaction policy window are separate fields; an alias or `1m` selection does not prove actual capacity. Missing observations remain unknown.

Click the counter to compare current context, the current/latest **user-started execution**, and cumulative conversation consumption. A user-started execution includes its Workflow follow-up results and subagents. Uncached input, cache reads, cache writes, output and per-model estimated costs are separate; thinking is already part of output. SDK prices are estimates, not invoices. Explicit `costBasis: unknown` is never displayed as a confirmed price; an absent basis follows the SDK's older-build contract of list pricing.

The remote database persists only numerical counters and public/opaque model, request, session and execution identifiers. API request IDs deduplicate streamed blocks; cumulative SDK `modelUsage` is differenced within one query and resets for a new/resumed query. Result totals replace overlapping provisional observations. Completed query coverage also deduplicates subagent requests that were not forwarded live but appear later in transcript files. Classification uses request timestamps, not file modification times. Records with uncertain overlap are excluded from extra charges and visibly labeled partial.

REST, history pages and live events use the same versioned snapshot with a durable per-session revision. Each remote pane keeps its own session cache; stale or mismatched snapshots cannot replace newer counters. Compaction and rewind change context without erasing prior spend. A fork inherits its prefix without charging that copied context again. Available old rewind backups and subagent logs contribute to historical request recovery, while missing internal calls and historical prices remain explicitly unknown. A stopped process preserves its observed partial spend.

No discovery question, extra model session, token-count API call or account-wide `getUsage()` request is used for these statistics. The summary query operates only on an already user-started Claude process. Accounting cannot reconstruct an invoice or recover usage that Claude never recorded/reported.
