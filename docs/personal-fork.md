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
their own coverage. Foreground reply completion is distinct from native-process
completion: background work does not disable the composer. A single pushable
SDK input stream owns the process, preserves FIFO ordering through attachment
preparation, and accepts follow-up messages without stopping or replacing it.
Client UUIDs deduplicate retries; only a native replay or correlated reply
confirms delivery. Unconfirmed input stays visible across stream replay.
Explicit task lifetimes have no UI silence timeout. Settings changed while this
process is running apply when the next execution starts, not to appended input.

Explicit Claude sends and manual retries are admitted by the remote runtime,
not rejected solely by a stale browser loading flag or a missed capability
snapshot. Rejected inputs include the current ownership/capability snapshot;
failed interrupts never mark a still-running query complete. A confirmed stop
retains ownership until the query exits, and release of a starting reservation
is scoped to its own execution so the next send cannot lose its reservation.
Polling uses the client clock for idle-response guards; remote timestamps must
not keep a restarted session artificially busy. Partial capabilities are retained
only when a snapshot identifies the same execution.

Regular follow-up sends and retries use native input priority `later`: Claude
finishes its current foreground reply before processing the queued message.
Interrupt and send requires a nonempty draft (or attachment) and an existing
execution advertising that capability. It submits one native `now` message to
the same query; it does not abort the query, clear its queue, restart Claude,
or cancel background Workflows. Reusing a message UUID with a different mode
is a conflict. Unknown/closed input streams retain the draft and report refusal;
editing or rewinding a previous message cannot use this action. Structured
native interruption results receive a concise interrupted status, while actual
provider errors remain visible. Queue admission is still not proof of delivery.

A manual retry links the retained unconfirmed copy to its new send UUID. Repeated
clicks cannot create additional copies from that source, including after refresh;
if the new send fails, retry is offered on that new copy. Retrying preserves
another draft, its edit anchor and the original attachment references. Preparation
failures before creating a new copy leave the retry available. Nothing is resent
automatically.

Live subagent text is forwarded and remains scoped to its parent tool. Optional
settings/context control requests never block transcript streaming; delayed
responses are checked against the owning query and its stream generation.
Native terminal transcript writes refresh Chat while the runtime is active.
That catch-up follows saved history (one-second filesystem polling plus debounce),
not a second model call or a guarantee of token-by-token terminal mirroring.

When several user inputs share one native execution, the usage panel labels that
execution's aggregate and message count. It does not invent per-prompt billing
for background work or batched native results. Session totals remain cumulative.

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

### Unified-window regression fixes

Conversation menus in every Hub view include fork, rename and a final red delete
entry. Forks use the owning remote and inherit the source group. Deletion defaults
to recoverable archive; permanent transcript deletion is an explicit option.
Whole-conversation fork and delete stay visible but disabled while a run is active.
A failed local group save retries the completed remote result rather than forking
a second time.

The green dot means an unread reply or attention event, never merely recent
activity. A yellow spinner independently indicates a running session. Read state
is scoped to machine and session, survives reconnects in the Hub, and clears only
when that conversation is visible. Background machine frames and chat covered by
a maximized panel do not consume unread state. Metadata-only renames do not make
a conversation unread; older metadata events without message watermarks cannot
reliably announce an external CLI reply.

Embedded remotes supply their actual enabled navigation to the Hub's single
header. Older remotes retain their own navigation until upgraded. Model selection,
reported identity and next-execution details share the composer model menu. Small
changes and Agents controls replace permanent informational bars; shortcut hints
live in a tooltip. Retained terminal and side-chat lifetimes are unchanged.

Chat's explicitly saved allow/deny rules and permission mode are carried into the
native Claude terminal on its next launch. A one-time approval is not converted
into a saved broad grant, and the CLI may still ask its separate outside-working-
directory question. Ultracode requests both xhigh effort and its independent CLI
settings; `/effort` alone confirms neither that switch nor an earlier Chat run.
The execution details distinguish requested values from observations.

When a new client receives old Claude usage payloads it labels them as legacy,
not validated context or cumulative consumption. A still-running older remote
serves its own older frontend too; updating only the Mac Hub cannot activate the
new remote runtime or statistics. Updates must wait for that remote's active
work to finish.

## Remote folder creation

