/**
 * The model list for SenseNova Token Plan, declared statically.
 *
 * **Where the list comes from.** The 模型总览 table in the official docs
 * (https://platform.sensenova.cn/docs) decides which models exist and what
 * they are called; the numbers (`context_length` / `max_output_length` /
 * modalities / `supported_features`) come from a `GET /v1/models` snapshot
 * taken 2026-11-02, because those are the values the chat endpoint enforces.
 * The docs and that endpoint disagree in two places — noted on the entries
 * below — and where they do, the endpoint wins: it is the one answering the
 * request.
 *
 * **Why not call `/v1/models` at runtime.** Three reasons, all measured:
 *
 *   - The endpoint lists what the platform *sells*, not what a plan includes.
 *     `deepseek-v4.1-flash` comes back with metadata identical to
 *     `deepseek-flash`'s and answers `403 model is not available in the
 *     current token plan`. No field tells them apart, so a live list always
 *     advertises at least one model that cannot answer — and that id is not
 *     in the docs' 模型总览 either.
 *   - The endpoint's `name` field is the id (`deepseek-flash`), so the picker
 *     shows raw ids instead of "DeepSeek V4.1 Flash".
 *   - A startup request buys nothing: the catalogue changes on the scale of
 *     model releases, which is the cadence a static list follows. And a list
 *     that cannot fail has no stale-fallback path to get wrong.
 *
 * **Updating it.** Edit `CATALOG`, bump the version in `package.json`, run
 * `node --test test/*.test.mjs`. The tests pin the id set, the display names
 * and the image-model exclusion, so a hasty edit fails loudly.
 *
 * Field names follow the platform's own `Model` object, not OpenAI's:
 * `context_length` / `max_output_length` (not `max_completion_tokens`), and
 * capability flags are members of `supported_features` rather than booleans.
 *
 * @module st-sensenova-magpie/models
 */

/** The AI SDK package that speaks the OpenAI-compatible dialect. */
export const NPM = "@ai-sdk/openai-compatible";

/** Token Plan root. Every request path is appended to it. */
export const DEFAULT_BASE_URL = "https://token.sensenova.cn/v1";

/**
 * Fallbacks for an entry that omits a field.
 *
 * These are not a model list — they only keep one entry usable when something
 * is missing, which the entries below never are.
 */
const DEFAULT_CONTEXT = 131072;
const DEFAULT_OUTPUT = 32768;

/** The capability set the platform reports for every chat model it offers. */
const FULL = ["tools", "json_mode", "reasoning"];

/**
 * Every model the docs' 模型总览 lists, in that page's order.
 *
 * The image-creation models are kept so this stays a description of the
 * platform rather than of this provider, and are filtered out by
 * `chatModels()`: Magpie's plugin system has no image-generation channel, and
 * posting those ids to `/v1/chat/completions` only earns a 404.
 */
