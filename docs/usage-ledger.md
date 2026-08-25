# Usage ledger

The broker records what each agent spends, prices it, and exposes it over trailing
windows. Before this, `UsageMetrics` existed on the task and agent records but nothing
ever wrote a real number into it: `/usage` accepted whatever an agent chose to report,
kept a high-water mark, and had no notion of when any of it happened.

## Model

An append-only `usage_events` table. Rollups are derived and can always be rebuilt from
the events, which is what makes a windowed view possible at all — a high-water mark can
answer "how much in total", never "how much in the last five hours".

```
usage_events(id, ts, agent_id, task_id, run_id, model_id, model, provider,
             total_tokens, cost_usd, notional_usd, json)
```

Every event is also appended to `bus.jsonl` as `kind: "usage_event"`, so anything already
tailing the log sees spend in the same stream as messages and kills.

## Pricing is the broker's job

Callers send tokens. They do not send a cost.

`src/pricing.ts` holds list rates in USD per million tokens, matched by longest
substring, so `gpt-5-mini` is never priced as `gpt-5`. A rate that has moved, or a model
the table has never heard of, is corrected in config rather than in code:

```json
{ "models": { "opus-current": { "pricing": { "inputPerMTok": 15, "outputPerMTok": 75 } } } }
```

An unknown model records its tokens with zero cost. Inventing a rate is worse than
leaving a visible gap.

### Metered, subscription, local

A model whose `capabilities.costClass` is `subscription` bills nothing per call. Its
tokens are still priced, into `notionalUSD` — so a swarm running on a flat-rate plan
still reports what it consumed — while `costUSD` stays zero. Providers that run on the
user's own hardware (`ollama`, `lmstudio`, …) cost nothing either way.

Reporting these as one number is how a month of ordinary subscription usage reads as
several thousand dollars: true at list rates, and completely wrong about the bill.

## Endpoints

| Endpoint | Shape |
| --- | --- |
| `POST /usage/record` | One turn's tokens, added to the ledger. The preferred call. |
| `POST /usage` | Legacy cumulative totals. The growth since last time becomes one event, so old harnesses appear in windowed views like everyone else. |
| `POST /usage/summary` | Rollups over a trailing window: totals, by agent, by model, by provider, plus an evenly spaced series for charts. |
| `POST /usage/events` | Raw events in a window. |

Windows clamp to 90 days; the default is 5 hours, matching the window the subscription
plans reset on.

Recording someone else's usage requires operator authority — an agent may only record its
own.

## MCP tools

- `bus_record_usage` — report the tokens your last turn consumed. Called after finishing
  a turn, this is what makes swarm spend attributable per agent instead of vanishing into
  one session's total.
- `bus_usage` — what the swarm has spent over a window, by agent, model and provider.

## Consumers

`doohickey/` reads `/usage/summary` and puts it in the menu bar next to Codex, Claude
Code and OpenRouter.
