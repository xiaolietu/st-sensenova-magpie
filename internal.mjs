/**
 * Helpers shared by the plugin entry and its tests.
 *
 * Kept out of `index.mjs` because OpenCode is a compatibility host and it
 * refuses a plugin module whose entry exports any non-function value. See that
 * file's header.
 *
 * @module st-sensenova-magpie/internal
 */

import { readFileSync } from "node:fs";

/**
 * The provider id, which is also the namespace agents address models by.
 *
 * `sensenova` is the id models.dev publishes for this platform, so Magpie has
 * a description and logo to start from.
 */
export const PROVIDER = "sensenova";

/**
 * The platform's own logo, inlined as a data URI.
 *
 * `assets/sensenova.png` is byte-for-byte `https://platform.sensenova.cn/favicon.ico`
 * — the server labels that response `image/x-icon` but the payload is a 65×65
 * PNG, so the data URI declares `image/png` to match the actual bytes rather
 * than the header.
 *
 * Vendored rather than referenced by URL so the provider stays identifiable
 * with no network and no dependency on the platform continuing to serve it.
 */
function readIcon() {
  try {
    const png = readFileSync(new URL("./assets/sensenova.png", import.meta.url));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Inlined so the provider is identifiable offline. */
export const ICON = readIcon();

/** Strip a pasted `Bearer …` prefix; a blank answer means "no key". */
export function normalizeKey(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^bearer\s+/i, "").trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Read the stored sign-in, tolerating a host that has none. */
export async function readAuth(getAuth) {
  if (typeof getAuth !== "function") return undefined;
  try {
    return await getAuth();
  } catch {
    return undefined;
  }
}

/** The credential out of a stored auth record. */
export function apiKeyOf(auth) {
  if (auth === null || typeof auth !== "object") return undefined;
  return normalizeKey(typeof auth.key === "string" ? auth.key : auth.access);
}

/**
 * Mark a model list as the remembered one rather than a live one.
 *
 * Magpie uses this to tell "the account has these models" apart from "the
 * fetch failed and this is the last thing we knew", so a stale list is not
 * mistaken for an authoritative answer.
 *
 * @param {object} models - the list to mark.
 * @returns {object} a copy carrying the marker.
 */
export function fellBack(models) {
  return { ...models, [Symbol.for("magpie.fellBack")]: true };
}

/**
 * Read the console credentials out of the sign-in record.
 *
 * Magpie keeps the answers a `prompts` method collected under `metadata`, which
 * is how a provider can hold two unrelated credentials at once: the API key
 * that signs the LLM requests, and the SenseNova account that can read the
 * console's quota. Neither is derivable from the other — the platform exposes no
 * API-key-accessible quota endpoint (every candidate path answers 404) — so both
 * have to be stored.
 *
 * @param {object|undefined} auth - the stored auth record.
 * @returns {{username?: string, password?: string, cookie?: string, iamBase?: string}}
 */
export function consoleAuthOf(auth) {
  const meta = auth && typeof auth === "object" ? auth.metadata ?? {} : {};
  const pick = (...keys) => {
    for (const key of keys) {
      const v = meta[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };
  return {
    // The sign-in prompt stores this under `email`, which is the key Magpie
    // reads when naming the account, even though the value is a username.
    // Older sign-ins used `username`, and a few `account`, so all three are read.
    username: pick("email", "username", "account"),
    password: pick("password"),
    cookie: pick("cookie"),
    iamBase: pick("iamBase", "iam_base"),
  };
}
