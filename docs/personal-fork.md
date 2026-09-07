# Personal fork maintenance

Base: upstream `v1.37.2`. Branch: `personal/cloudcli`.
Modified on 2026-09-07 for incremental Claude output, Ultracode, and conversation groups.

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

## Checks

Use the locked dependencies with `npm ci`. Relevant regression tests live under
`server/modules/providers/tests/`, `server/modules/conversation-groups/tests/`,
`server/modules/database/tests/`, `server/modules/websocket/tests/`,
`src/components/sidebar/utils/groupConversationPager.test.ts`, and
`src/components/chat/utils/sessionStreamBuffer.test.ts`.

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

The fork passes the production build and frontend/backend type checks.
All 90 focused regression tests pass: 69 backend and 21 frontend cases.
Repository-wide lint exits successfully with 198 existing warnings and no
errors. The frontend build also reports pre-existing CSS and large-chunk
warnings. These unrelated warnings are retained to keep the patch focused.

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
