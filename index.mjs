/**
 * SenseNova（商汤 · 日日新）provider plugin for Magpie.
 *
 * Two things in one package, because the platform splits them across two hosts:
 *
 *   - **The provider.** Token Plan speaks the OpenAI dialect at
 *     `https://token.sensenova.cn/v1`, so serving requests is the ordinary
 *     `@ai-sdk/openai-compatible` path and the `fetch` hook forwards untouched.
 *
 *   - **The quota.** The 积分额度 that the console shows lives on a different
 *     API entirely — `platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`
 *     — behind an OAuth bearer token, not an API key. No API-key-accessible
 *     quota endpoint exists on this platform, so the two credentials are
 *     genuinely separate and both are collected at sign-in.
 *
 * The quota is reported through `auth.usage`, which is the only channel Magpie
 * offers: plugins cannot add panels or pages, and nothing feeds the 用量概览
 * analytics page. What `auth.usage` returns is rendered on the provider's
 * account row, in `magpie quota`, and at the gateway's `GET /v1/magpie/quotas`.
 *
 * This file exports **exactly one function, and nothing else**, so the module
 * also loads under OpenCode, which refuses an entry exporting any non-function
 * value. Helpers live in `internal.mjs`, `quota.mjs` and `models.mjs`.
 *
 * @module st-sensenova-magpie
 */

import { PROVIDER, ICON, apiKeyOf, consoleAuthOf, readAuth } from "./internal.mjs";
import { DEFAULT_BASE_URL, NPM, allModels, toConfigModel, toProviderModel } from "./models.mjs";
import { accountNameOf, QuotaError, readCredentials, readQuota, writeCredentials } from "./quota.mjs";
import { fill, resolveLocale, strings as tableFor } from "./i18n.mjs";

const DEFAULT_QUOTA_TTL_MS = 60_000;

/**
 * How long a failed quota read waits before being retried, doubling each time.
 *
 * The old behaviour retried 15 seconds after a failure. When the console
 * credentials are a username and password the user typed at sign-in, every
 * retry is a complete OAuth password login, so a single bad refresh token
 * turns into four logins a minute — which is what makes IAM start answering
 * 403. One minute, doubling, is fast enough for a transient blip and slow
 * enough to look like a browser tab.
 *
 * A failure the whole renewal chain produced (`kind: "auth"`, i.e. the console
 * login itself was refused) backs off much further. That state does not heal
 * on its own — it heals when the user signs in again — so retrying it every
 * quarter of an hour is pure noise and, if IAM is rate-limiting, keeps the
 * account locked.
 */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const RETRY_AUTH_MAX_MS = 2 * 60 * 60_000;

/**
 * Build the plugin.
 *
 * @param {{client?: object}} input - the plugin input the host passes.
 * @param {object} [options] - the `options` field from `plugins.json`.
 * @returns {Promise<object>} the hooks the host calls.
 */
