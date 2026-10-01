const fs = require("node:fs");
const path = require("node:path");
const c = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "src", "official-theme.css"), "utf-8");
const keys = [
  "--color-text", "--color-text-primary", "--color-text-secondary", "--color-text-tertiary", "--color-text-emphasis",
  "--color-background-primary", "--color-background-secondary", "--color-background-tertiary",
  "--color-surface", "--color-surface-secondary", "--color-surface-tertiary", "--color-surface-canvas",
  "--color-border", "--color-border-default", "--color-border-subtle", "--color-border-light", "--color-border-heavy", "--color-border-strong",
  "--bg-primary", "--bg-secondary", "--bg-tertiary", "--bg-elevated-primary", "--bg-elevated-secondary",
  "--color-text-inverse", "--color-text-token-text-primary",
];
for (const k of keys) {
  const re = new RegExp(k.replace(/[-]/g, "\\-") + "\\s*:([^;]{0,120})");
  const m = c.match(re);
  console.log(k.padEnd(38), m ? "= " + m[1].trim() : "MISSING");
}
