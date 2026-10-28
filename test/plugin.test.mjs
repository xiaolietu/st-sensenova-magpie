import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SenseNovaPlugin } from "../index.mjs";

/**
 * Run one request through the plugin's `fetch` hook and report what the host's
 * `fetch` actually received. The hook re-reads the sign-in per request, so the
 * stub has to be in place before the call, not before the loader.
 */
async function through(key, input, init) {
  const plugin = await SenseNovaPlugin({}, {});
  const { fetch: wrapped } = await plugin.auth.loader(async () => ({ type: "api", key }));

  const real = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (a, b) => {
    const req = a instanceof Request ? a : null;
    const headers = req ? req.headers : new Headers(b?.headers);
    seen = {
      isRequest: req !== null,
      url: req ? req.url : a,
      method: req ? req.method : b?.method,
      authorization: headers.get("authorization"),
      trace: headers.get("x-trace"),
      body: req ? await req.text() : typeof b?.body === "string" ? b.body : undefined,
    };
    return new Response("{}", { status: 200 });
  };
  try {
    await wrapped(input, init);
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

const BODY = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
const URL_ = "https://token.sensenova.cn/v1/chat/completions";

test("(url, init) 调用：带上 authorization，body 原样透传", async () => {
  const seen = await through("sk-test", URL_, { method: "POST", body: BODY });
  assert.equal(seen.url, URL_);
  assert.equal(seen.method, "POST");
  assert.equal(seen.authorization, "Bearer sk-test");
  assert.equal(seen.body, BODY);
});

test("Request 调用：不能因为改头就把 body 丢掉", async () => {
  // 回归：早先的实现用 `request.url` 重新发起，{...init} 在没有 init 时是空对象，
  // 于是 POST 的 body 静默消失，只剩一个空请求。
  const seen = await through("sk-test", new Request(URL_, { method: "POST", body: BODY }));
  assert.equal(seen.url, URL_);
  assert.equal(seen.method, "POST", "method 必须保留");
  assert.equal(seen.authorization, "Bearer sk-test");
  assert.equal(seen.body, BODY, "body 必须保留");
});

test("Request 调用：保留原请求自己的头", async () => {
  // 断言的是发出去的头，不是转发形状——Request 和 (url, init) 两种形态都该成立。
  const seen = await through("sk-test", new Request(URL_, { method: "POST", body: BODY, headers: { "x-trace": "abc" } }));
  assert.equal(seen.trace, "abc");
  assert.equal(seen.authorization, "Bearer sk-test");
  assert.equal(seen.body, BODY);
});

test("没有 key 时删掉 authorization，而不是留着上一个账号的", async () => {
  const seen = await through(undefined, URL_, {
    method: "POST",
    body: BODY,
    headers: { authorization: "Bearer stale" },
  });
  assert.equal(seen.authorization, null);
  assert.equal(seen.body, BODY);
});

/** The pool-usage response, abbreviated to what the mapping reads. */
const POOL_USAGE = {
  plan: { name: "Free Plan" },
  pools: [
    {
      name: "通用积分池",
      pool_type: "default",
      window_5h: { remaining: "60000", limit: "60000", reset_at: 1791983400 },
      window_7d: { remaining: "591017.32584", limit: "600000", reset_at: 1792000200 },
      grant_balance: "1292155358",
    },
    {
      name: "Flash-Lite积分池",
      pool_type: "dedicated",
      model_ids: ["sensenova-6.8-flash-lite"],
      window_5h: { remaining: "40967.482", limit: "60000", reset_at: 1791983400 },
    },
  ],
};

/** A JWT whose payload decodes, just enough to carry a claim. */
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

/**
 * Run the `usage` hook against a stubbed quota endpoint, with the credentials
 * file pointed at a temp path so the test never reads or writes the real one.
 */
async function usageWith(options, auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensenova-"));
  const file = path.join(dir, "quota.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ base: "https://platform.sensenova.cn", access_token: auth.token, expires_at: 4102444800 })
  );

  const plugin = await SenseNovaPlugin({}, { ...options, credentialsFile: file });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(POOL_USAGE), { status: 200 });
  try {
    return await plugin.auth.usage(async () => ({ type: "api", key: "sk-test", metadata: auth.metadata }));
  } finally {
    globalThis.fetch = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("locale: en 让窗口标签、单位和余额都变英文", async () => {
  const usage = await usageWith({ locale: "en" }, { token: "opaque" });
  assert.equal(usage.plan, "Free Plan");
  assert.equal(usage.balance, "1,292,155,358 credits");
  assert.deepEqual(
    usage.windows.map((w) => w.name),
    ["General Pool · 5h window", "General Pool · This week", "Flash-Lite Dedicated Pool · 5h window"]
  );
  assert.equal(usage.windows[0].unit, "credits");
});

test("locale: zh 保持原样", async () => {
  const usage = await usageWith({ locale: "zh" }, { token: "opaque" });
  assert.equal(usage.balance, "1,292,155,358 积分");
  assert.deepEqual(
    usage.windows.map((w) => w.name),
    ["通用积分池 · 5 小时窗口", "通用积分池 · 本周", "Flash-Lite积分池 · 5 小时窗口"]
  );
});

test("账号行优先用 token 里的账号名，而不是登录时填的账号", async () => {
  // 只填 API Key 时用户拿不到名字；token 里带着它，所以账号行不必显示 API Key。
  const usage = await usageWith({ locale: "en" }, {
    token: jwt({ ext: { username: "Ada" } }),
    metadata: { username: "13800000000" },
  });
  assert.equal(usage.user, "Ada");
});

test("token 里没有名字时退回登录时填的账号", async () => {
  const usage = await usageWith({ locale: "en" }, {
    token: "opaque",
    metadata: { username: "13800000000" },
  });
  assert.equal(usage.user, "13800000000");
});

test("两者都没有时不设 user，交给 Magpie 退回显示 API Key", async () => {
  const usage = await usageWith({ locale: "en" }, { token: "opaque" });
  assert.equal("user" in usage, false);
});

test("提示里不能再问 key，宿主的 key 输入框已经问过一次", async () => {
  // Magpie 给 api 方式自带一个 key 输入框（标题由 label 决定）。之前插件又
  // 自己加了一条 key 提示，结果是登录时同一把 key 被问两遍。
  const plugin = await SenseNovaPlugin({}, {});
  const keys = plugin.auth.methods[0].prompts.map((p) => p.key);
  assert.deepEqual(keys, ["email", "password"]);
  assert.equal(keys.includes("key"), false);

  // 没有 authorize 时 Magpie 才把 key 原样保存成 {type:"api", key}。
  assert.equal(plugin.auth.methods[0].authorize, undefined);
  assert.equal(plugin.auth.methods[0].label, "商汤日日新 API key");
  assert.equal(plugin.auth.methods[0].placeholder, "sk-…");
});

test("供应商显示名与账号提示用中文品牌名", async () => {
  const plugin = await SenseNovaPlugin({}, {});
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.provider.sensenova.name, "商汤日日新");

  const zh = await SenseNovaPlugin({}, { locale: "zh" });
  assert.equal(zh.auth.methods[0].prompts[0].placeholder, "用户名");
  assert.match(zh.auth.methods[0].prompts[0].message, /商汤日日新/);
});

test("账号提问的字段名必须是 email，否则账号行只显示 API Key", async () => {
  // Magpie 依次用 accountId、metadata.email、email 给账号命名，而提示的 key
  // 决定答案落进 metadata 的哪个字段。字段名叫 email 才能在账号行显示用户名；
  // 改成 username 值不会丢（consoleAuthOf 两个都读），但账号行会退化成
  // 「API key …尾4位」。
  const { consoleAuthOf } = await import("../internal.mjs");
  const plugin = await SenseNovaPlugin({}, {});
  assert.equal(plugin.auth.methods[0].prompts[0].key, "email");
  assert.equal(consoleAuthOf({ metadata: { email: " ada " } }).username, "ada");
});

test("两条提示都带本地化后的文案", async () => {
  const en = await SenseNovaPlugin({}, { locale: "en" });
  for (const p of en.auth.methods[0].prompts) {
    assert.ok(typeof p.message === "string" && p.message.length > 0, `${p.key} 缺 message`);
  }
  assert.match(en.auth.methods[0].prompts[1].message, /Optional/, "英文表应生效");
});

test("consoleAuthOf 认 email，也兼容旧的 username / account 拼写", async () => {
  const { consoleAuthOf } = await import("../internal.mjs");
  assert.equal(consoleAuthOf({ metadata: { email: "ada@example.com" } }).username, "ada@example.com");
  // 改字段名前登录的把值存在 username 下，不能因为改名就丢掉那套控制台凭据。
  assert.equal(consoleAuthOf({ metadata: { username: "旧账号" } }).username, "旧账号");
  assert.equal(consoleAuthOf({ metadata: { account: "别名" } }).username, "别名");
  // email 优先，且去空白
  assert.equal(
    consoleAuthOf({ metadata: { email: "  new@x.com  ", username: "old" } }).username,
    "new@x.com"
  );
  assert.equal(consoleAuthOf({ metadata: { email: "   " } }).username, undefined);
  assert.equal(consoleAuthOf(undefined).username, undefined);
});