The hub's new-conversation dialog chooses a machine first, then lets the user
browse or type a path on that remote. The remote validates and canonicalizes the
folder before registration and conversation creation; existing workspace-root
restrictions still apply. Each machine remembers its last folder independently.
Changing machines invalidates in-flight directory results. A group-attachment
retry reuses the already-created conversation instead of creating duplicates.
The Mac hub performs no project operations and never executes local Claude.

## Embedded settings and unconfirmed input

Full settings are mounted once at the workspace layer, independently of the
project sidebar, active tool panel, or selected project. The settings title
uses the remote identity injected into that frame. Hub requests are addressed
to one frame and held until that frame is ready; changing the selected remote
does not retarget an already-open settings page.

Unconfirmed user messages are protected from the bounded realtime output cache.
A local pending-message copy is separate from the native transcript and never
automatically resubmitted. Each copy has an independent browser-storage key
scoped by remote, login identity, session and message UUID; native-history
confirmation removes it. Removing a local copy does not cancel remote work.
The legacy single-message queue cannot overwrite an
existing pending message with a second send. Launch preparation failures and
completed-run subscriptions retain message-specific delivery outcomes instead
of leaving optimistic prompts permanently waiting.

The compact change-review button reports added and removed lines from successful
recorded edits for its selected scope. These are per-edit totals, not a Git net
diff; missing baselines and ambiguous repeated replacements remain explicitly
unquantified. Pending or failed tool edits do not inflate the badge.


## Native Claude commands in Chat

The slash menu separates CloudCLI controls from Claude commands. `/compact [focus instructions]`, `/context`, and `/usage` are offered as documented SDK defaults before any command metadata has been observed. Once a normal user-started query reports its command surface, the menu uses that app session, native session, and project’s reported list, including dynamic command updates. Discovery reads only the existing query’s `supportedCommands()` and `system/init` / `commands_changed` messages; it never launches a discovery session or sends a test prompt. User/project skills continue to appear alongside the native commands; duplicate names keep the existing UI/skill choice.

Selecting a native command fills the composer. Sending uses the ordinary session-bound input/receipt path: a running Workflow keeps its original query and receives the command through that query’s input stream; an idle conversation resumes its recorded native session. `/compact` cannot allocate an empty conversation, and it never truncates UI messages to simulate compaction. Only a native `compact_boundary` reports that context was actually compacted. A successful result without a boundary may instead explain that there are too few messages; UUID-correlated command output preserves that explanation. Compaction consumes model resources when Claude needs to summarize, and accumulated token/cost accounting is retained.

Commands which switch/reset the native conversation (`/clear`, `/reset`, `/resume`, `/fork`, `/rewind`) are not supported through Chat’s raw command path; use New Conversation, the sidebar, Side chat, or Rewind instead. Terminal lifecycle/display commands such as `/exit`, `/login`, and `/theme` show a specific explanation rather than silently modifying the Chat runtime. Existing CloudCLI `/help`, model, cost and settings controls remain available. An unreported command is not advertised as universally supported; the remote Claude process remains authoritative for typed commands and skill availability.

