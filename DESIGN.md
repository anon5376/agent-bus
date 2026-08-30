---
name: Agent Bus
description: Night ATC console for a local multi-agent broker.
colors:
  console: "#12141a"
  console-2: "#1a1d26"
  console-ink: "#ece8df"
  paper: "#e7e1d4"
  paper-2: "#d9d1c0"
  ink: "#1c1914"
  ink-muted: "#5e574c"
  live: "#3aa8c1"
  mark: "#e0c14a"
  alert: "#d24a3d"
  ok: "#3d8f5a"
  warn: "#c48a2a"
  phosphor: "#0a0c10"
typography:
  display:
    fontFamily: "Segoe UI, Helvetica Neue, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "clamp(28px, 3.2vw, 42px)"
    fontWeight: 650
    lineHeight: 1.05
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Segoe UI, Helvetica Neue, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "normal"
  body:
    fontFamily: "Segoe UI, Helvetica Neue, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
  label:
    fontFamily: "Segoe UI, Helvetica Neue, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.12em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "0.04em"
rounded:
  none: "0px"
spacing:
  strip-gap: "6px"
  sector: "14px"
  control: "8px"
components:
  button-primary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "6px 10px"
  button-primary-hover:
    backgroundColor: "#f3eee4"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
  button-alert:
    backgroundColor: "{colors.alert}"
    textColor: "#ffffff"
    rounded: "{rounded.none}"
    padding: "6px 10px"
  button-console:
    backgroundColor: "{colors.console-2}"
    textColor: "{colors.console-ink}"
    rounded: "{rounded.none}"
    padding: "6px 10px"
  strip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "8px 10px"
  modal:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "16px 18px"
---

# Design System: Agent Bus

## Overview

**Creative North Star: "Night sector console."** Agent Bus is a local operator instrument, not an admin SaaS shell. The operator watches independent agents the way a controller watches flights: paper strips on a dark console, live figures in cyan, yellow only for wayfinding, red only to stop.

The dashboard is one surface: a yellow-ruled sector header, a display-size mission, two strip bays, and a phosphor live log. Providers live in a header popover. Projects and runs are header selects. State is a square tab on the strip, never a tinted card or a colored side stripe.

**Key Characteristics:**
- Dark console field with cream paper strips
- Cyan for live numbers and log time; yellow for labels; red reserved for stop
- Square corners, 1px rules, no glass and no gradient type
- Callsigns and log in mono; UI chrome in the system sans
- Topology is sector / mission / bay / console, never nav + metric cards + identical agent cards

**The Color-as-State Rule.** Color marks status or a stop, not decoration. If a region is not live, not a label, and not an alert, it stays console or paper.

## Colors

Full palette with named roles. Physical scene: night desk, local Mac, operator watching a broker.

- **console** `#12141a` — page field
- **console-2** `#1a1d26` — chrome controls on the field
- **paper** `#e7e1d4` — strips, modals, primary fill
- **ink** `#1c1914` — writing on paper
- **live** `#3aa8c1` — figures, host, log timestamps
- **mark** `#e0c14a` — sector rule, labels, log from→to
- **alert** `#d24a3d` — STOP ALL, Stop, failed tabs

**The Reserved-Red Rule.** Red is stop and failure only. Do not use it for links, badges, or emphasis.

## Typography

Operate register. CSP is `font-src 'self'`, so the system stack is the shipping face; mono is reserved for callsigns, figures, and the log.

- **Display:** mission title, `clamp(28px, 3.2vw, 42px)`, weight 650, tracking `-0.04em`
- **Label:** 10px, weight 700, tracking `0.12em`, uppercase, mark yellow
- **Body:** 14px / 1.35, console ink `#ece8df`
- **Mono:** strip ids, cyan figures, live log

**The Callsign Rule.** Agent and task titles on paper use mono. Prose on paper uses the UI sans.

## Layout

Desktop is a four-row console: sector header, mission, two-column bay (`1.4fr` tasks / `0.8fr` agents), phosphor log at `minmax(160px, 28vh)`.

At `1100px` the bays stack. At `720px` the mounted shell scrolls, the sector stacks, STOP ALL spans the action row, and figures wrap.

Empty mission is vacant grey display type (“No run selected”), not a card.

## Elevation & Depth

Flat. No drop shadows. Layers are tone: phosphor `#0a0c10` under console `#12141a` under paper. Selected strip uses a 2px mark outline, not a shadow.

## Shapes

Every control, strip, modal, and mark is square (`border-radius: 0`). State is a 10×10 square tab. The sector is a 3px mark rule. Do not round the favicon or boot mark.

## Components

### Buttons
- **Shape:** square, 1px border, padding `6px 10px` (strip actions `4px 8px`)
- **Primary:** paper fill, ink text (on paper surfaces: ink fill, paper text)
- **Alert:** alert fill, white text, weight 700
- **Subtle alert:** transparent, `#f0b4ae` on `#6a3a36`
- **Focus:** 2px mark outline, offset 2px

### Strips
Paper progress strips, not cards. Grid is tab / body / meta / actions. Offline strips sit at 0.78 opacity. Selected task strip gets the mark outline.

### Sector header
Yellow-ruled band. Place selects, cyan figures, Providers `<details>` popover on paper, New run, STOP ALL.

### Live log
Mono list. Cyan time, yellow `from → to`, console ink body. No card chrome.

### Modals
Paper sheets on `#000000b3`. Inputs are white with paper-2 borders. Primary on paper is ink.

## Do's and Don'ts

### Do:
- **Do** put work on paper strips and keep the field dark.
- **Do** keep providers in the header popover, not a left rail.
- **Do** use a square tab for state.
- **Do** reserve red for stop and failure.

### Don't:
- **Don't** rebuild the three-column admin shell (nav + metric cards + identical agent cards).
- **Don't** use a colored `border-left` as status.
- **Don't** load webfonts; CSP is `font-src 'self'`.
- **Don't** use Inter, gradient text, glass, or emoji as icons.
