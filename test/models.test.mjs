/**
 * Tests for the static catalogue and the Magpie object shapes built from it.
 *
 * The list itself is pinned deliberately: a model got dropped, renamed or
 * reordered by an edit that did not mean to is exactly the kind of change that
 * silently breaks someone's agent, and it is invisible without a test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allModels,
  chatModels,
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

/* ------------------------------------------------------------- the catalogue */

test("catalogue 就是文档模型总览里的那六个对话模型，顺序一致", () => {
  assert.deepEqual(
    chatModels().map((m) => m.id),
    [
      "sensenova-6.8-flash",
      "sensenova-6.8-flash-lite",
      "deepseek-v4-flash",
      "deepseek-flash",
      "glm-5.2",
      "kimi-k3",
    ]
  );
});

test("显示名取自文档，而不是接口里那个和 id 相同的 name", () => {
  // /v1/models 的 name 就是 id，选择器里会显示 deepseek-flash。文档给了真名。
  const names = Object.fromEntries(chatModels().map((m) => [m.id, m.name]));
  assert.equal(names["deepseek-flash"], "DeepSeek V4.1 Flash");
  assert.equal(names["deepseek-v4-flash"], "DeepSeek V4 Flash");
  assert.equal(names["glm-5.2"], "GLM-5.2");
  assert.equal(names["sensenova-6.8-flash-lite"], "SenseNova 6.8 Flash Lite");
});

test("不在文档总览里的幽灵 id 不会出现在清单里", () => {
  // deepseek-v4.1-flash 在 /v1/models 里，元数据与 deepseek-flash 完全一致，
  // 但请求必定 403，文档也从未列过它。
  const ids = allModels().map((m) => m.id);
  assert.equal(ids.includes("deepseek-v4.1-flash"), false);
  assert.equal(ids.includes("deepseek-flash"), true);
});

test("生图模型不在清单里：Magpie 没有生图通道，留着只会写错", () => {
  // 实测：u1.5-fast 已从 /v1/models 消失，u1.5-lite 的上限与文档不一致。
  // 既然这两个模型永远不可能被这个供应商提供，就不写进清单。
  const ids = allModels().map((m) => m.id);
  assert.equal(ids.includes("sensenova-u1.5-lite"), false);
  assert.equal(ids.includes("sensenova-u1.5-fast"), false);
  assert.equal(allModels().length, chatModels().length);
  assert.equal(chatModels().some((m) => m.outputModalities.includes("image")), false);
});

test("上下文与输出上限按接口口径写死在条目里", () => {
  const by = Object.fromEntries(chatModels().map((m) => [m.id, m]));
  assert.deepEqual(
    [by["sensenova-6.8-flash-lite"].contextLength, by["sensenova-6.8-flash-lite"].maxCompletionTokens],
    [262144, 65536]
  );
  assert.deepEqual(
    [by["deepseek-v4-flash"].contextLength, by["deepseek-v4-flash"].maxCompletionTokens],
    [1048576, 65536]
  );
  // GLM-5.2 是唯一输出上限到 131072 的对话模型
  assert.equal(by["glm-5.2"].maxCompletionTokens, 131072);
});

test("每个对话模型都声明了工具与推理能力", () => {
  for (const m of chatModels()) {
    assert.equal(m.supportsTools, true, `${m.id} 少了 tools`);
    assert.equal(m.reasoning, true, `${m.id} 少了 reasoning`);
    assert.equal(m.supportsJsonMode, true, `${m.id} 少了 json_mode`);
  }
});

/* --------------------------------------------------------------- the normalizer */

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

test("image-creation models are not chat models", () => {
  assert.equal(isChatModel(normalizeModel(DOCUMENTED)), true);
  assert.equal(isChatModel(normalizeModel(IMAGE_MODEL)), false);
});

/* --------------------------------------------------- Magpie object shapes */

test("the provider entry carries ids and pricing from the entry", () => {
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