Reference: [Claude SDK command discovery and compaction](https://code.claude.com/docs/en/agent-sdk/slash-commands).


## Adjustable workspace sides

Chat remains the main workspace and has no tool tab. Shell, Files, Source Control,
Agents and enabled plugins are selected inside the right panel, with large hit
targets, hover labels and a More menu when space is limited. Clicking the active
tool again collapses the panel without unmounting it. There is no second toolbar
above Chat: one compact row holds session/machine identity and a direct machine
settings gear. The right-panel toggle stays at the upper-right corner, aligned
with the left sidebar toggle. The browser's own window title bar is unchanged.

Settings → Appearance switches between icons (the default) and icons with text.
This is a browser-wide preference shared across remote frames; credentials,
drafts and model settings remain scoped to their remote. Light mode uses white
main/right surfaces and a light-gray left sidebar; dark mode and semantic status
colors retain their existing meanings.

The left sidebar can collapse and be resized by pointer or keyboard, with its
preferred width preserved across narrow windows and reloads. Conversation and
group hit targets include their full row height; drag handles and menus retain
separate actions.

In the multi-remote hub, drag a group heading with the mouse or use its grip to
reorder whole groups. Pinned and ordinary groups keep separate ordering; dragging
does not change pin status. The grip supports Up/Down keys, and the group menu
also provides move actions. The ordered group array is saved by the local hub and
broadcast to other windows. A conflicting save reapplies the move against the
latest revision, preserving concurrent edits and group contents. The detached
single-group view hides sorting controls. Existing conversation dragging is unchanged.

The upper-right control opens the retained workspace panel. The panel contains
its selected tool, a compact tool heading and size controls. Closing, resizing
or maximizing it does not replace its remote frame or running terminal. Shared modal coverage hides
outer handles and preserves unread state while token statistics, change review
or settings covers the conversation.

## Continued history branches

Native compaction summaries retain their explicit classification for both string
and content-block records, including metadata-marked summaries. The transcript
shows them as a collapsed continuation-context disclosure, without a human
avatar, send status, edit, retry, or fork controls. Opening the disclosure or
exporting retains the complete summary. Genuine user messages quoting the same
words remain ordinary user messages; classification never relies on prose.

History projection follows the latest verifiable main user prompt ancestry when a conversation continues an earlier edited branch. Late assistant, tool, synthetic or sidechain records alone do not reactivate an abandoned prompt. Normal prompt replacement and parallel tool output remain supported; the native transcript, resume anchor and cumulative usage records are never rewritten by this display repair.

History pages select their main-transcript range before reading child Agent logs.
Only Agent rows on that page are enriched, with bounded parallel reads. Child
progress updates refresh that enrichment without reparsing the unchanged parent
transcript. Branch projection still uses the complete main transcript, and full
history/usage recovery retains its complete scope. Cache identity includes file
replacement metadata, so equal-sized replacements with preserved modification
time cannot silently reuse stale history.


## Delivery, task review, and remote authorization

User sends carry a stable client UUID. Native replay receipts and verified transcript ancestry associate the UI copy with its recorded message; identical text is never a deduplication key. Admission means queued, while a correlated native receipt means delivered. Process exit, failed preparation, and reconnect without a live execution settle unconfirmed sends as unconfirmed, with an explicit manual retry. No automatic retry starts another query or stops background work. The outbox retains attachments and original branch identity; removing a browser copy does not delete native history.

Claude history keeps the native transcript's append order after branch filtering.
A queued prompt's creation time can precede the answer it follows, so timestamps
remain display metadata rather than a reason to reorder history or reject an
older page. Live rows use observed row order and exact saved identities.

Claude streaming text carries its API response and global content-block identity.
When an authoritative SDK text row uniquely corresponds to a completed streamed
block, the native row replaces the temporary copy; later history hydration can
then match its native UUID. A saved record's local array position is never assumed
to be a global stream index. Uncertain live output retains observed neighbors
instead of moving behind later user prompts. Replayed text frames are scoped to
their run and sequence, without treating status snapshots as text acknowledgements.
Older servers without stream identities retain the existing scoped compatibility
path; upgrading the remote backend is required for the new identity bridge.

Reloaded browser copies whose native position is not present in the loaded page
appear in a separate, collapsed retained-copies section. They do not reorder
the latest page, consume its visible-row budget, or create Review turn boundaries.
Loading a matching older page retires the copy by exact identity; loading the
entire conversation is not required to show the latest messages correctly.
Unmatched copies keep their original text, delivery state and manual actions;
this display repair never resends them or rewrites Claude's transcript.

While the viewport is at the bottom, it follows streaming text within an existing
message and delayed Markdown layout changes. Scrolling up pauses that follow;
returning to the bottom or using the down-arrow button resumes it. Loading older
history, jumping to a search result or edit, and switching away retain their own
scroll position instead of being pulled to the latest output.

Rewind previews its target and effects on background work, queued drafts, and scheduled messages. The original native branch remains available. The commit transaction isolates old queued/scheduled work on that branch, and late saves or already-claimed dispatchers cannot silently feed it into the new branch. Active execution conflicts are reported rather than stopped automatically. File recovery still covers only recorded native checkpoints, not arbitrary shell, database, or external side effects.

The Agents panel includes Workflows, with recorded task IDs, progress, final results, duration where known, and a link to the originating tool call. An old launch receipt is not proof a task is still running; unverified state is explicit. Inspecting a task does not issue resume or stop commands. Only foreground generation drives the main composer timer.

The runtime background-task count and the detail cards have different sources:
the count is reported by the running execution, while cards require recorded
task identities in loaded history. If the count is positive but no cards are
available, the panel explains that details are missing and offers a prominent
read-only older-page loader when more history exists. It does not manufacture
task identities from the count, claim an empty panel means no running work,
or automatically fetch the entire transcript. When no older page is available,
the message explicitly says the current records do not provide task details.

Review merges tool snapshots and successful receipts without discarding known Write metadata. Failed, queued, or duplicate optimistic bubbles cannot invent new turn boundaries. A successful file remains listed even if its line count cannot be established; missing baselines are not guessed. Added/removed badges are per-edit totals in the selected scope, not repository-wide Git totals.

Session identity details separate CloudCLI's preserved name, Claude's automatic title, native `/rename` title, and app/native execution IDs. A retained terminal reports its original branch binding. Chat refusal due to an occupied terminal offers the existing terminal when available; that action never starts a second Claude process.

Remote MCP Connect runs the remote CLI's no-browser login in the selected project. The local hub temporarily accepts the exact loopback callback URL/state supplied by that attempt and forwards it to the same authenticated remote attempt over the configured SSH tunnel. Manual full-URL paste and timeout retry remain available. A successful browser redirect alone is insufficient: the remote CLI's configured MCP health must report Connected. Managed or ambiguous configuration has an explicit terminal fallback. Existing independent terminal logins are not hijacked. Reference: [Claude command-line MCP authentication](https://code.claude.com/docs/en/mcp#authenticate-from-the-command-line).

Plugin installation offers Open plugin. Enabled entries share the right panel's tool navigation and More overflow; inventory and asset failures are visible with retry, and the last successful inventory is retained on transient errors. Machine changes invalidate stale requests, so one remote's response cannot replace another remote's plugins.

Plugin UI now mounts in its own same-origin document, preserving the selected remote’s HTTP/WebSocket routing and scoped storage while isolating accidental document/CSS changes from CloudCLI. This is a compatibility boundary for trusted installed plugins, not a security sandbox. Invalid optional manifest metadata (including object-valued authors) cannot crash Settings. A failed mount, missing entry, or stalled load retains host-owned error and retry controls; changed entry artifacts reload even when a plugin keeps its version number. Updates build and validate in hidden staging before promotion. Staged git/build/manifest failures retain the previous installed files and restart its prior backend. If the new backend fails readiness after promotion, the new plugin remains installed with a warning and retry controls; this is not an automatic rollback. Plugin sockets buffer bounded startup input and route through the selected SSH tunnel.

The authenticated plugin loader still requires a built, self-contained single-file browser bundle. Relative module imports and sibling resources resolved through `import.meta.url` are not supported; these failures show a build compatibility hint and recovery controls. CloudCLI does not drop asset authentication or put account JWTs into plugin asset URLs to work around this boundary. Individual third-party plugins may still need their own build/runtime fixes.


### Ephemeral BTW tabs

The workspace tab strip ends with an extensible add menu (currently **New BTW**).
Each BTW stays bound to the Claude conversation selected when it was created;
its questions and answers live only in that browser tab's memory. Closing asks for
confirmation, cancels a pending answer, and discards the tab. Reloading also drops
these ephemeral tabs. Re-selecting any tool tab keeps the panel open; use the
explicit panel button to collapse it. Existing saved side-chat forks are unchanged.

BTW calls the SDK's native `askSideQuestion` control request, not a prompt or a
persisted side-chat fork. A live runtime is held until its side requests settle;
an idle conversation uses a control-only resume with `forkSession: true` and
`persistSession: false`, without hooks or tools. Responses are never broadcast
into the main chat. SDK 0.3.263 contains this method at runtime but omits its public
TypeScript declaration, so the narrow adapter checks availability and reports an
unsupported remote instead of falling back to a normal prompt. Each follow-up starts a fresh native side-question request with explicit `history`
from completed exchanges in the same tab. The composer clears immediately after
sending and stays available for follow-ups; failed requests can be retried. History
is limited to the most recent 32 exchanges / 64,000 characters (with a notice when
limited), while the full discussion remains visible until the tab is closed.

When a remote still runs the older question-only route, the local UI retries its
explicit history-field rejection with recent exchanges packaged into a new native
BTW question (within that server's 16,000-character limit). This keeps follow-ups
working during a local-only rollout without restarting active remote sessions.
Timeouts, cancellation and provider failures are never retried automatically.
