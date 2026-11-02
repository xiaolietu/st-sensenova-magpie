/**
 * Tests for the `usage` hook's caching, at the plugin level.
 *
 * The quota mapping itself is covered by `quota.test.mjs`; what these check is
 * the cache in `index.mjs` — that a polled hook costs one request, and that two
 * accounts never share an entry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("凭据文件里的 id_token 仍能给出账号名", async () => {
  // The access token can be opaque; the name then only exists in id_token.
  // Dropping it on read loses the account name on every start.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-creds-"));
  const file = path.join(dir, "creds.json");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const idToken = `${b64({ alg: "none" })}.${b64({ id_token: { username: "账号真名" } })}.sig`;

  fs.writeFileSync(
    file,
    JSON.stringify({
      access_token: "opaque-not-a-jwt",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      id_token: idToken,
    })
  );

  try {
    globalThis.fetch = routed([]);
    const plugin = await SenseNovaPlugin({}, { credentialsFile: file });
    const q = await plugin.auth.usage(async () => ({ key: "sk-1" }));
    assert.equal(q.user, "账号真名");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------ 额度失败不得连坐账号 */

const signedIn = (log) => [
  log.filter((s) => s.includes("/oauth2/auth")).length,
  log.filter((s) => s.includes("/oauth2/token")).length,
];

test("额度读取失败时返回 signIn: kept，避免 Magpie 把整个账号标记为需重新登录", async () => {
  // 额度只是账号行上的一行字。它的失败（控制台令牌过期、IAM 拒绝密码登录）
  // 和模型请求用的 API Key 毫无关系；不上报 kept 的话，Magpie 会按 error 文案
  // 判定「登录被拒绝」，把这个账号整个停用，界面上就是「账号掉了」。
  globalThis.fetch = async (url) =>
    String(url).includes("pool-usage") ? makeRes({ message: "boom" }, 500) : routed([])(url);
  const plugin = await SenseNovaPlugin({}, {});

  const q = await plugin.auth.usage(async () => withAuth("sk-1"));

  assert.ok(q.error, "应该带 error");
  assert.equal(q.signIn, "kept");
});

test("没有控制台凭据时也是 kept，而不是让用户重新登录", async () => {
  globalThis.fetch = routed([]);
  const plugin = await SenseNovaPlugin({}, {});
  const q = await plugin.auth.usage(async () => ({ key: "sk-1" }));
  assert.ok(q.error);
  assert.equal(q.signIn, "kept");
});

test("续期后的控制台令牌留在内存里，下一个轮询不再重新登录一次", async () => {
  // 登录时填了账号密码、本机又没有 snquota 的凭据文件时，缓存过期后重建的
  // 凭据里没有任何令牌，于是每一次轮询都是一整套密码登录。IAM 会把它当
  // 风控对象，最后以 403 拒绝——这正是「用了几天账号就掉了」的来源。
  const log = [];
  globalThis.fetch = routed(log);
  const plugin = await SenseNovaPlugin({}, { quotaTtlMs: 1 });

  await plugin.auth.usage(async () => withAuth("sk-1"));
  await new Promise((r) => setTimeout(r, 10));
  await plugin.auth.usage(async () => withAuth("sk-1"));

  assert.deepEqual(signedIn(log), [1, 1], "整套登录只应发生一次");
  assert.equal(quotaCalls(log), 2, "额度本身仍然照常刷新");
});

test("失败后退避重试，不再每 15 秒重打一次登录接口", async () => {
  // 一次失败后每 15 秒重试一次，而每次重试都是一整套密码登录——这是 IAM 最终
  // 以 403 拒绝的直接原因。退避从 60 秒起翻倍，所以 16 秒后仍然不该重试。
  const log = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    log.push(u.replace(/\?.*$/, ""));
    if (u.includes("pool-usage")) return makeRes({ message: "boom" }, 500);
    return routed([])(url);
  };
  const plugin = await SenseNovaPlugin({}, { quotaTtlMs: 1 });

  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await plugin.auth.usage(async () => withAuth("sk-1"));
    const first = quotaCalls(log);
    assert.equal(first, 1);

    clock += 16_000;
    await plugin.auth.usage(async () => withAuth("sk-1"));
    assert.equal(quotaCalls(log), first, "16 秒时不应重试（老实现会）");
    assert.deepEqual(signedIn(log), [1, 1], "也不该重登");

    clock += 50_000;
    await plugin.auth.usage(async () => withAuth("sk-1"));
    assert.equal(quotaCalls(log), 2, "过了 60 秒应该重试");
  } finally {
    Date.now = realNow;
  }
});

test("登录本身被拒绝时退避更久，不再按分钟级别反复尝试密码登录", async () => {
  // 密码登录被拒是「等用户重新登录」才能恢复的状态，自己不会好。按 15 分钟
  // 反复打 IAM 既没用，又可能把账号锁得更死，所以这一类退避到 2 小时。
  const log = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    log.push(u.replace(/\?.*$/, ""));
    if (u.includes("/oauth2/auth")) return makeRes("", 302, { location: "https://x/cb?code=C&state=x" });
    if (u.includes("/oauth2/token")) return makeRes({ error: "invalid_grant" }, 400);
    return makeRes({}, 404);
  };
  const plugin = await SenseNovaPlugin({}, { quotaTtlMs: 1 });
  const attempts = () => log.filter((s) => s.includes("/oauth2/auth")).length;

  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    // 连续失败把退避推到封顶（每次跳 2 小时，必定超过当时的等待时间）
    for (let i = 0; i < 10; i++) {
      await plugin.auth.usage(async () => withAuth("sk-1"));
      if (i < 9) clock += 2 * 60 * 60_000;
    }
    const capped = attempts();
    assert.equal(capped, 10, "十次尝试都应真的发出了");

    // 封顶后 2 小时内不该再试
    clock += 30 * 60_000;
    await plugin.auth.usage(async () => withAuth("sk-1"));
    assert.equal(attempts(), capped, "封顶后半小时内不该再登录");

    clock += 100 * 60_000;
    await plugin.auth.usage(async () => withAuth("sk-1"));
    assert.equal(attempts(), capped + 1, "过了 2 小时才重试");
  } finally {
    Date.now = realNow;
  }
});
