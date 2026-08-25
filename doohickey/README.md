# Doohickey

A menu bar usage tracker for every coding agent on the machine — quota left, tokens
spent, and where they went.

The bar shows one number: how much headroom is left on whichever quota is closest to
running out, across every provider. Click it for the breakdown.

![panel](docs/panel.png)

## What it tracks

Twenty providers, in three tiers — and the panel keeps them apart on purpose, because
"18% left" and "we cannot know" should not look the same.

**Live quota, straight from the account.** These rows are facts, not reconstructions.

| Provider | Endpoint | What it gives |
| --- | --- | --- |
| Claude Code | `api.anthropic.com/api/oauth/usage` | 5h session and weekly windows, extra-usage overage, plan |
| Codex | `chatgpt.com/backend-api/wham/usage` | live window, per-model allowances (Spark), reset credits, plan |
| Cursor | `cursor.com/api/usage-summary`, `/api/dashboard/get-sand-usage-status`, `/api/dashboard/get-filtered-usage-events` | requests left of the plan allowance, weekly window, per-model tokens and spend |
| Grok | `grok.com/rest/rate-limits` | queries left in the window |
| OpenRouter | `openrouter.ai/api/v1/key` | credit limit, remaining, weekly spend |
| DeepSeek · Moonshot · SiliconFlow | `/user/balance` and friends | account balance |
| Novita | `api.novita.ai/v3/user` | credit balance |
| xAI · Z.ai | key endpoints | key state only — neither publishes spend |

Claude and Codex are read with the OAuth tokens their own CLIs already hold, so there is
nothing extra to configure. Claude's lives in the login keychain; see below.

**Local transcripts.** Exact token counts, from files the tools write anyway.

| Provider | Source |
| --- | --- |
| Claude Code | `~/.claude/projects/**.jsonl` |
| Codex | `~/.codex/sessions/**.jsonl` |
| Agent Bus | the broker's usage ledger, per agent |

**Nothing to report.** Listed with the reason rather than silently absent, so a missing
provider is explained instead of looking like something you forgot to configure. Most of
these do publish usage — behind a *console web session* rather than an API key, so the
blocker is credential shape, not a missing endpoint: Groq and Mistral (console session),
OpenAI (org costs need an admin key), Fireworks (needs an account id too), Gemini (quota
lives in the Cloud console), Together and Copilot (no public per-account endpoint).

Ollama appears only while it is running, since local models have no quota to report.

### Cursor's dashboard endpoints need Origin and Referer

A session cookie alone gets 403 from `/api/dashboard/*`. Adding `Origin: https://cursor.com`
and a `Referer` makes them answer. Without that they look like endpoints that require
some entitlement the app does not have, which is the wrong conclusion to draw.

`usage-summary` states `remaining` and `limit` outright, so no arithmetic can get it
wrong. It also reports a percentage against *included spend* that disagrees with the
request-count ratio — both are real and measure different things, so both are shown with
their own labels rather than picking one and hoping.

## Reading Claude's token without hanging

Claude Code keeps its OAuth token in the login keychain. Reading it can put up an
authorization dialog, and **both** the Security API and `/usr/bin/security` block until
that dialog is answered.

That is a trap for a menu bar app. The dialog appears behind everything, or not at all
for a process launched by `launchd`, and meanwhile the refresh that triggered it never
returns. The in-flight guard never clears, every later refresh is skipped, and the panel
sits empty — indistinguishable from a crash. It cost several builds to find, because the
direct path is silent whether it works or not, so the hang only exists on machines that
actually prompt.

Three defences, all of them necessary:

- `SecKeychainSetUserInteractionAllowed(false)` around the direct read, so it fails
  instead of prompting. Deprecated, but the only API governing prompts for the
  file-based keychain these credentials live in.
- The `security` fallback runs with stdin on `/dev/null` and a 3-second deadline. A hang
  latches a flag so it is not retried every minute; **⋯ → Retry keychain read** clears it.
- The whole read happens on a detached thread. `refresh()` only ever reads an
  already-fetched value, so even a thread lost forever to a dialog cannot stall the UI.
  The token lands on the following refresh instead.

If it cannot be read the row falls back to a 5-hour block reconstructed from transcript
history, labelled `est`, with the reason underneath. That distinction earns its keep: the
estimate read 79% left on this machine while the account was actually at 43%. An estimate
that looks reassuring is worse than no estimate at all.

### Seeing what it decided

Every refresh writes `~/Library/Application Support/Doohickey/status.txt`: each
provider's state, quota, plan and token counts. A menu bar app has nowhere to print, and
"the credential read failed" otherwise looks exactly like "you have plenty left".

### Adding a provider

`Sources/Providers/Catalogue.swift` is a list of declarations — credential sources, an
endpoint, and a closure mapping the response onto a `Reading`. Credentials resolve from
an env var, a key file, a JSON field, or a named cookie, first match wins. No new code
path is needed for a provider that fits that shape.

## Metered vs. on plan

The headline number is **money that will appear on a bill**. Usage on a flat-rate plan
is added separately as `+$… on plan`: what the same tokens would have cost metered.

