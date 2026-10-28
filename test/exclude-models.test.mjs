/**
 * Tests for the model deny-list.
 *
 * `GET /v1/models` is not filtered by plan: it advertises ids the account then
 * refuses with 403. Those have to be named somewhere, and naming them must not
 * turn into a second snapshot — everything not named still comes from the
 * endpoint.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_EXCLUDED_MODELS, excludeModels, normalizeModel } from "../models.mjs";
import { SenseNovaPlugin } from "../index.mjs";

const m = (id) => normalizeModel({ id, output_modalities: ["text"] });

const PAYLOAD = {
  data: [
    { id: "deepseek-v4-flash", output_modalities: ["text"] },
    { id: "deepseek-flash", output_modalities: ["text"] },
    { id: "deepseek-v4.1-flash", output_modalities: ["text"] },
    { id: "glm-5.2", output_modalities: ["text"] },
    { id: "sensenova-u1.5-lite", output_modalities: ["image"] },
  ],
};

const okFetch = async () => ({ ok: true, status: 200, json: async () => PAYLOAD });

async function idsFrom(options) {
  globalThis.fetch = okFetch;
  const plugin = await SenseNovaPlugin({}, options);
  const models = await plugin.provider.models({ id: "sensenova" }, { auth: { key: "sk-1" } });
  return Object.keys(models).sort();
}

test("the default deny-list names the plan-gated DeepSeek id", () => {
  assert.deepEqual(DEFAULT_EXCLUDED_MODELS, ["deepseek-v4.1-flash"]);
});

test("excludeModels drops only the named ids", () => {
  const list = [m("a"), m("b"), m("c")];
  assert.deepEqual(excludeModels(list, ["b"]).map((x) => x.id), ["a", "c"]);
});

test("an empty or absent deny-list keeps everything", () => {
  const list = [m("a"), m("b")];
  assert.equal(excludeModels(list, []).length, 2);
  assert.equal(excludeModels(list, undefined).length, 2);
});

test("excludeModels ignores non-string entries instead of throwing", () => {
  const list = [m("a"), m("b")];
  assert.deepEqual(excludeModels(list, [null, 3, "a"]).map((x) => x.id), ["b"]);
});

test("the provider hides the plan-gated model but keeps the rest", async () => {
  // deepseek-v4.1-flash is denied by the option, sensenova-u1.5-lite by the
  // image-model filter inside the catalog.
  assert.deepEqual(await idsFrom({}), ["deepseek-flash", "deepseek-v4-flash", "glm-5.2"]);
});

test("the option is taken as given, so an empty array shows everything", async () => {
  const ids = await idsFrom({ excludeModels: [] });
  assert.equal(ids.includes("deepseek-v4.1-flash"), true);
});

test("a custom deny-list replaces the default rather than adding to it", async () => {
  const ids = await idsFrom({ excludeModels: ["glm-5.2"] });
  assert.equal(ids.includes("glm-5.2"), false);
  assert.equal(ids.includes("deepseek-v4.1-flash"), true);
});
