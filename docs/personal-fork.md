# Personal fork maintenance

Base: upstream `v1.37.2`. Branch: `personal/cloudcli`.
Modified on 2026-09-07 for incremental Claude output, Ultracode, conversation
groups, and per-turn conversation change review.

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

## Checks

Use the locked dependencies with `npm ci`. Relevant regression tests live under
`server/modules/providers/tests/`, `server/modules/conversation-groups/tests/`,
`server/modules/database/tests/`, `server/modules/websocket/tests/`,
`src/components/sidebar/utils/groupConversationPager.test.ts`,
`src/components/chat/utils/sessionStreamBuffer.test.ts`,
`src/components/chat/utils/conversationChanges.test.ts`,
`src/components/chat/hooks/useChatMessages.test.ts`, and
`src/components/chat/view/subcomponents/ConversationChangeContent.test.tsx`.

```sh
npm test
npm run test:client
npm run build
npm run typecheck
npm run lint
```

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
