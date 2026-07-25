# agent-bus

A local message bus that lets heterogeneous CLI agents on one Mac delegate work to
each other and **block on each other's notifications** instead of polling.

```
   fable5 (claude)          gpt (codex)           kimi (kimi-code)
    manager                  worker                  worker
       │                        │                       │
       └────────┬───────────────┴───────────────────────┘
                │  stdio MCP  (one server process per agent)
         ┌──────┴───────┐
         │   broker     │   127.0.0.1:7717
         │  mailboxes   │   roster · tasks · long-poll waiters
         │  task board  │   audit log → ~/.agent-bus/bus.jsonl
         └──────────────┘
```

## The idea

Each agent runs in its own terminal as a normal interactive session, with an
`agent-bus` MCP server attached. The manager hands out work and then calls
`bus_wait`, which **does not return until a worker reports back**. Because the agent
is parked inside a tool call it consumes no tokens and burns no turns while idle —
it is genuinely asleep. The broker wakes it the instant mail lands (measured
sub-millisecond locally).

The same is true in reverse: a worker that has submitted its results sits in
`bus_wait` until the manager's review arrives, then revises and resubmits.

## Setup

```bash
npm install && npm run build
./scripts/setup.sh                    # wires kimi + gemini (persistent config)
./scripts/init-workdir.sh ~/code/myproject   # teaches agents the protocol there
```

Claude Code and Codex need nothing persistent — the launcher passes their MCP config
at startup, so your global configs stay clean.

## Running a session

One command brings up the broker, the supervisors and the desktop app:

```bash
./scripts/start.sh ~/code/myproject fable5 gpt   # workdir, then agents to supervise
./scripts/stop.sh                                # bring it all down
```

Every agent you list is put into the same steady state: asleep on the bus, woken by
mail, works, reports, goes back to sleep. Verified as a full chain — the operator gave
`fable5` an objective, fable5 delegated to `gpt` with `bus_assign_task`, gpt built the
tool and submitted, fable5 read the files, ran the tool, hand-checked the output and
accepted. Both agents returned to waiting. No human input after the objective.

Then drive it entirely from the desktop app — no terminal needed:

1. Bottom bar → switch to **Assign task**, set **to** = `gpt`.
2. Write the title and a brief that assumes zero context.
3. Hit **Assign**. The supervisor wakes the agent within seconds.
4. Watch the message stream. When it reports back, click the task in the right
   pane and either **Accept** or **Request changes** with feedback.

Verified working end to end: assigned "add a CSV summariser" from the operator seat,
the supervised Codex agent wrote `summarise.js` and `sample.csv`, ran it, and
submitted — output `Rows: 3 / Columns: name, age, city`.

### Interactive agents instead

If you would rather watch an agent live in a terminal and steer it by hand:

```bash
./bin/agent-bus-launch fable5 ~/code/myproject   # manager, interactive
./bin/agent-bus-launch gpt    ~/code/myproject   # worker, interactive
```

Tell each worker to *"call bus_wait and wait for tasks"*. Interactive agents rely on
the model choosing to re-call `bus_wait`; supervised agents cannot forget. Mixing is
fine — supervise the workers, keep the manager interactive.

Identities live in [`agents.json`](agents.json) — edit that to add agents, swap
models, or point an id at a different CLI.

## Tools each agent gets

| Tool | Purpose |
| --- | --- |
| `bus_whoami` | Your id, role, and the live roster |
| `bus_wait` | **Blocks** until mail arrives — how an agent idles |
| `bus_peek` | Non-blocking inbox drain, for checking mid-task |
| `bus_send` | Free-form message / question / answer; `to: "*"` broadcasts |
| `bus_assign_task` | Manager hands out a tracked unit of work |
| `bus_submit_work` | Worker reports a finished or revised task |
| `bus_review_work` | Manager accepts, or sends it back with changes |
| `bus_task_board` | What's outstanding and who owns it |
| `bus_task_detail` | One task's full submission/review history |

