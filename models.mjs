/**
 * Model discovery for SenseNova Token Plan.
 *
 * The Token Plan speaks the OpenAI dialect at `https://token.sensenova.cn/v1`,
 * and its `GET /models` endpoint does answer (401 without a key, not 404), so
 * the live list is the source of truth once an account exists.
 *
 * The built-in snapshot below is what keeps the provider selectable before the
 * first sign-in and when the fetch fails. Its model ids are the ones the
 * platform's own usage report actually emits — read from
 * `credit-usage-trend`'s `series[].model_id` — rather than the marketing names
 * in the announcement, which do not match what goes on the wire.
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

/**
 * The models to declare before any network call.
 *
 * Capability fields are conservative placeholders: the live `/models` response
 * replaces them when it carries metadata, and the platform does not document
 * per-model context or output ceilings publicly. Only the ids and the
 * multimodal flag on Flash-Lite are taken from observed platform behaviour.
 */
export const FALLBACK_MODELS = [
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    contextLength: DEFAULT_CONTEXT,
    maxCompletionTokens: DEFAULT_OUTPUT,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    contextLength: DEFAULT_CONTEXT,
    maxCompletionTokens: DEFAULT_OUTPUT,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    contextLength: DEFAULT_CONTEXT,
    maxCompletionTokens: DEFAULT_OUTPUT,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    contextLength: DEFAULT_CONTEXT,
    maxCompletionTokens: DEFAULT_OUTPUT,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
];

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);

/**
 * Normalize one raw model entry from any of the shapes the endpoint may use.
 *
 * The response format is not documented, so both OpenAI's `{data:[…]}` and a
 * bare array are accepted, and capability fields are read under either the
 * snake_case or camelCase spelling.
 *
 * @param {object} raw - one entry from the endpoint.
 * @returns {object|null} a normalized model, or null when it has no id.
 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id) ?? text(raw.model_id) ?? text(raw.model);
  if (!id) return null;
  const fallback = FALLBACK_MODELS.find((m) => m.id === id);
  return {
    id,
    name: text(raw.name) ?? text(raw.model_name) ?? fallback?.name ?? id,
    contextLength:
      positive(raw.context_length ?? raw.contextLength ?? raw.max_context_tokens) ??
      fallback?.contextLength ??
      DEFAULT_CONTEXT,
    maxCompletionTokens:
      positive(raw.max_completion_tokens ?? raw.maxCompletionTokens ?? raw.max_output_tokens) ??
      fallback?.maxCompletionTokens ??
      DEFAULT_OUTPUT,
    inputModalities:
      list(raw.input_modalities ?? raw.inputModalities) ?? fallback?.inputModalities ?? ["text"],
    outputModalities:
      list(raw.output_modalities ?? raw.outputModalities) ?? fallback?.outputModalities ?? ["text"],
    supportsTools:
      raw.supports_tools ?? raw.supportsTools ?? raw.tool_call ?? fallback?.supportsTools ?? true,
    reasoning: raw.reasoning ?? raw.supports_reasoning ?? fallback?.reasoning ?? true,
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
 * A catalog that fetches once, caches, and never throws.
 *
 * @param {{baseURL?: string, timeoutMs?: number, refreshHours?: number, fetchImpl?: Function}} [opts]
 */
export function createCatalog(opts = {}) {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshMs = (opts.refreshHours ?? DEFAULT_REFRESH_HOURS) * 3600_000;
  const doFetch = opts.fetchImpl ?? fetch;

  let cached = null;
  let fetchedAt = 0;
  let inflight = null;

  /** The last successful list, or null. Never blocks. */
  const peek = () => cached;

  /** Fetch the list, at most once per refresh window. */
  const load = async (apiKey) => {
    const fresh = cached && Date.now() - fetchedAt < refreshMs;
    if (fresh) return cached;
    if (inflight) return inflight;
    if (!apiKey) return cached ?? [];

    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const models = extractModels(await res.json());
        if (models.length) {
          cached = models;
          fetchedAt = Date.now();
        }
        return models.length ? models : cached ?? [];
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();

    return inflight;
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
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
    capabilities: {
      temperature: true,
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
