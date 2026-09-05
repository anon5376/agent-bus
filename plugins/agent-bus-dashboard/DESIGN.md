---
name: Agent Bus Dashboard
description: A local control plane with Light, Dark, and EVIL themes.
colors:
  canvas: "#FFFFFF"
  sidebar: "#FFFFFF"
  surface: "#FFFFFF"
  surface-strong: "#F5F5F5"
  surface-raised: "#EEEEEE"
  text: "#000000"
  text-muted: "#444444"
  text-faint: "#767676"
  line: "#E6E6E6"
  line-strong: "#000000"
  accent: "#000000"
themes:
  light: "White paper, black ink, no hue."
  dark: "Near-black canvas, light ink, no hue."
  evil:
    surface: "#090705"
    ink: "#E8D8B0"
    accent: "#9E1B32"
    fonts:
      ui: "Cloister Black"
      code: "Geist Mono, SFMono-Regular"
    semantic:
      added: "#00AD3A"
      removed: "#F13342"
      skill: "#9540D5"
typography:
  display: "Helvetica Neue, Helvetica, Arial, sans-serif"
  body: "Helvetica Neue, Helvetica, Arial, sans-serif"
  data: "SFMono-Regular, ui-monospace, Consolas, monospace"
rounded:
  control: "2px"
  panel: "4px"
motion:
  hover: "120ms cubic-bezier(.22,0,0,1)"
  state: "200ms cubic-bezier(.22,0,0,1)"
  structural: "320ms cubic-bezier(.65,0,.15,1)"
  reveal: "560ms cubic-bezier(.22,0,0,1)"
---

# Design System: Agent Bus Dashboard

## Creative North Star

Agent Bus is an exact local operations instrument. Light and Dark stay monochrome. EVIL is the Codex v1 cloak: parchment ink, blood accent, Cloister Black.

## Composition

- A white rail establishes system and project context; the selected workspace is marked in black. The rail and project list can be hidden or expanded.
- With no project selected, the landing is a searchable project register: pinned first, then coordination sources, then local folders. Setup prompts and the cat follow the register. The rail repeats the same pin and search.
- Agents progress from explicit run controls to current-session usage to the attached roster.
- Conversations preserve the index/detail workspace, with folder state and reversible actions always visible.
- Flat regions, ruled sections, and negative space provide hierarchy. No cards, glow, or decorative color.

## Typography

- Helvetica-style sans headings and body.
- Monospace is reserved for paths, ids, time, status metadata, usage, and navigation indices.
- Labels use compact uppercase only where they describe machine state or a control cluster.

## Color and Material

- Light: white canvas, black ink. Dark: near-black canvas, light ink. Both stay hue-free.
- EVIL uses surface `#090705`, ink `#e8d8b0`, accent `#9e1b32`, plus the Codex semantic greens, reds, and violet.
- Theme choice persists in localStorage. The switch stays in the rail.
- Borders are crisp hairlines. Corners are 2–4px. No gradients or glass.

## Components and States

- The geometric lowercase `b` is rendered as a black mark.
- Buttons are rectangular and labelled. Primary is white on black. Danger is the same palette, inverted on hover.
- Selected rows use a one-pixel black edge; hover never shifts layout.
- Archive, Trash, Restore, start/stop, usage, paused broker, disabled, empty, success, and failure states retain their existing product semantics.

## Motion

- One 560ms page reveal uses a short clip and vertical settle.
- Hover/press feedback is 120ms, state changes 200ms, and structural changes 320ms.
- Reduced motion removes translation, clipping, and animation.

## Responsive Rules

- Collapse to a single column on small viewports. Keep type readable. Do not introduce color to compensate.