This distinction is the whole reason the totals are believable. Priced naively, a month
of ordinary Codex and Claude Code usage on subscriptions reads as several thousand
dollars — a number that is both true at list rates and completely misleading about what
was spent.

Detection: Codex declares its own `plan_type`; Claude Code is assumed to be on a
subscription unless `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set. Override per
provider in `~/Library/Application Support/Doohickey/billing.json`:

```json
{ "claudeCode": "metered" }
```

Rates live in `Sources/Core/Pricing.swift` and are overridable the same way, in
`~/Library/Application Support/Doohickey/pricing.json`:

```json
{ "claude-opus": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 } }
```

An unpriced model records its tokens and no cost — a gap is easier to spot than an
invented rate.

## Why it is light

| | Doohickey | CodexBar |
| --- | --- | --- |
| bundle | **780 KB** | 151 MB |
| memory, steady state | **27 MB** | 681 MB |
| memory, after a first full scan | 59 MB | — |
| idle CPU | 0% between refreshes | — |

Measured on the same machine, both idle, `footprint -p`. The higher figure is the peak
left behind by a cold scan of a 14 GB archive; it settles back on the next launch.

One Swift binary against the system frameworks: no Electron, no bundled Node, no
embedded browser. The transcripts it reads are the interesting part — this machine has
14 GB of Codex rollouts and 104 MB of Claude Code sessions, and both directories only
grow. A tracker that re-reads them on every tick is why these apps get heavy.

Instead every file is remembered by inode plus creation time along with how many bytes
have already been folded in. A refresh stats the directory, skips anything whose size
has not changed, and parses only the bytes appended since last time:

```
cold scan (14 GB, first launch)   30 s, in the background
warm refresh                      25 ms
```

Three things make the cold scan bearable, all of them in `Core/JSONLIndex.swift`:

- **Byte prefilter.** Transcripts are overwhelmingly message content; a fraction of a
  percent of lines carry usage. Lines are rejected with `memmem` before
  `JSONSerialization` ever sees them.
- **Block streaming.** Files are read in 4 MB blocks inside an `autoreleasepool`, not
  slurped whole. Skipping the pool cost 2.2 GB resident; adding it brought the same scan
  to 190 MB.
- **Checkpointing.** Progress is persisted every 25 files, so quitting halfway through a
  first scan costs one file rather than the whole run.

Results are kept as hourly buckets per model, so history is bounded by time rather than
transcript volume. The whole 30-day index is ~500 KB on disk.

## Counting rules

Two ways to get these numbers badly wrong, both handled:

- **Claude Code repeats every message.** One record is appended per streaming update,
  all sharing a `message.id`, each restating the full usage block. Summing them inflates
  totals roughly threefold, so `message.id` is the dedupe key.
- **Codex reports cumulative totals too.** `total_token_usage` is restated every turn;
  only `last_token_usage` is the delta. Its `input_tokens` includes the cached portion,
  so cache reads are subtracted out before pricing — otherwise they bill at full input
  rate, which on these volumes is most of the total.

Thinking and reasoning tokens are shown separately but not added again on top of output,
which already contains them.

Traffic routed through a local model router is attributed by model id: a namespaced id
(`stealth/ox-alpha`) was billed by OpenRouter, a bare one by Anthropic. Neither side
double-counts.

## Build and install

Needs only the Xcode Command Line Tools.

```bash
./doohickey/build.sh
cp -R doohickey/Doohickey.app /Applications/
open /Applications/Doohickey.app
```

Install it somewhere stable before running it. An app launched from a build directory by
a script that then exits can be torn down with the session that started it, which looks
exactly like a crash: the menu bar item never appears and the only evidence is a
`status.txt` that stops updating.

To keep it running across logins, `install-agent.sh` writes a LaunchAgent with
`KeepAlive`. Remove it with:

```bash
launchctl unload ~/Library/LaunchAgents/local.agentbus.doohickey.plist
rm ~/Library/LaunchAgents/local.agentbus.doohickey.plist
```

The app is ad-hoc signed and marked `LSUIElement`, so it lives in the menu bar with no
Dock tile. The ⋯ menu has "Rebuild index from scratch" and "Retry keychain read".

### If the panel is empty

Check `~/Library/Application Support/Doohickey/status.txt` first — it is rewritten on
every refresh and names each provider's state. A file that has stopped updating means
the app is not running; a file full of `notConfigured` means credentials, not the app.

## Agent Bus integration

The Agent Bus row is the one thing no other tracker can show: **which agent** spent what.
A swarm run appears in the Claude Code and Codex transcripts as one undifferentiated pile
of tokens, with no way to see that a single misconfigured reviewer burned most of it.

It reads the broker's ledger over `POST /usage/summary` on `127.0.0.1:7717`,
authenticating with `~/.agent-bus/operator.token`. When the broker is not running the row
says `broker offline` rather than reading the SQLite file behind its back — the broker
owns that file and may be mid-write.

See `docs/usage-ledger.md` for the broker side.