const CATALOG = [
  {
    id: "sensenova-6.8-flash",
    name: "SenseNova 6.8 Flash",
    context_length: 262144,
    max_output_length: 65536,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_features: FULL,
  },
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    context_length: 262144,
    max_output_length: 65536,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_features: FULL,
  },
  {
    id: "sensenova-u1.5-lite",
    name: "SenseNova U1.5 Lite",
    context_length: 32768,
    max_output_length: 4096,
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
    supported_features: [],
  },
  {
    id: "sensenova-u1.5-fast",
    name: "SenseNova U1.5 Fast",
    context_length: 32768,
    max_output_length: 4096,
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
    supported_features: [],
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    context_length: 1048576,
    max_output_length: 65536,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: FULL,
  },
  {
    // 文档说它支持图片输入（`content` 用对象数组传 JPEG/PNG/GIF/WebP），
    // 但 `/v1/models` 报的是 `["text"]`。先按接口来，免得打开一个可能被拒的
    // 附件能力；文档若确认了再改这一行。
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    context_length: 1048576,
    max_output_length: 65536,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: FULL,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    context_length: 1048576,
    max_output_length: 131072,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: FULL,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    context_length: 1048576,
    max_output_length: 65536,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: FULL,
  },
];

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);
/** Pricing arrives as strings ("0"); anything unusable counts as free. */
const price = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Normalize one catalogue entry.
 *
 * The entry shape is the platform's own `Model` object, so a line can be
 * pasted straight out of a `/v1/models` response, and the field rules live in
 * exactly one place instead of being duplicated into every entry.
 *
 * @param {object} raw - one entry.
 * @returns {object|null} a normalized model, or null when it has no id.
 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id) ?? text(raw.model_id) ?? text(raw.model);
  if (!id) return null;

  const features = list(raw.supported_features ?? raw.supportedFeatures);
  // An empty array means "nothing declared", not "supports nothing": the
  // platform lists image-creation models with `[]`, and a chat model whose
  // metadata has not been filled in yet would otherwise be reported as having
  // no tools and no reasoning, silently degrading every agent that uses it.
  // Only a non-empty list is treated as an authoritative capability set.
  const declaresFeatures = Array.isArray(features) && features.length > 0;
  const sampling = list(raw.supported_sampling_parameters ?? raw.supportedSamplingParameters);
  const pricing = raw.pricing && typeof raw.pricing === "object" ? raw.pricing : undefined;

  return {
    id,
    name: text(raw.name) ?? text(raw.model_name) ?? id,
    description: text(raw.description),
    contextLength:
      positive(raw.context_length ?? raw.contextLength) ?? DEFAULT_CONTEXT,
    maxCompletionTokens:
      positive(raw.max_output_length ?? raw.maxOutputLength ?? raw.max_output_tokens) ??
      DEFAULT_OUTPUT,
    inputModalities: list(raw.input_modalities) ?? ["text"],
    outputModalities: list(raw.output_modalities) ?? ["text"],
    // The platform reports capabilities as a list of feature names rather than
    // as per-feature booleans, so membership is the only reliable signal.
    supportsTools: declaresFeatures ? features.includes("tools") : true,
    reasoning: declaresFeatures ? features.includes("reasoning") : true,
    supportsJsonMode: declaresFeatures ? features.includes("json_mode") : undefined,
    // Sampling support decides whether the host may send `temperature` at all.
    supportsTemperature: sampling ? sampling.includes("temperature") : true,
    cost: pricing
      ? {
          input: price(pricing.prompt),
          output: price(pricing.completion),
          cacheRead: price(pricing.input_cache_read),
        }
      : undefined,
  };
}

/**
 * Whether a model can serve a chat completion.
 *
 * `/v1/models` also lists the image-creation models, whose output modality is
 * `image` and whose endpoint is `/v1/images/generations`. This provider only
 * speaks `chat/completions`, so those are dropped rather than advertised and
 * left to fail at request time.
 */
export function isChatModel(model) {
  const output = list(model?.outputModalities) ?? ["text"];
  return output.includes("text");
}

/** Every catalogue entry, normalized — chat and image alike. */
export function allModels() {
  return CATALOG.map(normalizeModel).filter(Boolean);
}

/** The entries this provider can serve. */
export function chatModels() {
  return allModels().filter(isChatModel);
}

/* --------------------------------------------------------- Magpie 对象形状 */

function hasNonTextInput(m) {
  return (m.inputModalities ?? []).some((modality) => modality !== "text");
}

function modalityFlags(modalities) {
  const l = list(modalities) ?? ["text"];
  return {
    text: l.includes("text"),
    image: l.includes("image"),
    audio: l.includes("audio"),
    video: l.includes("video"),
    pdf: l.includes("pdf"),
  };
}

/** The `config` entry declaring one model. */
export function toConfigModel(m) {
  return {
    name: m.name,
    reasoning: m.reasoning === true,
    tool_call: m.supportsTools === true,
    attachment: hasNonTextInput(m),
    modalities: { input: m.inputModalities, output: m.outputModalities },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
  };
}

/** The `provider.models` entry for one model. */
export function toProviderModel(m, providerID, { baseURL = DEFAULT_BASE_URL, npm = NPM } = {}) {
  return {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url: baseURL, npm },
    status: "active",
    headers: {},
    options: {},
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cache: { read: m.cost?.cacheRead ?? 0, write: 0 },
    },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
    capabilities: {
      temperature: m.supportsTemperature !== false,
      reasoning: m.reasoning === true,
      attachment: hasNonTextInput(m),
      toolcall: m.supportsTools === true,
      input: modalityFlags(m.inputModalities),
      output: modalityFlags(m.outputModalities),
      interleaved: false,
    },
    release_date: "",
    variants: {},
  };
}