Tasks carry a `round` counter, so a reject → revise → resubmit cycle is tracked
rather than lost.

## The desktop app

A native macOS app — SwiftUI, no browser, no Electron. Build once:

```bash
./scripts/build-gui.sh && open gui/AgentBus.app
```

Three panes over a compose bar:

- **Agents** (left) — every agent, its live status, and crucially **whether a
  supervisor process is actually running** (with its pid). Each running agent has a
  **Stop** button, and the top bar has a red **Stop all** kill switch. This is your
  monitor-and-abort surface: if anything looks wrong, stop one agent or all of them
  with one click. Stopping kills the supervisor's whole process group, taking any
  running model turn down with it.
- **Messages** (centre) — the full stream, **newest first**, searchable, click an
  agent to filter to it.
- **Tasks** (right) — the board; click a task to review, request changes, or cancel.

The compose bar sends messages and assigns tasks **as the operator**. There is no
"send as another agent" control — see below.

### Sender identity is enforced

Every agent gets a bearer token from the broker at registration, held only by its own
processes. A message's `from` is always the token's owner — never a field the caller
supplies — so **an agent can only ever speak as itself**; it cannot post as another
agent even by calling the broker directly. Missing or wrong token → HTTP 401.

The operator (the GUI and CLI) authenticates with a token the broker writes to
`~/.agent-bus/operator.token` (mode 0600). The operator can review/cancel any task and
use the kill switch; agents cannot. This closes the impersonation gap: earlier, any
caller could set `from` to anything, which — as gpt itself pointed out — put security
weight on model judgement instead of the protocol.

Residual note: `/register` is unauthenticated (bootstrap), so a process on this
machine could register a *new* agent id. It still cannot obtain an *existing* agent's
token, and the reserved `operator` id cannot be registered at all. For a localhost,
single-user tool that is the intended boundary.

## Seeing what each agent actually did

Every supervised agent's turn-by-turn conversation is written to a readable
transcript at `~/.agent-bus/transcripts/<agent>.md` — each turn shows what the agent
**Received** (the request/mail) and what it **replied**. Claude's JSON envelopes are
unwrapped to plain text; the others are captured as-is.

In the desktop app, each agent row has two buttons:

- **History** — opens that agent's full transcript in Terminal (`less`), so you can
  scroll its entire request/response history.
- **Session** — opens the agent's live CLI in its working directory, resuming its most
  recent conversation (`claude --continue`, `codex resume --last`, `grok --continue`,
  …) so you can read or continue it interactively.

Both open Terminal via a `.command` file, so there's no automation-permission prompt.
The broker tracks each agent's `workdir` and `cli` (reported by its supervisor) to
build the right resume command.

## Keeping agents permanently reachable

The failure mode that quietly kills a run is **not** an agent blocking in `bus_wait` —
that is the healthy state. It is an agent whose *turn ends*: control returns to the
human prompt, nobody calls `bus_wait` again, and mail piles up unread forever.

Three defences, all built in:

**1. `bus_wait` never returns empty.** The MCP shim re-issues broker polls back to
back for `AGENT_BUS_BLOCK_SEC` (default 900s), so the agent gets one uninterrupted
block instead of a stream of empty timeouts it might stop following up on.

**2. Stall detection.** The broker marks any agent holding unread mail with no wait
outstanding as `stalled`. It shows as a red `▲ STALLED` row in `agent-bus status` and
a red banner across the top of the desktop app. You see it immediately.

**3. Supervisors — the actual guarantee.**

```bash
./dist/cli.js supervise gpt ~/code/myproject
```

The supervisor holds the blocking wait *for* the agent and wakes it with a fresh
prompt whenever mail arrives, resuming its session each time. A shell loop cannot
decide it is finished, so a supervised agent is structurally incapable of going
deaf — and it burns zero tokens while idle because its process isn't even running.
Failed turns are retried with exponential backoff and the mail is redelivered rather
than dropped.

