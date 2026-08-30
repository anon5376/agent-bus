import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_APPEARANCE, appearanceCssText, parseAppearance } from "../src/appearance.js";

test("parseAppearance fills defaults and lowercases valid hex", () => {
  const theme = parseAppearance({ accent: "#4D9FFF", extra: "ignored" });
  assert.equal(theme.accent, "#4d9fff");
  assert.equal(theme.bg, DEFAULT_APPEARANCE.bg);
  assert.equal(theme.text, DEFAULT_APPEARANCE.text);
});

test("parseAppearance rejects non-hex colors", () => {
  assert.throws(() => parseAppearance({ bg: "red" }), /appearance\.bg must be a #RRGGBB color/);
  assert.throws(() => parseAppearance({ accent: "#fff" }), /appearance\.accent must be a #RRGGBB color/);
});

test("appearanceCssText emits custom properties", () => {
  const css = appearanceCssText(DEFAULT_APPEARANCE);
  assert.match(css, /--bg: #141414;/);
  assert.match(css, /--accent: #4d9fff;/);
});
