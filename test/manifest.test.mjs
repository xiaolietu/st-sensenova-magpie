/**
 * Tests for the plugin manifest.
 *
 * `maxConcurrency` is not read by any code in this repository — Magpie reads it
 * out of package.json, and the account page's 「沿用供应商」 option shows that
 * number. Nothing here would catch it being dropped, which is why it is pinned.
 *
 * The value is 5 because that is what the platform allows, measured:
 * 4 concurrent → 4/4, 5 → 5/5 (twice, and again with max_tokens 4096 and
 * outputs up to 27s), 6 → 5/6 (twice), 8 → 5/8, 12 → 5/12. The ceiling is per
 * model, not per account: 3+3 across two models puts 6 requests in flight and
 * all six answer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("declares the measured concurrency ceiling, 5", () => {
  assert.equal(pkg.magpie?.maxConcurrency, 5);
});

test("the ceiling stays inside the range Magpie accepts", () => {
  const n = pkg.magpie.maxConcurrency;
  assert.ok(Number.isInteger(n), "must be an integer");
  assert.ok(n >= 1 && n <= 1000, "documented range is 1..1000");
});

test("the manifest still carries the fields Magpie loads a plugin by", () => {
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./index.mjs");
  assert.ok(typeof pkg.description === "string" && pkg.description.length > 0);
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), "version must be x.y.z");
});

test("every shipped file Magpie needs is listed in files", () => {
  // `files` decides what npm pack publishes; a missing entry means a module
  // that imports cleanly locally and 404s once installed from a tarball.
  for (const name of ["index.mjs", "internal.mjs", "quota.mjs", "models.mjs", "i18n.mjs"]) {
    assert.ok(pkg.files.includes(name), `${name} missing from files`);
  }
});