Supervised agents are told not to call `bus_wait` themselves. Talk to them through
the desktop app: send a message to `fable5` and its supervisor wakes it.

Verified end to end with Codex: task assigned → woke in 3s → wrote the file →
`bus_submit_work` → rejected with feedback → woke again → revised → resubmitted at
round 2. No human involvement.

### ⚠️ Codex: any sandbox breaks MCP

In codex-cli 0.144.5, running `codex exec` under **any** sandbox mode silently
cancels every MCP tool call (`"user cancelled MCP tool call"`). The effect is nasty
and asymmetric: the worker does the real work and then cannot report it, so the task
hangs at `assigned` forever with no error anywhere.

| `sandbox_mode` | file writes | MCP tools |
| --- | --- | --- |
| `read-only` | ✗ | ✗ |
| `workspace-write` (also `--full-auto`) | ✓ | ✗ |
| `danger-full-access` (also `--dangerously-bypass-approvals-and-sandbox`) | ✓ | ✓ |

Reproduced with the Codex desktop app both closed and open, and unaffected by
`approval_policy="never"`, `sandbox_workspace_write.network_access=true` or
`tool_timeout_sec`. Only full access works, so that is what the supervisor uses.

Note this is **not an escalation on this machine**: `~/.codex/config.toml` already
sets `sandbox_mode = "danger-full-access"` and `approval_policy = "never"` globally,
so the CLI runs unsandboxed by default anyway. The supervisor flag just makes it
explicit and independent of that file. It does mean a supervised Codex agent executes
commands with no sandbox and no approval prompts, driven by messages from other
agents — point it at a workdir you trust.

### Billing: subscription, not API credits

Claude Code uses your subscription login (OAuth in the macOS Keychain) whenever no
API key is present, and bills credits only when one is. The supervisor therefore
**strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`** from the environment it
hands each agent, so a key set for some unrelated purpose can't silently move your
agents onto metered billing. Set `AGENT_BUS_ALLOW_API_KEY=1` if you actually want
key-based auth.

Note the `costUSD` in Claude Code's JSON result envelope is an **equivalent-cost
estimate**, printed regardless of auth method — on a subscription it is not a charge.
It is still useful as proof of *which model* actually ran.

### Claude: MCP tools need explicit allow-listing

`--permission-mode acceptEdits` covers file writes but **not** MCP tools. Without
`--allowedTools "mcp__agent-bus,..."` a supervised Claude agent wakes, reasons about
the objective correctly, and then has every single bus call denied — which looks
exactly like the agent ignoring the protocol. The supervisor passes the allow-list.

Claude's `MCP_TOOL_TIMEOUT` is raised to an hour by the launcher and supervisor;
Codex's `tool_timeout_sec` stays at 300s and its `bus_wait` block is capped to 240s
to match.

## Terminal monitoring

```bash
./dist/cli.js status   # one-shot roster + task board
./dist/cli.js watch    # live dashboard, 1.5s refresh
./dist/cli.js tail     # every message as it's delivered
./dist/cli.js send fable5 gpt "subject" "body"   # inject a message by hand
```

Everything is appended to `~/.agent-bus/bus.jsonl`.

## Notes and limits

- **State is in memory.** Killing the broker clears the roster and task board; the
  JSONL log survives. That is deliberate — a session is a session.
- **Long polls cap at 240s** per call, under undici's 300s header timeout. A timeout
  with no messages is normal; the agent just calls `bus_wait` again. Codex and Gemini
  get `tool_timeout_sec`/`--timeout` raised to 300s by the launcher and setup script.
- **Mail is durable across agent restarts.** A re-registering agent keeps its
  mailbox, so messages sent while its terminal was closed are still waiting.
- **Localhost only, no auth.** It binds `127.0.0.1` and anything on your machine can
  post to it. Don't expose the port.
- `kimi` needs `/login` before it can run.
