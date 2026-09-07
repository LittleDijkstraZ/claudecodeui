# Personal fork maintenance

Base: upstream `v1.37.2`. Branch: `personal/cloudcli`.
Modified on 2026-09-07 for incremental Claude output and Ultracode support.

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
`server/modules/providers/tests/` and
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

The initial fork passes the production build and frontend/backend type checks.
All 47 focused regression tests pass: 34 backend and 13 frontend cases.
Repository-wide lint exits successfully with 198 existing warnings and no
errors. The frontend build also reports pre-existing CSS and large-chunk
warnings. These unrelated warnings are retained to keep the patch focused.

When updating upstream, review the provider's SDK event protocol and frontend
realtime handlers together. Test the rebuilt application before replacing a
working remote service. Retain a separate previous installation for rollback.
