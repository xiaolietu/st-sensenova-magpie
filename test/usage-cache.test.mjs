/**
 * Tests for the `usage` hook's caching, at the plugin level.
 *
 * The quota mapping itself is covered by `quota.test.mjs`; what these check is
 * the cache in `index.mjs` — that a polled hook costs one request, and that two
 * accounts never share an entry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SenseNovaPlugin } from "../index.mjs";

const makeRes = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (k) => headers[k.toLowerCase()] ?? null,
    getSetCookie: () => [],
  },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

const QUOTA = {
  plan: { id: "free", name: "Free Plan" },
  pools: [
    {
      id: "general",
      name: "通用积分池",
      pool_type: "general",
      model_ids: [],
      grant_balance: 0,
      window_5h: { limit: 100, remaining: 60, reset_at: 1790000000 },
    },
  ],
};

/** Route by URL so the renewal chain and the quota call can both be served. */
function routed(log) {
  return async (url) => {
    const u = String(url);
    log.push(u.replace(/\?.*$/, ""));
    if (u.includes("/oauth2/auth")) {
      return makeRes("", 302, { location: "https://platform.sensenova.cn/cb?code=C&state=x" });
    }
    if (u.includes("/oauth2/token")) {
      return makeRes({ access_token: "AT", refresh_token: "RT", expires_in: 8600 });
    }
    if (u.includes("/tokenplan/pool-usage")) return makeRes(QUOTA);
    return makeRes({}, 404);
  };
}

const quotaCalls = (log) => log.filter((s) => s.includes("pool-usage")).length;

const withAuth = (key, email = "u") => ({
  key,
  metadata: { email, password: "p" },
});

test("一次登录下重复调用 usage 只请求一次额度接口", async () => {
  const log = [];
  globalThis.fetch = routed(log);
  const plugin = await SenseNovaPlugin({}, {});
  const getAuth = async () => withAuth("sk-1");

  await plugin.auth.usage(getAuth);
  await plugin.auth.usage(getAuth);
  await plugin.auth.usage(getAuth);

  assert.equal(quotaCalls(log), 1);
});

test("不同账号各自请求，不共用缓存", async () => {
  const log = [];
  globalThis.fetch = routed(log);
  const plugin = await SenseNovaPlugin({}, {});

  await plugin.auth.usage(async () => withAuth("sk-a", "a"));
  await plugin.auth.usage(async () => withAuth("sk-b", "b"));

  assert.equal(quotaCalls(log), 2);
});

test("续期链路按 authorize → token → 额度 的顺序走", async () => {
  const log = [];
  globalThis.fetch = routed(log);
  const plugin = await SenseNovaPlugin({}, {});

  await plugin.auth.usage(async () => withAuth("sk-1"));

  assert.deepEqual(
    log.map((s) => s.replace("https://platform.sensenova.cn", "")),
    ["/oauth2/auth", "/oauth2/token", "/lite/console/v1/tokenplan/pool-usage"]
  );
});

test("额度读取成功时不上报 error，且带出 plan 与窗口", async () => {
  const log = [];
  globalThis.fetch = routed(log);
  const plugin = await SenseNovaPlugin({}, {});

  const q = await plugin.auth.usage(async () => withAuth("sk-1"));

  assert.equal(q.error, undefined);
  assert.equal(q.plan, "Free Plan");
  assert.equal(q.windows.length, 1);
  assert.equal(q.windows[0].amount, 40);
  assert.equal(q.windows[0].limit, 100);
  assert.equal(q.windows[0].used, 40);
});
