/**
 * Tests for the `GET /v1/models` normalizer.
 *
 * The fixtures are the shapes the platform's own documentation publishes, so a
 * rename on their side shows up here as a failing test rather than as a
 * silently empty model list at runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCatalog,
  extractModels,
  isChatModel,
  normalizeModel,
  toConfigModel,
  toProviderModel,
} from "../models.mjs";

/** The `Model` object from the 模型列表 (List Models) documentation. */
const DOCUMENTED = {
  id: "sensenova-6.8-flash-lite",
  hugging_face_id: "",
  name: "sensenova-6.8-flash-lite",
  created: 1777392000,
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  quantization: "fp8",
  context_length: 262144,
  max_output_length: 65536,
  pricing: {
    prompt: "0",
    completion: "0",
    image: "0",
    request: "0",
    input_cache_read: "0",
  },
  supported_sampling_parameters: ["temperature", "stop"],
  supported_features: ["tools", "json_mode", "reasoning"],
  description: "SenseNova 6.8 Flash-Lite is a lightweight multimodal agent model...",
};

/** An image-creation entry, which this chat provider must not advertise. */
const IMAGE_MODEL = {
  id: "sensenova-u1.5-lite",
  name: "sensenova-u1.5-lite",
  input_modalities: ["text", "image"],
  output_modalities: ["image"],
  context_length: 32768,
  max_output_length: 4096,
  supported_features: [],
};

test("reads the documented context and output ceilings", () => {
  const m = normalizeModel(DOCUMENTED);
  assert.equal(m.contextLength, 262144);
  assert.equal(m.maxCompletionTokens, 65536);
});

test("max_output_length is what the platform sends, not max_completion_tokens", () => {
  const m = normalizeModel({ id: "x", max_output_length: 8192 });
  assert.equal(m.maxCompletionTokens, 8192);

  // The OpenAI spelling is not part of this API; it must not be invented.
  const bare = normalizeModel({ id: "unknown-model" });
  assert.equal(bare.maxCompletionTokens, 32768);
});

test("capabilities come from supported_features membership", () => {
  const m = normalizeModel(DOCUMENTED);
  assert.equal(m.supportsTools, true);
  assert.equal(m.reasoning, true);
  assert.equal(m.supportsJsonMode, true);

  const noTools = normalizeModel({ id: "x", supported_features: ["json_mode"] });
  assert.equal(noTools.supportsTools, false);
  assert.equal(noTools.reasoning, false);
});

test("a model with no feature list is assumed capable", () => {
  const m = normalizeModel({ id: "kimi-k3" });
  assert.equal(m.supportsTools, true);
  assert.equal(m.reasoning, true);
});

test("an empty feature list means nothing declared, not nothing supported", () => {
  // The platform lists image-creation models with `[]`, and a chat model whose
  // metadata is not filled in yet would otherwise lose tools and reasoning.
  const m = normalizeModel({ id: "glm-5.2", supported_features: [] });
  assert.equal(m.supportsTools, true);
  assert.equal(m.reasoning, true);

  const unknown = normalizeModel({ id: "brand-new-model", supported_features: [] });
  assert.equal(unknown.supportsTools, true);
  assert.equal(unknown.reasoning, true);
});

test("sampling support decides whether temperature may be sent", () => {
  assert.equal(normalizeModel(DOCUMENTED).supportsTemperature, true);
  const noTemp = normalizeModel({ id: "x", supported_sampling_parameters: ["stop"] });
  assert.equal(noTemp.supportsTemperature, false);
});

test("pricing strings become numbers", () => {
  const m = normalizeModel(DOCUMENTED);
  assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0 });

  const priced = normalizeModel({
    id: "x",
    pricing: { prompt: "0.5", completion: "1.5", input_cache_read: "0.05" },
  });
  assert.deepEqual(priced.cost, { input: 0.5, output: 1.5, cacheRead: 0.05 });
});

test("modalities are read from the documented field names", () => {
  const m = normalizeModel(DOCUMENTED);
  assert.deepEqual(m.inputModalities, ["text", "image"]);
  assert.deepEqual(m.outputModalities, ["text"]);
});

test("entries without an id are dropped", () => {
  assert.equal(normalizeModel({ name: "no id" }), null);
  assert.equal(normalizeModel(null), null);
});

test("the data envelope is unwrapped", () => {
  const models = extractModels({ data: [DOCUMENTED, IMAGE_MODEL] });
  assert.equal(models.length, 2);
  assert.deepEqual(
    models.map((m) => m.id),
    ["sensenova-6.8-flash-lite", "sensenova-u1.5-lite"]
  );
});

test("image-creation models are not chat models", () => {
  assert.equal(isChatModel(normalizeModel(DOCUMENTED)), true);
  assert.equal(isChatModel(normalizeModel(IMAGE_MODEL)), false);
});

