# webui

Rules that span the attach socket, gateway, protocol and client — each one has
caused or would cause a wrong-session/wrong-transcript bug:

- A process socket is identified by PID plus nonce, never session ID. Attach only when registry and descriptor agree on both; descriptor rewrites are asynchronous, so an early or stale descriptor can attach to the wrong session.
- `sessionSwitched` also fires for `/clear`; do not assume it means resume.
- A live transcript comes wholly through its socket. Never splice a disk snapshot to a socket tail — queued writes, mutable assistant messages, DAG branches and UI reordering make the merge lossy.
- "Interrupt and send" is one priority enqueue, not cancel then submit. In headless mode every non-stdin producer must call `run()` after `enqueue()` or the turn never starts.
- A browser permission disconnect must not deny by omission: keep the terminal dialog answerable while the broker retains the request.
- Gateway children require a configured config home with provider settings, trust and API-key approval. A source rebuild does not update a running gateway; restart it, preserving the tunnel hostname when needed (`web restart` does).
- Browser resume must wait for the requested session's descriptor and use the recorded working directory. Do not pass `--fork-session`, which leaves a duplicate history row.
- The client follows sessions across processes: exclude known-dead process keys despite the polling lag, and call gateway `detach()` rather than clearing React state, or reconnect strands the view on an empty dead process.
- The client keeps imports from schema and gateway modules type-only, or zod and Node modules leak into the bundle. CSP permits self/data images, not blob URLs. Off-screen panels stay focusable and hit-testable unless they also get `visibility: hidden` or zero height; mobile controls stay at least 16px against iOS Safari focus zoom.
- `AskUserQuestion` and `ExitPlanMode` require enriched `updatedInput`; a bare allow silently submits empty answers. Exit-plan approval must also drop `plan`, or it falsely reports a user edit.
- Permission-mode changes must be sent before `allow` on the same socket so the mode lands before tool execution. Browser `persist` is deliberately session-scoped; never turn an internet-facing approval into the terminal's durable on-disk rule.
