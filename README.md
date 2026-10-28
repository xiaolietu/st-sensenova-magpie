# st-sensenova-magpie

> 本仓库是 [aqiu817/magpie-sensenova](https://github.com/aqiu817/magpie-sensenova) 的独立维护分支。
> 采用 MIT 许可，原始版权声明保留在 [LICENSE](LICENSE) 中。
> 本仓库独立维护，不跟随上游同步。

一个给 [Magpie](https://usemagpie.ai) 用的 **SenseNova（商汤 · 商量 / 日日新）** 供应商插件：把 Token Plan 的模型接进来，并把控制台的**积分额度**上报成 Magpie 原生的额度窗口。

```
$ magpie quota
sensenova  通用积分池 · 5 小时窗口   0% used ↻ 2h  ·  Flash-Lite积分池 · 5 小时窗口  22.8% used ↻ 2h
```

窗口名称来自平台自己的积分池命名，由本插件转译 —— 详见第三节「配置项」里的 `locale`。上面是中文默认效果。

---

## 一、这个插件做两件事

平台的这两部分不在同一个地方，所以插件同时承担两项职责：

| | 地址 | 认证方式 |
| --- | --- | --- |
| **模型调用** | `https://token.sensenova.cn/v1`（OpenAI 兼容） | API Key |
| **积分额度** | 控制台主机上的一个内部接口 | 控制台 OAuth 令牌 |

**平台没有提供任何可以用 API Key 读取额度的接口。** 逐个试过十几个候选路径（`/v1/llm/usage`、`/v1/llm/quota`、`/v1/llm/balance`、`/v1/dashboard/billing/subscription` 等），全部返回 404；额度只存在于控制台前端自己调用的那个接口后面，需要 Ory 的 bearer 令牌。

因此这两套凭据是**真正独立的**，插件在登录时分别收集。

### 使用的接口协议

模型请求走的是 **OpenAI Chat Completions**：

```
POST https://token.sensenova.cn/v1/chat/completions
```

协议由 `npm` 字段决定，代码里是 `models.mjs` 的常量 `NPM = "@ai-sdk/openai-compatible"`。Magpie 的映射规则是：除 Anthropic / OpenAI Responses / Gemini 之外的一切包，一律走 chat completions。

SenseNova 另外还提供两种兼容端点，**本插件均未使用**：

| 协议 | 端点 | 说明 |
| --- | --- | --- |
| OpenAI Chat Completions | `/v1/chat/completions` | **当前使用** |
| OpenAI Responses | `/v1/responses` | 文档称覆盖全部 5 个对话模型；但为无状态实现，不支持响应存储、`previous_response_id` 续写、Conversations、后台任务、Webhook、上下文压缩，内置工具仅支持 function |
| Anthropic Messages | `/v1/messages` | 面向 Anthropic SDK / Claude 生态 |

改成 Responses 只需把 `NPM` 换成 `"@ai-sdk/openai"`，Magpie 会自动把请求发到 `/v1/responses`，`baseURL` 不用动。当前不切换的原因：它的「有状态」优势一个都没实现，切过去拿不到收益，却要重新验证一遍请求形状。

---

## 二、安装与登录

```bash
magpie plugin add <本仓库路径>
magpie plugin login sensenova
```

登录会问三项：

1. **SenseNova API Key**（必填）—— 控制台 → API-Key 管理。没有它供应商发不出任何请求。
2. **账号**（可选）—— 用来读取控制台积分额度。
3. **密码**（可选）—— 同上。

后两项留空没问题：插件会回退去读 `~/.sensenova-quota.json`，那是 `snquota` 命令行在本机写下的文件。

**登录之后才会有模型可选** —— 插件不内置模型清单，模型是登录后从 `GET /v1/models` 实时拉取的（见第四节）。

### Windows 下提示符报错的处理

Magpie 的提示符读取器需要一个真正的 Windows 控制台。在 Git Bash / mintty 这类不提供控制台的 shell 里，第一个提示就会失败：

```
magpie: read /dev/stdin: The handle is invalid.
```

这是 Magpie 宿主代码在读标准输入，不是本插件的问题 —— 任何用文本提示的包都一样。两种绕法：

**改用管道输入。** 答案按提示顺序读取（Key → 账号 → 密码），**末尾要多给一行**，否则读到最后一项前就遇到 EOF：

```bash
printf '%s\n%s\n%s\n.\n' "$SENSENOVA_API_KEY" "$ACCOUNT" "$PASSWORD" | magpie plugin login sensenova
```

**或者直接用 Magpie 应用内的登录界面**，它不经过命令行的读取器。

---

## 三、配置项

`plugins.json` 里这一项的 `options`：

```json
{
  "spec": "…/st-sensenova-magpie",
  "options": {
    "baseURL": "https://token.sensenova.cn/v1",
    "quotaTtlMs": 60000,
    "scopeModel": "flash-lite",
    "locale": "auto",
    "credentialsFile": "~/.sensenova-quota.json"
  }
}
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `baseURL` | `https://token.sensenova.cn/v1` | Token Plan 地址 |
| `quotaTtlMs` | `60000` | 额度读取的缓存时长（毫秒）。`usage` 钩子会被轮询，缓存用来避免频繁打接口 |
| `scopeModel` | `flash-lite` | 当接口没有给出 `model_ids` 时，用哪个关键词圈定专属池的模型 |
| `locale` | `auto` | `zh` / `en` / `auto`（跟随本机） |
| `credentialsFile` | `~/.sensenova-quota.json` | 控制台凭据文件位置。**它只改变写回路径，不能关闭写回** |

凭据文件的解析顺序是：`credentialsFile` 选项 → 环境变量 `SENSENOVA_QUOTA_CONFIG` → `~/.sensenova-quota.json`。**选项优先**，只有它没设置时才看环境变量。

### 关于 `locale`

Magpie 不向插件暴露语言设置，也不给插件做设置界面，所以插件渲染的一切文字 —— 额度窗口名称、单位、错误信息、登录提示 —— 都由这里决定。改完下次加载生效：

```bash
magpie plugin options sensenova '{"locale":"en"}'
```

`auto` 通过 `Intl` 读系统区域，这也是 Windows 上真正生效的那条路；`LANG` 只在 `Intl` 无话可说时才参考，所以 Git Bash 里一个 `LANG=C.UTF-8` 不会把中文机器翻成英文。无法识别的一律回退英文。

译文取自控制台自己的英文站点（**General Pool**、**Flash-Lite Dedicated Pool**、单位 **credits**），不是自己编的。必须由插件翻译的原因是**额度接口不做本地化** —— 实测在真实账号上，`Accept-Language: zh-CN` 和 `en-US` 都返回 `["通用积分池","Flash-Lite积分池"]`，控制台的英文站是在它自己的前端里翻译的。

登录提示是唯一不能随时切换的部分：答案在登录那一刻就存下来了，改 `locale` 不会重新翻译已经答过的题目。

---

## 四、模型

模型列表来自官方文档的 `GET /v1/models` 接口（[模型列表 List Models](https://platform.sensenova.cn/docs)），返回 `{ data: [ … ] }`，每个 `Model` 对象携带供应商需要的全部信息：

| 接口字段 | 用途 |
| --- | --- |
| `id` | 请求时真正发出去的模型名 —— 请求就用这个 |
| `name` | 显示名称（平台通常与 `id` 相同） |
| `context_length` / `max_output_length` | 映射为 Magpie 的 `limit.context` / `limit.output` |
| `input_modalities` / `output_modalities` | 决定 `attachment` 与模态能力位 |
| `supported_features` | 决定 `tools` / `reasoning` / `json_mode` 三个能力位 |
| `supported_sampling_parameters` | 决定能不能发 `temperature` |
| `pricing.prompt` / `.completion` / `.input_cache_read` | 映射为 `cost.input` / `cost.output` / `cost.cache.read` |

**两个容易写错、而且确实写错过的点**：平台把输出上限拼成 `max_output_length`（不是 OpenAI 的 `max_completion_tokens`）；能力是 **`supported_features` 数组的成员**，不是逐项的布尔字段。按 OpenAI 的拼法去读会一无所获。

列表按 **API Key 分桶缓存 6 小时**，所以切换账号不会复用上一个账号的模型列表。

### 没有任何内置模型清单

**插件不携带任何静态模型列表**，模型完全来自 `GET /v1/models`。`config` 钩子声明供应商时 `models` 是空对象，模型由 `provider.models` 钩子按账号实时填充 —— 账号能用的模型就是列表里的那些，不会出现「插件写着有、账号其实没有」的情况。

三种情形下的行为：

| 情形 | 结果 |
|---|---|
| 有 API Key，接口正常 | 直接用接口返回的列表（已过滤图像模型） |
| 有 API Key，但接口故障 | 返回上一次成功拉到的列表，并打上 Magpie 的回退标记；从未成功过则为空 |
| 尚未登录 | 没有任何模型，打回退标记 |

所以**登录之前供应商是空的**，这是预期行为 —— 没有 Key 本来就发不出请求。

Magpie 还会合并它自己 models.dev 里的 `sensenova` 条目，可能引入账号实际没有的模型 id；**以实时列表为准**。

### 对话模型与图像模型

`/v1/models` 也会列出两个图像创作模型 —— `sensenova-u1.5-lite` 和 `sensenova-u1.5-fast` —— 它们的 `output_modalities` 是 `["image"]`，走的是 `/v1/images/generations`。**本插件只讲 chat completions，所以这两条被过滤掉了**，不会列出来让请求在运行时报错。凡是 `output_modalities` 含 `text` 的都保留。

> 为什么图像模型不能接：Magpie 的插件体系没有生图通道。它的 npm 到 API 映射只有四类，全是对话类（Anthropic Messages、OpenAI Responses、Gemini、chat completions），模型字段里的 `capabilities.input` 描述的是**输入**模态（能不能收图），没有输出侧的生图声明。即使写了调用 `/v1/images/generations` 的代码，也没有钩子会被触发。要生图只能脱离 Magpie 单独做工具。

---

## 五、额度

### 额度显示在哪

Magpie 的插件系统**不允许插件新增面板或页面**，也没有任何东西能往用量概览页填内容 —— 那个页面由 Magpie 自己的请求计量驱动。

插件唯一的额度通道是 `auth.usage`。它返回的内容会出现在三处：

- 供应商的**账号行**
- `magpie quota`
- 网关的 `GET /v1/magpie/quotas`

好消息是 Magpie 的额度模型和 SenseNova 的数据几乎一一对应，没有信息损失：

| SenseNova | Magpie |
| --- | --- |
| 通用池 5 小时窗口（`window_5h`） | 一条 `windows[]`，`span: 18000` |
| 通用池本周窗口（`window_7d`） | 一条 `windows[]`，`span: 604800` |
| 池覆盖哪些模型（`model_ids`） | `models[]`（语义是「恰好这些 id」） |
| 套餐名（`plan.name`，实际为 `Free Plan`） | `plan` |
| 赠送积分余额（`grant_balance`） | `balance` |
| 窗口重置时间（`reset_at`） | `resetsAt`（Unix 秒时间戳） |

模型归属直接用接口给的 `model_ids`，不按名字猜 —— 专属池的 `model_ids` 由服务器自己声明，比任何启发式都准；只有拿不到 `model_ids` 时才退回按关键词匹配。套餐名同理，取自接口的 `plan.name`。

### `amount` 是必需的，而文档没写

除了 `used`（已用百分比）和 `limit`（配额），每个窗口还必须带 **`amount`（已用数量）**。

这是踩过坑才发现的：只给 `used` 和 `limit`，百分比是对的，但界面上的数字会显示成 `0 / 600000`，和真实余额完全不像。Magpie 把卡片渲染成「已用 / 配额」，还提供一个「已用 | 剩余」的切换，两边都从 `amount` 算；没有它，数量就被当作 0。

这个字段**不在插件文档的窗口字段列表里**（文档只列了 `name` / `used` / `resetsAt` / `resetSecs` / `span` / `display` / `model` / `models` / `notModels` / `aside`）。它是通过对照两个社区插件的实现还原出来的 —— `@magpie-community/opencode-workbuddy-auth` 和 `opencode-zcode-auth` 都设置了它。

所以本插件输出的每个窗口都带 `used`（百分比）、`amount`（已用数量）、`limit`、`unit`、`display`、`span`、`resetsAt`，专属池另外带 `models`。`display` 用 Magpie 自己的紧凑格式（整数给整数，否则两位小数），以便和 `amount` / `limit` 并排渲染时对齐。

对账很简单：`limit - amount` 必须等于控制台显示的剩余余额。

### 额度是账户级的，不按 Key 拆分

**积分额度不是按 API Key 分的，同一账户下的所有 Key 共享一个池。**

三条证据：

1. 控制台自己的横幅写着「**同账户所有 Key 共享**」。
2. 额度接口的响应里**完全没有 Key 这个维度** —— 顶层只有 `{plan, pools}`，每个池带 `id` / `name` / `model_ids` / `window_5h` / `window_7d` / `grant_balance` / `pool_type`，没有任何 Key 标识。
3. 按 Key 的拆分在别处：控制台的**使用明细**页。那个接口支持按 `apiKey` 过滤，每条调用记录都带自己的 Key，可导出 CSV / Excel。

所以这是两个不同层次：

| | 维度 | 是什么 |
| --- | --- | --- |
| **积分池（本插件显示的）** | 账户级 | 同账户所有 Key 共享；Key 是入口，不是独立账本 |
| **使用明细** | 按调用 | 每条记录带自己的 Key，可按 Key 过滤导出 |

对 Magpie 的实际影响：

- 同一个 SenseNova 账户加**两枚 Key**，两行显示**完全相同的数字**。
- Magpie 的「一个用完了换下一个」在这种情形下失效 —— 它以为每枚 Key 各有 60 万额度，实际共用一个池。**加 Key 不会加额度。**
- 想要更多额度，得换一个 SenseNova 账户。

---

## 六、安全说明

**本插件是本地第三方客户端，与商汤无隶属关系。** 下面每一条都注明依据来源，分三类：

- **实测** —— 对真实接口或本机的测量，附命令或现象；
- **控制台代码** —— 引自 SenseNova 控制台自己的前端代码；
- **插件代码** —— 本仓库源码的实际行为，附文件与函数。

前两类描述外部世界，平台一改就可能失效；第三类描述本包，随版本走。**如果标注「插件代码」的内容和你的观察不符，以代码为准并提 issue。**

> 说明：标注「实测」的条目是对真实接口的观测，来自上游作者与后续维护者的验证记录，本仓库未逐一复测；平台改版可能使其失效，以你观察到的现象为准。

### 1. 存了什么，存在哪

两套凭据，权限范围差别很大：

| 凭据 | 存放位置 | 字段 | 能做什么 |
| --- | --- | --- | --- |
| API Key | `~/.config/magpie/plugin-auth.json` | `key`（`type: "api"`） | 调用 Token Plan 模型 |
| 账号 + 密码（仅在你填写时） | 同一文件的 `metadata` 下 | `metadata.email` / `metadata.password` | **整个账号** |
| 控制台 OAuth 令牌 | 同一文件的 `metadata`，或 `~/.sensenova-quota.json` | `access_token` / `refresh_token` / `id_token` / `cookie` / `iam_base` | 读取额度、续期令牌、取账号名 |
| 会话 Cookie（仅在你提供时） | 同上 | `metadata.cookie` | 无需密码即可换控制台令牌 |

**账号密码能做的不只是读额度。** 它能登录 SenseNova 控制台、创建和删除 API Key，以及该账号能做的一切。把它交给插件，等于把整个账号交给 Magpie 的凭据文件 —— 这是本插件要求的最高权限。**留空完全可以正常使用**（见第 5 条）。

`metadata` 里的账号密码只有两个来源，都需要你同意：你在插件登录提示里输入的，或你此前用 `snquota login --save-password` 存进 `~/.sensenova-quota.json` 的（插件在该文件存在时会读它）。**它不会从浏览器、系统钥匙串或其他供应商的登录态里抓取凭据**，也不会写 SenseNova 服务端的任何凭据设置。

**有一个本地文件确实会被写入，必须说明**：如果凭据来自 `~/.sensenova-quota.json`（也就是你没填账号字段、走了第 5 条里的第二条路），那么续期令牌后插件会**把新令牌写回该文件**，避免 CLI 手里那份过期。代码里的条件是「登录时既没提供账号也没提供 Cookie」；**提供任一项就不会写回**。（`credentialsFile` 只改写入路径，不关闭写入。）

### 2. 密码以明文存储

**内容不加密**，就是普通 JSON。这一点与平台无关。

至于谁能读，不要指望文件权限救你。在 Linux 和 macOS 上 Magpie 会以 600 权限创建（仅你可读），但在 Windows 上它不设置限制性权限，文件继承所在目录的默认权限，通常只有 `SYSTEM`、`Administrators` 和当前用户三项，都是完全控制。

也就是说，任何以你身份运行的进程，以及管理员权限的进程，都能读到密码。**密码的安全边界是「本机所有进程」，不是「只有你」。** 具体权限因机器和目录继承策略而异，用 `Get-Acl <路径>` 自查。

实际建议：把这两个路径排除在云同步目录、备份任务和 dotfiles 仓库之外。密码一旦跟着备份走，就是明文跟着走。

### 3. 密码以明文传输，与浏览器不同

**控制台代码**是这样的（`U` 是加密函数，`h.bK` 是登录请求）：

```js
// 当 JWKS 可用时，先用服务器公钥加密再提交
if (s) { let t = await U(s, e.password); t && (r = t, a = !0) }
await h.bK({ username: e.username, password: r, challenge: t, is_encrypt: a })
```

浏览器发送的是 `is_encrypt: true` 加上 RSA-OAEP 密文（JWE，`alg: RSA-OAEP, enc: A256GCM`）。**本插件发送明文（`is_encrypt: false`）** —— 这是**实测**结论：服务端接受，不强制要求加密。代码位置在 `quota.mjs` 的 `renewWithPassword()`。

两者最终在服务端都是明文，因为服务端必须拿到明文才能校验密码。区别在于**路径暴露面**：HTTPS 仍然保护传输，但任何能看到 TLS 明文的环节 —— 企业代理、抓包、请求体日志 —— 都能看到密码。如果你处在这样的环境里，不要填密码。

### 4. 密码几乎用不到

续期顺序是 `refresh_token` → 会话 Cookie → 账号密码，**第一个成功的就停**。只要 refresh token 还活着，密码根本不会被发送。它只是 refresh token 失效时的兜底。

### 5. 不想存密码就留空

登录时的账号和密码字段都可以留空。三种用法及各自代价：

| 做法 | 会存下什么 | 适合谁 |
| --- | --- | --- |
| **只填 API Key** | 仅 `key` | 只想用模型，不在乎额度显示 |
| **账号密码都留空** | 插件去读 `snquota` 写的 `~/.sensenova-quota.json`（通常含 refresh token） | 想要额度显示，但不愿把账号密码交给 Magpie |
| **填写账号** | 明文写入 `plugin-auth.json` | 没有其他令牌来源，且接受第 1、7 条的风险 |

如果都留空且那个配置文件也不存在，额度会报一个要求登录的错误 —— **模型调用两种情况都不受影响。**

### 6. 访问哪些主机，无遥测

默认部署（`platform.sensenova.cn`）下有三个：

| 主机 | 用途 | 发送什么 |
| --- | --- | --- |
| `token.sensenova.cn` | 模型请求、模型列表 | API Key |
| `platform.sensenova.cn` | 读取额度；图标地址也在这里 | 控制台令牌 |
| `iam.sensecoreapi.cn` | 续期控制台令牌 | 账号密码（仅第 4 条的兜底情形） |

源码里还有第四个 `iam.sensecoreapi.tech`，那是**另一个部署** `nova.sensecore.tech` 的 IAM 地址，只有账号属于那个部署时才会用到（可用 `iam_base` 覆盖）。如果你在 `platform.sensenova.cn`，它不会出现。

除此之外不向任何地方发送数据 —— 没有遥测、没有上报、没有第三方 SDK。它**不读其他供应商的凭据**（技术上它能读到同一个 `plugin-auth.json`，见第 7 条；重点是代码没有这么做，而不是环境阻止了），不改 Magpie 之外的配置，不创建也不删除 API Key（控制台令牌有这个能力，但插件只调用那一个只读接口）。

额度读取默认缓存 60 秒（`quotaTtlMs`），所以被轮询的 `usage` 钩子不会频繁打接口。

### 7. Magpie 和其他插件能看到什么

Magpie 官方文档的 FAQ 里有这一段：

> **插件能看到用户的什么？** 它能看到的请求里的一切：对话、工具及其结果。只在用户要求的地方发送，不要写进日志。

这同样适用于本插件，而且必须讲清楚：**这是一个供应商插件，它位于请求路径上。** 它注册了一个供应商并包装了 `fetch`，在请求发出前把 `authorization` 头换成当前 API Key：

```js
async fetch(input, init) {
  const headers = new Headers(init?.headers ?? source?.headers);
  headers.set("authorization", `Bearer ${current}`);
  return fetch(new Request(source, { ...init, headers }));   // body 原样透传
}
```

所以就能力而言，它**有条件看到你的整个对话、工具调用及其结果。**

代码的实际行为是：**只读请求头、只改写 `authorization` 这一个字段**，不读请求体（`body` 由 `{...init}` 原样带走），不把内容写到任何地方，不缓存提示词或响应，也不向第 6 条列表之外的主机发送任何东西。**但这是代码在自我约束，不是平台给的隔离** —— 你只能通过读代码来确认，Magpie 无法替你保证。

关于 Magpie 插件机制的三件事，决定了这份自我约束值多少：

- **插件没有沙箱。** 插件是运行在 Magpie 进程里的普通代码，可以用 `fs` 读文件。Magpie 文档正是出于这个原因，建议「在沙箱里运行 magpie」并给它单独的 HOME。
- **插件没有审核。** 从 GitHub topic 安装的插件，Magpie 明确标注为无人审核。本插件同样是未经审核的第三方代码。
- **所有插件的凭据在同一个文件里。** `plugin-auth.json` 是一个文件，装着每个供应商、每个插件的登录态，不是一插件一文件。既然插件无沙箱且有 `fs`，**你安装的任何其他插件都能读到本插件存在那里的账号密码。** 这是决定要不要填密码时最重要的考量 —— 机器上有来源不明的插件，就留空（见第 5 条）。

Magpie 自己会读 `plugin-auth.json`（管理登录态）、`plugins.json`（插件及其配置）、`plugin-providers.json`（上次列出的供应商与模型）。另外，**插件详情页展示的是 npm 上的 README** —— 所以这份 README 是本插件唯一的披露面，这也是它每一条都写成可核查的原因。

### 8. 风险声明：额度接口是控制台内部接口，不是公开 API

额度数字来自控制台主机上的一个接口，**控制台前端自己**用它绘制积分面板。它没有文档，随时可能改变或消失。具体路径刻意没有写在这里，需要看的话在 `quota.mjs` 里。

走这条路的原因是平台**根本没有提供可用 API Key 访问的额度接口** —— 见第一节的实测结论。

**风险不止「可能坏掉」**，说明白：

| 风险 | 意味着什么 |
| --- | --- |
| **可能违反服务条款** | 这个接口是控制台前端自己的，不是承诺过的 API。脚本化访问是否被允许由平台决定，**你需要自行确认**。本插件不改变也不绕过任何条款。 |
| **可能失效** | 未文档化的接口不做兼容承诺。一次改版、加签名、限流，都可能让它变成 404 或 403，届时额度显示会报错（模型调用不受影响）。 |
| **可能触发风控** | 自动登录加上周期性额度读取，在服务端看起来像非标准客户端。本插件已经把额度读取缓存 60 秒、并把密码降级为最后手段来压低痕迹，但**无法承诺你不会被标记。** |
| **扩大凭据暴露面** | 访问这个接口需要持有控制台令牌（可能还有账号密码）。这部分风险由第 1 到 7 条覆盖。 |

四条里只有第一条需要你判断 —— 技术风险插件能处理，合规风险不能。**如果介意，就不要用额度功能**：只填 API Key 时，插件退化为一个纯模型供应商，完全不碰控制台接口，第 2 到 4 条风险一并消失。

### 9. 它不做什么

- 不申请、轮换或吊销你的 API Key。
- 不修改你的 SenseNova 账号设置。
- 不读取、记录或转发你的模型请求内容 —— 只改写 `authorization` 一个头，body 原样透传给 `token.sensenova.cn`（见第 7 条代码）。
- 不缓存提示词或响应。
- 不写 SenseNova 服务端的任何凭据设置。
- 不写回 `~/.sensenova-quota.json`，**除非**凭据来自该文件且发生了令牌续期（见第 1 条末尾）。

---

## 七、账号行显示的是什么

Magpie 给账号命名时，依次看 `accountId`、`metadata.email`、`email`，都不存在时才退化为用凭据本身命名 —— 也就是你可能见过的 `API key …HohJ`。

所以这个标签是**在登录那一刻**定下来的，取决于你填了什么：填了账号字段，行上就显示那个手机号或邮箱；留空就保持 Magpie 的 API Key 兜底命名。

要让一个 `api` 类型的方法设上这个名字，试过几种办法，有两个看似可行的其实不行：

- **提示项的 `key` 才是决定因素。** 本插件把账号问在 `email` 这个 key 下，答案就落进 `metadata.email` —— Magpie 读的正是这个字段。实测：账号字段填 `139…7777` 的一次登录，账号行显示的正是这个值。
- **`authorize` 返回的 `accountId` 被忽略**（`api` 类型）。它只对 oauth 结果有文档说明，带着它登录仍然显示 `API key`。
- **`authorize` 返回的 `metadata` 会被丢弃**，Magpie 用提示收集到的答案覆盖它，塞进去的 `email` 活不下来。
- **`usage.user` 也不会改名。** 钩子返回的 `user` 存在 Magpie 的额度缓存里（`quotas.json` → `quota.user`），账号行和 `magpie quota` 仍然渲染登录时的标签；缓存键始终是 `sensenova/api key …hohj`。

更早的登录把账号存在 `metadata.username` 下，所以 `consoleAuthOf` 仍会读这个拼写（以及 `account`）作为回退；只有新的登录能享受到命名改进。

**如果你在支持这个行为之前就登录过**，存下的标签仍是 API Key 那种。重跑一次 `magpie plugin login sensenova` 即可。

---

## 八、图标

用的是平台自己的图标：`assets/sensenova.png` 就是 `https://platform.sensenova.cn/favicon.ico` 的原始字节。那个地址名为 `.ico`、响应头也写 `image/x-icon`，但文件内容实际是 65×65 的 PNG（366 字节），所以 data URI 按真实字节声明 `image/png`，而不是照着响应头写。

图标是**内置而非按 URL 引用**，这样离线也能识别供应商，也不依赖平台继续提供该文件。`package.json` 里的 `magpie.icon` 字段仍指向那个地址，供发布到 npm 后的发现卡片使用。

---

## 九、已知限制

- **额度只出现在三处** —— 账号行、`magpie quota`、`/v1/magpie/quotas` —— 无法进入用量概览页。这是 Magpie 的设计，不是本插件没做到。
- 控制台令牌过期且三条续期路径全部失败时（refresh token 被吊销、Cookie 过期、密码错误），账号行会显示一个要求重新登录的错误。
- 额度接口是控制台内部接口而非公开接口，改版可能使其失效。
- 登录之前供应商没有可选模型；首次拉取失败时同样为空，因为没有内置清单可退。
- 接口若省略某个字段，该字段用保守默认值（上下文 131072、输出 32768、仅文本输入），文档所述的响应形状不会省略。
- **图像生成模型不接入** —— Magpie 插件体系没有生图通道，见第四节末尾。

---

## 十、如何分发

把仓库推到 GitHub 并不会让它出现在 Magpie 里。按官方文档，插件有三条发现路径，满足一条即可。

**1. GitHub topic（最省事）**

给仓库打上 `magpie-plugin` 标签，就会出现在 Plugins → Discover → **非官方插件**里，按 star 排序并标注「无人审核」。要求：

- `package.json` 必须在**仓库根目录**（已满足）。
- 如果包同时在 npm 上且其 `repository` 指向本仓库，安装走 npm；否则安装仓库当前代码，所以**被加载的文件必须已提交**（本仓库是纯源码、无构建产物，已满足）。
- fork、已归档仓库、以及 `magpie-community` 自己的仓库会被排除。
- GitHub 最多每十分钟轮询一次，新 topic 几分钟内出现。

**2. npm**

插件浏览器在 npm 上搜 `<关键词> opencode`，匹配名称或关键词里**同时**含 `opencode` 和 auth / plugin / provider 之一的包。本仓库的关键词已包含 `opencode`、`opencode-plugin`、`opencode-auth`，符合条件。普通插件**不需要 scope**；`@magpie-community/` 只用于贡献进官方社区仓库的包。

**3. 推荐列表（`registry.json`）**

这条不对独立包开放。对照线上文件核查过：21 个条目全部是 `@magpie-community/*`，且每个都带 `"community": true`，无一例外。所以要进这个列表，意味着**成为社区包**，而不是提 PR 加一个外部包。

要走这条路，就在 `magpie-community/plugins` 的 `packages/<name>` 下贡献，把供应商包命名为 `@magpie-community/opencode-sensenova-auth`，条目格式与其他条目一致：

```json
{
  "package": "@magpie-community/opencode-sensenova-auth",
  "name": "SenseNova",
  "icon": "sensenova",
  "providers": ["sensenova"],
  "community": true,
  "summary": {
    "en": "SenseNova Token Plan models, with the console's credit quota reported as native quota windows.",
    "zh": "接入商量/日日新 Token Plan 模型，并把控制台积分额度上报成原生额度窗口。"
  }
}
```

注意这里的 `icon` 是短名（其他条目用 `opencode`、`zcode`、`qoder` 等），不是 `magpie.icon` 接受的 URL。这样做有两个好处：往 `main` 推一个版本号就会发布，且包会在**每个 Magpie 里自动更新**，用户不用重装。本仓库**零依赖**，搬过去不需要改代码 —— 但那意味着包在别人的仓库里开发，所以默认没这么做。

列表最多每六小时拉取一次，Magpie 内置一份副本作为兜底。`MAGPIE_PLUGIN_MARKET=<url>` 可替换成别的列表（`off` 表示只用内置副本）。

本仓库的 `repository` / `homepage` / `bugs` 字段指向 `xiaolietu/st-sensenova-magpie`，且仓库已带 `magpie-plugin` topic，所以**路径 1 当前已生效**。路径 2 和 3 属于可选，尚未做。

---

## 十一、开发

```bash
node --test test/*.test.mjs
```

当前 81 个测试，覆盖：

- 积分池到窗口的映射（`used` 百分比、`amount`、`limit`、`span`、`resetsAt`、专属池的模型圈定、赠送余额）；
- `limit - amount` 能复现控制台的余额；
- 用量未知的窗口被跳过而不是报成 0；
- 字段缺失时的降级；JWT 过期判断；refresh token 续期；无凭据时报出的错误；
- `fetch` 钩子在 `(url, init)` 与 `Request` 两种入参下都保住 body 和 headers；
- `__` 前缀的内部键不会写进凭据文件；
- 文档所述的 `/v1/models` 形状端到端（`max_output_length` 而非 `max_completion_tokens` 承载输出上限、`supported_features` 成员驱动能力位、空数组视为「未声明」而非「无能力」、定价字符串转数字、图像创作条目被过滤）；
- 模块不携带任何内置模型清单（`FALLBACK_MODELS` 必须不存在）；
- 模型目录的缓存行为（按 key 分桶、同一 key 并发只发一次请求、拉取失败保留上一份好数据、`fetchImpl` 同步抛错不会永久污染该 key）；
- 额度缓存的隔离（同一账号重复调用只请求一次、不同账号不共用条目、续期链路顺序为 authorize → token → 额度）；
- 语言解析（显式指定、系统、环境变量、POSIX `C`）；两张字符串表保持同步；
- 共享池不被套用专属池的命名规则；
- `accountNameOf` 从令牌读取、取不到时返回空而不是编一个名字；
- 账号提示声明在 `email` 这个 key 下，且 `consoleAuthOf` 仍能读旧的 `username` / `account` 拼写；
- `usage` 钩子在两种语言下端到端。

---

## 十二、上游来源与许可

- 上游项目：[aqiu817/magpie-sensenova](https://github.com/aqiu817/magpie-sensenova)
- 许可：MIT，原始版权归 aqiu817；本分支的修改版权归 xiaolietu，两行都保留在 [LICENSE](LICENSE) 中。
- 图标与商标说明见 [NOTICE.md](NOTICE.md)：`assets/sensenova.png` 是商汤的商标，仅用于在 Magpie 的供应商列表里识别 SenseNova；本插件是**非官方第三方客户端**，商汤未予背书。
