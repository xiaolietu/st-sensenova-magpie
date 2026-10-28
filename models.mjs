/**
 * Model discovery for SenseNova Token Plan.
 *
 * The Token Plan speaks the OpenAI dialect at `https://token.sensenova.cn/v1`,
 * and `GET /v1/models` is a documented endpoint — it returns `{ data: [ … ] }`
 * with the id, modalities, context window, pricing and capability flags for
 * every model the account can use. That live list is the source of truth.
 *
 * Field names below follow the platform's own `Model` object, not OpenAI's:
 * `context_length` / `max_output_length` (not `max_completion_tokens`), and
 * capability flags arrive as members of `supported_features` rather than as
 * booleans. Reading the OpenAI spellings silently produced nothing, which is
 * how the plugin previously ended up serving its built-in snapshot forever.
 *
 * The snapshot in `FALLBACK_MODELS` only keeps the provider selectable before
 * the first sign-in and when a fetch fails.
 *
 * @module st-sensenova-magpie/models
 */

/** The AI SDK package that speaks the OpenAI-compatible dialect. */
export const NPM = "@ai-sdk/openai-compatible";

/** Token Plan root. Every request path is appended to it. */
export const DEFAULT_BASE_URL = "https://token.sensenova.cn/v1";

/** Abandon a catalog fetch after this long so startup is never held open. */
export const DEFAULT_TIMEOUT_MS = 15000;

/** How long a fetched list is trusted, in hours. */
export const DEFAULT_REFRESH_HOURS = 6;

const DEFAULT_CONTEXT = 131072;
const DEFAULT_OUTPUT = 32768;
const ONE_MILLION = 1048576;

/**
 * The chat models to declare before any network call.
 *
 * Taken from the platform's 模型总览. The two image-creation models
 * (`sensenova-u1.5-lite`, `sensenova-u1.5-fast`) are deliberately absent: they
 * are served by `/v1/images/generations`, not `/v1/chat/completions`, so
 * offering them to a chat provider would only produce failing requests.
 *
 * `sensenova-6.8-flash-lite` carries the context and output ceilings the
 * documented `/v1/models` example publishes; the rest are conservative
 * placeholders that the live list replaces.
 */
export const FALLBACK_MODELS = [
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    contextLength: 262144,
    maxCompletionTokens: 65536,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextLength: DEFAULT_CONTEXT,
    maxCompletionTokens: DEFAULT_OUTPUT,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    contextLength: DEFAULT_CONTEXT,
    maxCompletionTokens: DEFAULT_OUTPUT,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    contextLength: ONE_MILLION,
    maxCompletionTokens: DEFAULT_OUTPUT,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    contextLength: ONE_MILLION,
    maxCompletionTokens: DEFAULT_OUTPUT,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
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
 * Normalize one `Model` object from `GET /v1/models`.
 *
 * @param {object} raw - one entry from the endpoint.
 * @returns {object|null} a normalized model, or null when it has no id.
 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id) ?? text(raw.model_id) ?? text(raw.model);
  if (!id) return null;

  const fallback = FALLBACK_MODELS.find((m) => m.id === id);
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
    name: text(raw.name) ?? text(raw.model_name) ?? fallback?.name ?? id,
    description: text(raw.description),
    contextLength:
      positive(raw.context_length ?? raw.contextLength) ??
      fallback?.contextLength ??
      DEFAULT_CONTEXT,
    maxCompletionTokens:
      positive(raw.max_output_length ?? raw.maxOutputLength ?? raw.max_output_tokens) ??
      fallback?.maxCompletionTokens ??
      DEFAULT_OUTPUT,
    inputModalities: list(raw.input_modalities) ?? fallback?.inputModalities ?? ["text"],
    outputModalities: list(raw.output_modalities) ?? fallback?.outputModalities ?? ["text"],
    // The platform reports capabilities as a list of feature names rather than
    // as per-feature booleans, so membership is the only reliable signal.
    supportsTools: declaresFeatures
      ? features.includes("tools")
      : (fallback?.supportsTools ?? true),
    reasoning: declaresFeatures
      ? features.includes("reasoning")
      : (fallback?.reasoning ?? true),
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

/** Pull a model array out of whatever envelope the endpoint used. */
export function extractModels(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return rows.map(normalizeModel).filter(Boolean);
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

/**
 * A catalog that fetches once per key and caches the result.
 *
 * A failed fetch throws, so the caller can mark what it serves as remembered
 * rather than live; `peek()` keeps returning the last good list throughout.
 *
 * @param {{baseURL?: string, timeoutMs?: number, refreshHours?: number, fetchImpl?: Function}} [opts]
 */
export function createCatalog(opts = {}) {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshMs = (opts.refreshHours ?? DEFAULT_REFRESH_HOURS) * 3600_000;
  const doFetch = opts.fetchImpl ?? fetch;

  /** Per-key cache: switching accounts must not reuse the previous list. */
  const cache = new Map();
  const inflight = new Map();
  let last = null;

  /** The last successful list, or null. Never blocks. */
  const peek = () => last;

  /** Fetch the list, at most once per key per refresh window. */
  const load = async (apiKey) => {
    if (!apiKey) return last ?? [];

    const hit = cache.get(apiKey);
    if (hit && Date.now() - hit.at < refreshMs) return hit.models;
    const running = inflight.get(apiKey);
    if (running) return running;

    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const models = extractModels(await res.json()).filter(isChatModel);
        if (models.length) {
          cache.set(apiKey, { models, at: Date.now() });
          last = models;
        }
        return models.length ? models : (hit?.models ?? last ?? []);
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      // Attached to the promise rather than placed in the async body: a
      // `fetchImpl` that throws synchronously settles the body before
      // `inflight.set` below runs, so an in-body cleanup would delete the key
      // first and leave the rejected promise cached forever — every later load
      // for that key would replay the same failure without retrying.
      inflight.delete(apiKey);
    });

    inflight.set(apiKey, task);
    return task;
  };

  return { peek, load, baseURL };
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
