---
name: Agent Bus
description: Local operator dashboard for a multi-agent broker.
colors:
  bg: "#141414"
  bg-2: "#181818"
  panel: "#1e1e1e"
  panel-2: "#242424"
  border: "#2e2e2e"
  text: "#e4e4e4"
  muted: "#8c8c8c"
  accent: "#4d9fff"
  accent-2: "#3b82f6"
  ok: "#4ade80"
  warn: "#fbbf24"
  alert: "#f87171"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.04em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  bar: "48px"
  panel: "12px"
  control: "8px"
components:
  button-primary:
    backgroundColor: "{colors.accent-2}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-alert:
    backgroundColor: "#7f1d1d"
    textColor: "#fecaca"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  row:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  modal:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "16px 18px"
---

# Design System: Agent Bus

## Overview

**Creative North Star: Cursor-style operator dashboard.** Agent Bus looks like a Cursor settings/agents surface: near-black panels, 8px rounded rows, a slim top bar, and a blue accent. The product name stays Agent Bus / AB. Do not use Cursor trademarks as branding.

**Key Characteristics:**
- Near-black field (`#141414`) with raised panels (`#1e1e1e`)
- 8–12px radii, 1px `#2e2e2e` borders
- Blue accent for selection and primary actions
- Status is a small round pill, not a colored side stripe
- Settings is a configuration page: provider cards, agent rows, drag-and-drop hierarchy

## Colors

- **bg** `#141414` — page
- **panel** `#1e1e1e` — cards and lists
- **text** `#e4e4e4`
- **muted** `#8c8c8c`
- **accent** `#4d9fff` — live selection, links
- **accent-2** `#3b82f6` — primary buttons
- **alert** `#f87171` — stop/failure only

## Layout

Desktop: 48px top bar, mission line, two-column task/agent panels, live log at the bottom. Settings uses a two-column card grid.

## Do's and Don'ts

### Do:
- **Do** keep configuration on a dedicated Settings page with provider autodetect.
- **Do** round rows and modals; match Cursor dashboard density.
- **Do** reserve red for stop and failure.

### Don't:
- **Don't** use ATC/paper-strip chrome, square corners as a theme, or yellow sector rules.
- **Don't** name the product after a username or copy Cursor’s logo.
- **Don't** load webfonts; CSP is `font-src 'self'`.