export async function SenseNovaPlugin({ client } = {}, options = {}) {
  const locale = resolveLocale(options.locale);
  const t = tableFor(locale);
  const opts = {
    baseURL: options.baseURL ?? undefined,
    quotaTtlMs: Number(options.quotaTtlMs) > 0 ? Number(options.quotaTtlMs) : DEFAULT_QUOTA_TTL_MS,
    scopeModel: typeof options.scopeModel === "string" ? options.scopeModel : "flash-lite",
    credentialsFile: options.credentialsFile ?? undefined,
  };

  const log = (level, message) => {
    try {
      client?.app?.log?.({ body: { service: "sensenova", level, message } });
    } catch {
      /* the host's logger is best-effort */
    }
  };

  /**
   * Console tokens minted during this run, per account.
   *
   * Without this, `credentialsFor` rebuilds the credentials from disk on every
   * poll, so a token that was just renewed is thrown away and the next poll
   * renews again — and when the account was typed at sign-in there is no file
   * to write to, so "renew" means a full password login through IAM. That is
   * one complete OAuth login per `quotaTtlMs` (or per retry), which the IAM
   * eventually answers with 403 and Magpie reads as "the sign-in was rejected".
   *
   * In memory only: writing credentials the user only typed into a prompt to
   * disk is the `snquota` file's job, not this plugin's.
   */
  const tokenCache = new Map();

  /** Keep a renewed token so the next poll starts from it instead of from disk. */
  const rememberTokens = (key, cfg) => {
    tokenCache.set(key, {
      access_token: cfg.access_token,
      refresh_token: cfg.refresh_token,
      id_token: cfg.id_token,
      expires_at: cfg.expires_at,
    });
  };

  /**
   * Models the upstream has refused for an account, per API key.
   *
   * `/v1/models` answers "what does the platform sell", not "what does this
   * plan include" — and it carries no field to tell them apart. Measured on a
   * Free Plan account: `deepseek-v4.1-flash` and `deepseek-flash` come back
   * with identical context, features and pricing, yet the first answers
   * `403 model is not available in the current token plan` while the second
   * works. The only trustworthy signal is the refusal itself, so it is
   * remembered here and the id is dropped from the next model list.
   *
   * Memory only, and keyed per account: a plan upgrade takes effect when the
   * process restarts, which is the right trade against storing a wrong "no"
   * on disk forever.
   */
  const refusedModels = new Map();

  /**
   * Note a model the upstream refused, without touching the response itself.
   *
   * The body is read off a clone — the original has to reach the host
   * untouched, stream included — and only the exact refusal counts, because a
   * 403 also covers reasons that are not about the plan at all.
   */
  const noteRefusedModel = (key, init, res) => {
    let model;
    try {
      model = JSON.parse(typeof init?.body === "string" ? init.body : "{}")?.model;
    } catch {
      return;
    }
    if (!key || typeof model !== "string" || !model) return;
    res
      .clone()
      .text()
      .then((body) => {
        if (!/not available in the current token plan|model is not found/i.test(body)) return;
        const blocked = refusedModels.get(key) ?? new Set();
        blocked.add(model);
        refusedModels.set(key, blocked);
        log("warn", `sensenova: ${model} is not in this account's plan; hiding it`);
      })
      .catch(() => {
        /* 读不到就算了，下次请求还有机会 */
      });
  };

  /**
   * Record why a 429 happened, once per model per code.
   *
   * All four throttle reasons arrive with the same message — "inference
   * exceeds tpm/rpm limit" — and only `error.code` separates "burst, retry in
   * a second" from "this model's quota is spent until it is topped up".
   * Magpie shows that message to the user, so without this line nothing
   * anywhere says which one it was. Log once per code so a flapping model
   * cannot flood the log.
   */
  const notedCodes = new Map();
  const noteRateLimit = (key, init, res) => {
    let model;
    try {
      model = JSON.parse(typeof init?.body === "string" ? init.body : "{}")?.model;
    } catch {
      return;
    }
    if (!key || typeof model !== "string" || !model) return;
    res
      .clone()
      .text()
      .then((body) => {
        let code;
        try {
          code = JSON.parse(body)?.error?.code;
        } catch {
          return;
        }
        if (typeof code !== "string" || !code || notedCodes.get(`${key}|${model}`) === code) return;
        notedCodes.set(`${key}|${model}`, code);
        log("warn", `sensenova: ${model} answered 429 ${code}`);
      })
      .catch(() => {
        /* 读不到就算了，本来只是诊断信息 */
      });
  };

  /**
   * The credential pair for one account.
   *
   * The console credentials come from the sign-in prompts when the user
   * supplied them, and otherwise from the file the `snquota` CLI writes. The
   * fallback matters because the console login is a multi-step OAuth flow that
   * the CLI already drives, including keeping the token fresh; asking for the
   * same account twice would be worse than reusing that file.
   */
  const credentialsFor = (auth, cacheKey) => {
    const fromAuth = consoleAuthOf(auth);
    const fromFile = readCredentials(opts.credentialsFile) ?? {};
    // A token renewed during this run outranks the file: it is the newest one
    // this process has, and for a prompted account it is the only one.
    const remembered = (cacheKey && tokenCache.get(cacheKey)) || {};
    return {
      base: fromFile.base,
      client_id: fromFile.client_id,
      redirect_uri: fromFile.redirect_uri,
      access_token: remembered.access_token ?? fromFile.access_token,
      refresh_token: remembered.refresh_token ?? fromFile.refresh_token,
      // Kept so `accountNameOf` can still name the account when the access
      // token is opaque rather than a JWT. `applyToken` writes this back to
      // the file, so dropping it here would make the stored copy dead weight
      // and lose the name on the next start.
      id_token: remembered.id_token ?? fromFile.id_token,
      expires_at: remembered.expires_at ?? fromFile.expires_at,
      cookie: fromAuth.cookie ?? fromFile.cookie,
      username: fromAuth.username ?? fromFile.username,
      password: fromAuth.password ?? fromFile.password,
      iam_base: fromAuth.iamBase ?? fromFile.iam_base,
      // Only the file is written back: a token minted here would otherwise
      // silently replace the CLI's copy on the next read.
      __writable: !fromAuth.username && !fromAuth.cookie,
      __file: opts.credentialsFile,
    };
  };

  /**
   * Cache quota per account so a polled hook costs one request a minute.
   *
   * `nextAt` is when this account may be read again, and `streak` counts
   * consecutive failures so the wait can double. A success resets the streak;
   * a failure keeps serving the last error to every poll until `nextAt`, which
   * is what keeps a broken console login from being retried on every tick.
   */
  const quotaCache = new Map();

  /**
   * What Magpie puts on the account row.
   *
   * Magpie shows `user` when the hook supplies it and falls back to labelling the
   * account by its API key when it does not. The console tokens carry the
   * account's own display name, which is the name the console's header shows and
   * therefore the one a user recognises; the account typed at sign-in is a phone
   * number or an email, which is what the user logged in with rather than who
   * they are. So the token's name wins, the typed account is the fallback, and
   * only when neither exists does Magpie fall back to the API key.
   */
  const accountLabel = (cfg) => accountNameOf(cfg) ?? cfg.username;

  const quotaFor = async (getAuth) => {
    const auth = await readAuth(getAuth);
    const cacheKey = apiKeyOf(auth) ?? consoleAuthOf(auth).username ?? "sensenova";
    const now = Date.now();
    const hit = quotaCache.get(cacheKey);
    if (hit && now < hit.nextAt) return hit.value;

    const cfg = credentialsFor(auth, cacheKey);
    if (!cfg.access_token && !cfg.refresh_token && !cfg.cookie && !cfg.password) {
      // `signIn: "kept"`: this is a missing-console-credentials problem, not a
      // rejected sign-in. Without it Magpie reads the message (which mentions
      // signing in) as "the account needs to log in again", marks the account,
      // and stops routing model requests through it — a quota read that only
      // decorates the account row would take the whole provider down.
      const value = { error: t.noAccount, signIn: "kept" };
      quotaCache.set(cacheKey, { nextAt: Date.now() + opts.quotaTtlMs, streak: 0, value });
      return value;
    }

    try {
      const { quota, changed } = await readQuota(cfg, { scopeModel: opts.scopeModel, strings: t });
      if (changed) rememberTokens(cacheKey, cfg);
      if (changed && cfg.__writable) writeCredentials(cfg, cfg.__file);
      // 套餐名用接口给的（实际是 "Free Plan"），拿不到才退回通用叫法。
      const { plan, ...rest } = quota;
      const user = accountLabel(cfg);
      const value = {
        plan: plan ?? t.planFallback,
        ...(user ? { user } : {}),
        ...rest,
      };
      quotaCache.set(cacheKey, { nextAt: Date.now() + opts.quotaTtlMs, streak: 0, value });
      return value;
    } catch (error) {
      // A rejected or unreachable console token says nothing about the API
      // key that actually serves model requests, so every failure here is
      // reported with `signIn: "kept"` — see the note above.
      const authFailed = error instanceof QuotaError && error.kind === "auth";
      // A token the console refused is worse than useless: keeping it would
      // make the next attempt fail the same way without ever re-deriving the
      // credentials from the file (or from the password) they came from.
      if (authFailed) tokenCache.delete(cacheKey);

      // A failed read must not be cached for the full TTL: the next poll is
      // exactly when a token that just expired should be retried. It must not
      // be retried hot either — a broken console login hammered every 15s is
      // what makes IAM answer 403 in the first place, so the wait doubles and
      // caps out at RETRY_MAX_MS (RETRY_AUTH_MAX_MS when the login itself is
      // what failed).
      const streak = (hit?.streak ?? 0) + 1;
      const cap = authFailed ? RETRY_AUTH_MAX_MS : RETRY_MAX_MS;
      const wait = Math.min(RETRY_BASE_MS * 2 ** (streak - 1), cap);
      const user = accountLabel(cfg);
      const value = {
        plan: t.planFallback,
        ...(user ? { user } : {}),
        error: error instanceof QuotaError ? error.message : fill(t.readFailed, { detail: error.message }),
        signIn: "kept",
      };
      quotaCache.set(cacheKey, { nextAt: Date.now() + wait, streak, value });
      log("warn", `sensenova: quota read failed: ${error.message}`);
      return value;
    }
  };

  return {
    /**
     * Declare the provider and its models.
     *
     * The list is static (see `models.mjs`), so it is declared here as well as
     * returned from `provider.models`: that way the models are visible before
     * anyone signs in, and `magpie plugin --json` can list them.
     *
     * `...was` keeps whatever the user set in `plugins.json`, but the model
     * map is always this plugin's — it is the only thing that knows what the
     * ids are called.
     */
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        name: "商汤日日新",
        npm: NPM,
        api: opts.baseURL ?? DEFAULT_BASE_URL,
        ...was,
        models: Object.fromEntries(allModels().map((m) => [m.id, toConfigModel(m)])),
      };
    },

    provider: {
      id: PROVIDER,
      /**
       * The models this account can use.
       *
       * The catalogue is static, so this hook does one job: drop the ids the
       * upstream has already refused for *this* account with `not available in
       * the current token plan`. The list is per plan, and the static one is
       * per platform — a Free account and a paid one get different subsets of
       * the same catalogue, and the only signal either way is the refusal.
       *
       * Image models are included. Their `capabilities.output.image` tells
       * Magpie which endpoint they belong to, and the request they produce
       * (`POST {baseURL}/images/generations`) is forwarded by the `fetch` hook
       * like any other.
       */
      async models(provider, { auth } = {}) {
        const id = provider?.id ?? PROVIDER;
        const baseURL = opts.baseURL ?? DEFAULT_BASE_URL;
        const key = apiKeyOf(auth);
        const blocked = (key && refusedModels.get(key)) || null;
        return Object.fromEntries(
          allModels()
            .filter((m) => !blocked || !blocked.has(m.id))
            .map((m) => [m.id, toProviderModel(m, id, { baseURL })])
        );
      },
    },

    auth: {
      provider: PROVIDER,
      ...(ICON === undefined ? {} : { icon: ICON }),

      /**
       * The account, resolved into request routing.
       *
       * There is no body repair here — unlike a gateway that rejects an empty
       * `tools` array, Token Plan accepts the OpenAI shapes as sent.
       */
      async loader(getAuth) {
        const key = apiKeyOf(await readAuth(getAuth));
        return {
          baseURL: opts.baseURL ?? DEFAULT_BASE_URL,
          apiKey: key,
          async fetch(input, init) {
            // Re-read per request so a sign-in that changes mid-session is
            // picked up without waiting for the loader to re-run.
            const current = apiKeyOf(await readAuth(getAuth));
            const source = input instanceof Request ? input : null;
            const headers = new Headers(init?.headers ?? source?.headers);
            if (current === undefined) headers.delete("authorization");
            else headers.set("authorization", `Bearer ${current}`);
            // A Request carries its own body, and re-issuing one by URL alone
            // silently drops it — so clone it instead of rebuilding the call.
            const res = source
              ? await fetch(new Request(source, { ...init, headers }))
              : await fetch(input, { ...init, headers });
            if (res.status === 403) noteRefusedModel(current, init, res);
            else if (res.status === 429) noteRateLimit(current, init, res);
            return res;
          },
        };
      },

      /**
       * The 积分额度, as the provider card shows it.
       *
       * SenseNova's pools map onto Magpie's window model directly: the 5-hour
       * window is 18000 seconds, the weekly one 604800, and the Flash-Lite pool
       * is scoped to its own model family. The 活动固定积分 balance has no
       * window, so it is reported as `balance`.
       */
      async usage(getAuth) {
        return quotaFor(getAuth);
      },

      /**
       * One method: an API key, plus the console account that can read quota.
       *
       * The key is **not** asked for here. Magpie gives an `api` method its own
       * key field, titled by `label`, and saves that value as `{type: "api",
       * key}` when the method has no `authorize` — a prompt for the key would
       * ask the same question a second time, which is exactly what it used to
       * do. The prompts below are only the extra questions, asked before
       * signing in; their answers land in `metadata`.
       *
       * The console fields are optional and only asked for once, because the
       * quota endpoint has no API-key path. Leaving them blank falls back to
       * whatever `snquota` already stored on this machine.
       *
       * A pasted `Bearer …` prefix is stripped at request time by `apiKeyOf`,
       * so the stored value does not have to be cleaned up here.
       */
      methods: [
        {
          type: "api",
          label: "商汤日日新 API key",
          placeholder: "sk-…",
          prompts: [
            {
              type: "text",
              // `email` 而不是 `username`：这是 Magpie 的硬性命名规则决定的。
              //
              // Magpie 给账号命名只认 `accountId` → `metadata.email` → `email`，
              // 而提示项的 `key` 决定答案落进 `metadata` 的哪个字段。把字段命名
              // 成 `email`，账号行才会显示用户填的用户名；命名成 `username` 就
              // 会掉到兜底，显示成 `API key …HohJ`。
              //
              // 字段名叫 email、装的是用户名 —— 这是为了显示不得不做的妥协，
              // 不是笔误。值本身不会丢：`consoleAuthOf` 两个拼写都读。
              key: "email",
              message: t.promptAccount,
              placeholder: t.placeholderAccount,
            },
            {
              type: "text",
              key: "password",
              message: t.promptPassword,
              placeholder: t.placeholderPassword,
            },
          ],
        },
      ],
    },
  };
}
