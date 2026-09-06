---
name: Agent Bus Dashboard
description: A local switchboard for many agents across many projects, with Light, Dark, and Evil themes.
colors:
  bg: "#F3F1EA"
  panel: "#FFFFFF"
  panel-2: "#F8F7F3"
  panel-3: "#EFEDE6"
  ink: "#16150F"
  ink-2: "#45433B"
  ink-3: "#73706A"
  line: "#E4E1D8"
  accent: "#2A78D6"
  ok: "#0CA30C"
  warning: "#FAB219"
  serious: "#EC835A"
  critical: "#D03B3B"
themes:
  light: "Warm paper canvas, white panels, near-black ink, blue signal."
  dark: "Graphite canvas, layered charcoal panels, bone ink, blue signal."
  evil:
    bg: "#070607"
    panel: "#111013"
    ink: "#F3EDE4"
    accent: "#FF4D3D"
    display: "Cloister Black blackletter (bundled)"
harness:
  claude: "#EB6834"
  codex: "#1BAF7A"
  grok: "#4A3AA7"
  kimi: "#E87BA4"
  opencode: "#EDA100"
typography:
  display: "Iowan Old Style, Palatino, Charter, Georgia, serif (Evil: Cloister Black, bundled at assets/CloisterBlack.ttf)"
  ui: "Inter, SF Pro Text, system-ui, Helvetica, Arial, sans-serif"
  data: "SF Mono, JetBrains Mono, ui-monospace, Menlo, monospace"
rounded:
  control: "6px"
  panel: "10px"
  section: "14px"
motion:
  hover: "120ms cubic-bezier(.2,.7,.2,1)"
  state: "200ms cubic-bezier(.2,.7,.2,1)"
  structural: "360ms cubic-bezier(.6,0,.2,1)"
  reveal: "420ms cubic-bezier(.2,.7,.2,1)"
---

# Design System: Agent Bus Dashboard

## Creative North Star

The dashboard is a **switchboard**: one operator, many agents, many projects. Every page answers three questions in order: who is live, what are they doing, what can I do next. The look is an instrument, not a marketing page: serif titles for orientation, a sans instrument body, mono for identifiers and time, and color only where it carries meaning.

## Composition

- **Status bar.** A sticky top bar holds the brand mark, breadcrumb, the live broker pill (connected / disconnected, live and waiting counts), the theme switch, and Local setup.
- **Project dock.** A collapsible left rail with search, the project list (pinned first, live counts in green), and the selected project's Overview / Agents / Conversations. On narrow screens it becomes a drawer behind the menu button.
- **Projects register.** Pinned, coordination sources, local projects, and a collapsible Hidden bay. Each project is a card with a kind-coloured icon, path, live and message counts, and Pin / Hide.
- **Project overview.** Summary tiles (attached agents, inbox, open tasks, source), a mini roster, recent conversations, and a read-only tasks panel.
- **Agents.** Supervision (counts, start, stop all), Usage (stat tiles and a share-of-tokens breakdown), the roster as a two-line grid per agent (identity · status · harness/model · controls, then activity · usage · role), registered identities, session assignments, and tasks.
- **Conversations.** A segmented folder control (Inbox / Archived / Trash), search, an index with provider marks and previews, a detail column with participant chips, a transcript, and the composer docked at the bottom of the detail.
- **Setup.** Connection cards with status pills above the form.

## Typography

- Display: serif, weight 500, tight leading. Evil swaps the display face for Cloister Black (blackletter, upright, larger sizes, no negative tracking) on the brand, page titles, panel titles, and the mascot caption.
- Body and controls: the system UI sans at 13–14px.
- Data: mono for ids, paths, timestamps, counts in tables. Stat-tile values stay in the sans.

## Color and Material

- Light: paper `#F3F1EA` canvas with white panels. Dark: graphite `#0F1012` with charcoal panels. Evil: void `#070607` with bone ink and a vermilion `#FF4D3D` signal.
- The accent (blue in Light and Dark, vermilion in Evil) is reserved for selection, focus, links, and primary actions.
- Status is always a dot plus a label: green working, blue waiting, amber review, orange blocked or stalled, red failed, hollow red ring stale or offline, hollow blue ring registered-not-attached.
- Agent identity is a provider mark (Anthropic, OpenAI, xAI, Cursor, Z.ai, Moonshot, Google, DeepSeek, Alibaba, Meta, Mistral, OpenCode, Aider, a person for the operator, a node for unknown agents) drawn inline as monochrome SVG on a quiet panel tile. Marks inherit ink; Anthropic, Google, Moonshot, and OpenCode take their harness hue. Rows are titled by the agent's role, subtitled by a readable model name and effort ("Fable 5.1 xhigh", "GPT 5.6 sol"); raw ids live behind an Identifiers toggle and in tooltips.
- Panels are white or charcoal with one hairline and a soft shadow. No gradients, glass, or decorative colour.

## Components and States

- The cat mark sits in a black rounded tile; it never inverts. The cat photographs appear in the register mascot and in empty and error states; Evil swaps in the painted evil cat.
- Buttons: primary is ink-on-paper (vermilion in Evil), danger is a red outline that fills on hover, quiet is borderless.
- Disabled supervision controls explain why in the note beneath the counts. A disconnected broker turns the top-bar pill red, marks agents stale, pauses usage, and disables process controls.
- Empty states carry the mark or the cat, one sentence of guidance, and a next action.

## Motion

- One 420ms page settle. Hover 120ms, state 200ms, structural 360ms. Reduced motion removes all of it.

## Responsive Rules

- Below 1040px the roster stacks to two columns and the overview to one. Below 900px the dock becomes a drawer and the conversation workspace stacks. Below 640px everything is one column and the brand name and setup link fold into the menu.
