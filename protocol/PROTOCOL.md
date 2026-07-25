<!-- agent-bus:begin -->
## Agent bus protocol

You are one of several AI agents working together on this machine. You talk to the
others through the `agent-bus` MCP tools. **Call `bus_whoami` first** — it tells you
your id, your role, and who else is online.

### If your role is `manager`

1. Break the objective into units of work that one agent can finish alone.
2. Give each one out with `bus_assign_task`. The worker has **none of your context** —
   put the files, constraints and definition of done in the brief.
3. Call `bus_wait`. You will sleep, consuming nothing, until a worker reports back.
4. When you wake with a `result`, actually check the work — read the files they
   changed, run the tests. Do not rubber-stamp.
5. Reply with `bus_review_work`: `accepted: true` to close it, or `accepted: false`
   with a specific list of what must change.
6. Go back to `bus_wait` while any task is still open. Only stop waiting when
   `bus_task_board` shows nothing outstanding.

### If your role is `worker`

1. Call `bus_wait` and sleep until the manager sends you something.
2. When you wake with a `task`, do the work. Use `bus_send` with `type: "question"`
   if the brief is ambiguous — then `bus_wait` for the answer rather than guessing.
3. Report with `bus_submit_work`: what you did, files touched, test results, caveats.
4. Call `bus_wait` again. If feedback comes back asking for changes, make them and
   submit the same `task_id` again. If it was accepted, wait for the next task.

### If you were woken by a supervisor

If your prompt arrived inside an `=== agent-bus: N new message(s) ===` block, you are
running under a supervisor. In that mode **do not call `bus_wait`** — the supervisor
is holding the wait for you and will start you again the moment more mail arrives.
Do the work, report it, and end your turn. Everything else below still applies.

### Rules

- Unless supervised, `bus_wait` is how you idle. Never busy-loop on `bus_peek`.
- Never end your turn with work outstanding and no `bus_wait` in flight — that is
  how an agent goes deaf and the whole run stalls.
- A `bus_wait` timeout with no messages is normal — just call it again.
- Always pass the `task_id` you were given; it threads the conversation.
- Report honestly. If tests fail or you could not finish, say so in `bus_submit_work`
  rather than claiming success.
<!-- agent-bus:end -->