test("the module ships no built-in model list", async () => {
  // Models must come from GET /v1/models only; a snapshot would drift from
  // what the account is entitled to.
  const mod = await import("../models.mjs");
  assert.equal(mod.FALLBACK_MODELS, undefined);
});

/* ------------------------------------------------------------- the catalog */

const respond = (body) => async () => ({
  ok: true,
  status: 200,
  json: async () => body,
});

test("a live fetch drops image models", async () => {
  const catalog = createCatalog({ fetchImpl: respond({ data: [DOCUMENTED, IMAGE_MODEL] }) });
  const models = await catalog.load("sk-a");
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "sensenova-6.8-flash-lite");
  assert.equal(catalog.peek()[0].id, "sensenova-6.8-flash-lite");
});

test("one fetch per key inside the refresh window", async () => {
  let calls = 0;
  const catalog = createCatalog({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ data: [DOCUMENTED] }) };
    },
  });
  await catalog.load("sk-a");
  await catalog.load("sk-a");
  assert.equal(calls, 1);
});

test("switching accounts does not reuse the previous list", async () => {
  const seen = [];
  const catalog = createCatalog({
    fetchImpl: async (_url, init) => {
      const key = init.headers.Authorization;
      seen.push(key);
      return {
        ok: true,
        json: async () => ({
          data: [{ ...DOCUMENTED, id: key === "Bearer sk-a" ? "model-a" : "model-b" }],
        }),
      };
    },
  });
  assert.equal((await catalog.load("sk-a"))[0].id, "model-a");
  assert.equal((await catalog.load("sk-b"))[0].id, "model-b");
  assert.deepEqual(seen, ["Bearer sk-a", "Bearer sk-b"]);
});

test("no key means no request", async () => {
  let calls = 0;
  const catalog = createCatalog({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ data: [DOCUMENTED] }) };
    },
  });
  assert.deepEqual(await catalog.load(undefined), []);
  assert.equal(calls, 0);
});

test("a failed fetch throws so the caller can mark the list as remembered", async () => {
  let fail = false;
  const catalog = createCatalog({
    fetchImpl: async () => {
      if (fail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: [DOCUMENTED] }) };
    },
  });
  await catalog.load("sk-a");
  fail = true;
  // A different key bypasses the cache, so the request really is attempted.
  await assert.rejects(() => catalog.load("sk-b"), /HTTP 500/);
  // The good list is still there for the caller to fall back to.
  assert.equal(catalog.peek()[0].id, "sensenova-6.8-flash-lite");
});

test("a fetchImpl that throws synchronously does not poison the key", async () => {
  // The throw settles the async body before the in-flight entry is stored, so
  // cleanup must hang off the promise or the rejected task stays cached and
  // every later load replays it without retrying.
  let calls = 0;
  const catalog = createCatalog({
    fetchImpl: () => {
      calls += 1;
      throw new Error("sync boom");
    },
  });
  await assert.rejects(() => catalog.load("sk-a"), /sync boom/);
  await assert.rejects(() => catalog.load("sk-a"), /sync boom/);
  assert.equal(calls, 2);
});

test("concurrent loads of one key share a single request", async () => {
  let calls = 0;
  const catalog = createCatalog({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ data: [DOCUMENTED] }) };
    },
  });
  const [a, b] = await Promise.all([catalog.load("sk-a"), catalog.load("sk-a")]);
  assert.equal(calls, 1);
  assert.equal(a[0].id, b[0].id);
});

/* --------------------------------------------------- Magpie object shapes */

test("the provider entry carries ids and pricing from the live list", () => {
  const m = normalizeModel({
    ...DOCUMENTED,
    pricing: { prompt: "0.2", completion: "0.8", input_cache_read: "0.02" },
  });
  const p = toProviderModel(m, "sensenova");
  assert.equal(p.id, "sensenova-6.8-flash-lite");
  assert.equal(p.api.id, "sensenova-6.8-flash-lite");
  assert.deepEqual(p.limit, { context: 262144, output: 65536 });
  assert.equal(p.cost.input, 0.2);
  assert.equal(p.cost.output, 0.8);
  assert.equal(p.cost.cache.read, 0.02);
  assert.equal(p.capabilities.toolcall, true);
  assert.equal(p.capabilities.reasoning, true);
  assert.equal(p.capabilities.temperature, true);
  assert.equal(p.capabilities.input.image, true);
});

test("the config entry mirrors the same capabilities", () => {
  const c = toConfigModel(normalizeModel(DOCUMENTED));
  assert.equal(c.tool_call, true);
  assert.equal(c.reasoning, true);
  assert.equal(c.attachment, true);
  assert.deepEqual(c.limit, { context: 262144, output: 65536 });
});
