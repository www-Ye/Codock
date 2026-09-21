import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, renderIndex } from "../lib/config.mjs";
import { exerciseAppearance } from "../scripts/screenshots.mjs";
test("theme presets validate and template values are safe", () => {
  const good = {
    origin: "https://terminal.example.com",
    previewSuffix: "preview.example.com",
    socket: "/srv/demo/tmux.sock",
    projectRoot: "/srv/demo/projects",
    allowed: ["dev"],
    authMode: "local",
  };
  for (const preset of ["graphite", "midnight", "paper"])
    assert.equal(validateConfig({ ...good, brand: { preset } }).brand.preset, preset);
  for (const brand of [
    null,
    "graphite",
    [],
    { unknown: true },
    { preset: "other" },
    { mascot: "yes" },
    { character: "other" },
    { accent: "red;display:none" },
  ])
    assert.throws(() => validateConfig({ ...good, brand }));
  for (const character of ["nailong", "duck", "cat", "robot"])
    assert.equal(validateConfig({ ...good, brand: { character } }).brand.character, character);
  assert.equal(validateConfig(good).brand.name, "Codock");
  assert.equal(
    renderIndex("{{BRAND_PRESET}} {{BRAND_MASCOT}}", { preset: '" onclick="', mascot: false }),
    "graphite off",
  );
});
test(
  "real UI: three themes, mobile/desktop, persistence, contrast, pet state and reduced motion",
  { timeout: 45000 },
  async () => {
    await exerciseAppearance();
  },
);
