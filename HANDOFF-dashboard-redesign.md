# Handoff: Agent Bus Dashboard redesign ("Switchboard")

Previous Claude session: df14cebf-5ebb-43bf-a755-2d8e96f7f7df (agent id on the bus: fable-agent-bus-redesign).
Branch: `better`. Nothing is committed; all work is in the working tree.

## Where things live
- Repo copy: `plugins/agent-bus-dashboard/` (source of truth for git).
- Live copy: `/Users/anon5376/plugins/agent-bus-dashboard/` — must stay byte-identical to the repo copy.
- Live dashboard: http://127.0.0.1:8788 (PID from `pgrep -f plugins/agent-bus-dashboard/scripts/dashboard_server.py`), started with
  `nohup /usr/bin/python3 /Users/anon5376/plugins/agent-bus-dashboard/scripts/dashboard_server.py >> ~/.agent-bus/logs/dashboard-server.log 2>&1 &`
- Operator state (pins, hidden projects, roles, folders): `~/.agent-bus/dashboard-state.json`. Right now 30 of 31 projects are hidden; open the **Hidden** bay on the home page to show them.

## Files that changed
- `assets/dashboard.css` — whole visual system (Light / Dark / Evil tokens at the top, then components, responsive rules at the bottom).
- `assets/dashboard.js` — theme, dock/drawer, filters, usage + live status refresh, keyboard (`/`, `g p`, `g o`, `g a`, `g m`).
- `assets/theme.js` — pre-paint theme/dock boot.
- `scripts/dashboard_server.py` — all HTML is rendered here. Key methods: `shell` (top bar + dock), `home`, `render_project_register`, `project_page`, `agents_page`, `render_agent_rows`, `render_supervision`, `render_usage_monitor`, `render_tasks_panel`, `messages_page`, `render_conversation_list`, `render_conversation_detail`, `render_compose`, `setup_page`, `error_page`; helpers near the top of the `Dashboard` section: `status_label/status_class`, `infer_harness`, `provider_label`, `monogram_html`, `task_state_*`.
- Deleted `assets/CloisterBlack.ttf`. Kept only `b-logo.png`, `home-cat.jpg`, `home-cat-evil.jpg`.
- Docs/manifests: DESIGN.md, .impeccable/design.json, PRODUCT.md, README.md, SKILL.md, both plugin.json (v0.3.0).

## Constraints to respect
- Python 3.9 (`/usr/bin/python3`): no `match`, no backslashes inside f-string expressions.
- Standard library only, loopback only, CSP forbids inline styles/scripts (use `<meter>` / classes, not `style=""`).
- Preserve every route, form field, id and backend behaviour; the dirty-tree "hide projects" feature is part of the current code.

## Edit → validate → ship loop
```sh
/usr/bin/python3 plugins/agent-bus-dashboard/scripts/dashboard_server.py --check --dashboard-state /tmp/abd-check-state.json
# optional test instance with isolated state:
/usr/bin/python3 plugins/agent-bus-dashboard/scripts/dashboard_server.py --port 8799 --dashboard-state /tmp/abd-test-state.json
rsync -a --delete --exclude __pycache__ --exclude .DS_Store plugins/agent-bus-dashboard/ /Users/anon5376/plugins/agent-bus-dashboard/
# CSS/JS are picked up on reload; server (.py) changes need a restart of the live process (kill the PID, rerun the nohup line above).
```

## Screenshot tips (see memory notes)
Headless Chrome hangs after `--screenshot` and clamps windows to 500px wide; for phone widths use DevTools emulation. Reference images from the last review: `/tmp/agent-bus-redesign/after/` and `/tmp/agent-bus-redesign/live/` (temporary).

## Next step
Operator will point at specific screens/elements in the built-in browser and list fixes. Apply them in the repo copy, run `--check`, rsync to the live copy, restart the live server if the Python changed, then confirm on http://127.0.0.1:8788.

## Round 2 (2026-09-06) — operator fixes applied, still uncommitted
- Agents are shown by **role** (Commander, Research review lead…), subtitled by a readable **model + effort** ("Fable 5.1 xhigh", "GPT 5.6 sol"). Raw ids sit behind an **Identifiers** toggle in each agent row and in tooltips everywhere else (overview chips, conversation routes, transcript heads, participant chips, usage groups, task assigner/assignee, compose recipients).
  Helpers in `dashboard_server.py`: `provider_key`, `model_display`, `agent_effort`, `agent_title`, `agent_model_line`, `avatar_html`, `Dashboard.agent_index / who / who_label / who_names`. Effort comes from the roster (`effort`/`reasoningEffort`), the registry `agents.json`, or a trailing token in the model string.
- Letter monograms replaced by **provider marks** (inline monochrome SVG, `PROVIDER_MARKS`): Anthropic, OpenAI, xAI, Cursor, Z.ai, Moonshot, Google, DeepSeek, Alibaba, Meta, Mistral, OpenCode, Aider, human, generic. CSS class `.avatar` (+ `.avatar-s`, `.avatar-l`, `.p-<provider>`). `monogram_html` stays as a shim.
- Evil theme uses **Cloister Black** (restored `assets/CloisterBlack.ttf`, served with `font/ttf`, `@font-face` in the CSS, upright, larger heading sizes).
- Home: mascot photo 88 → 168px (132px on phones); the "N of M" tally now sits inside the search field.
- Local setup: status pills hug their text; long states shortened ("File unavailable", "Disconnected") with the explanation moved into the card copy.
- Asset cache-buster bumped to `?v=switchboard-2`. `--check` passes; live copy rsynced and the live server restarted.
