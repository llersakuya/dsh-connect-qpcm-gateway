# dsh-connect-qpcm-gateway

把 [`https://ai.qpcmqam.cn/v1`](https://ai.qpcmqam.cn/v1) 这个 OpenAI 兼容网关接成
DSH 的模型来源，并给出一块可以在 Web UI 里操作的面板。

可以接**多组**：每组有自己的端点、Key 和模型清单，同时出现在模型选择器里。

## 安装

一条命令，不需要 `git`、不需要放行构建脚本、不需要装任何工具：

```bash
dsh plugin --profile desktop add https://github.com/llersakuya/dsh-connect-qpcm-gateway/releases/download/v0.4.2/dsh-connect-qpcm-gateway-0.4.2.tgz
```

**桌面版用户**也可以在 **设置 → 插件 → 安装 bundle** 里直接粘贴同一个 `.tgz` 地址。

装完打开 **插件 → QPCM 网关接入**，粘一次你的 API Key，点「保存并验证」。
目录拉通之后插件会**自动接入**，模型立刻出现在模型选择器里，不用重启，也不用
再去拨那个开关。

### 为什么用 `.tgz` 而不是 `github:` 地址

| | `.tgz`（推荐） | `github:llersakuya/...` |
| --- | --- | --- |
| 需要本机有 `git` | 不需要 | **需要**，否则报 `ERR_PNPM_GIT_RESOLVE_FAILED` |
| 需要放行 pnpm 构建 | 不需要 | 视 pnpm 策略而定，可能要改 `allowBuilds` |
| 版本 | 地址里锁死 | 默认跟随 `main`，每次装到的可能不同 |

git 方式仍然可用，适合想跟最新提交的人：

```bash
dsh plugin --profile desktop add github:llersakuya/dsh-connect-qpcm-gateway
```

> 改过本插件的 Host 侧代码后，要把它关掉再打开一次才会重新加载：HMR 默认忽略
> `**/node_modules`，而插件正好装在那里。

### 依赖

本插件不自带 `pi-ai` 与 `dsh-llm-pi-ai`，它用的是 Host 里已有的那两份
（`peerDependencies`，且全部标为 optional）。这也意味着它必须跑在装有
`@earendil-works/pi-ai` 的 DSH 上——正常的桌面版都满足。

## 多组 API

面板最上面是分组列表。**添加一组**之后，这一组有自己的：

- **Base URL**（各组的端点互相独立）
- **API Key**（存在各自的凭据引用里，互不串用）
- **模型清单**（各自的 `/models` 结果与勾选）
- **接入开关**（可以只开其中一组）

各组的模型**同时**出现在模型选择器里，以路由 id 区分——模型选择器里看到的是
`分组名 / 模型名`。默认第一组的 id 是 `qpcm-gateway`（v0.3.x 就用这个，
所以老会话里的模型引用不会失效），之后新建的按你填的名字派生。

最多 8 组。这个上限是刻意的：每一组都会往模型选择器里塞条目，没有上限会把那里
淹掉。

> 一组的 Key 只有存进它自己的凭据引用才生效。删除一组会保留它的 Key 引用
> （不删你磁盘上的密钥），但不再使用。

## 它做什么

- 在 **插件 → QPCM 网关接入** 里填 Base URL、存 API Key、拉取模型目录、勾选要提供的模型。
- 打开「接入」开关后，被勾选的模型直接出现在模型选择器里，走
  `POST {baseURL}/responses`（OpenAI **Responses** 协议，含工具调用、流式、推理档位）。
- 每个模型可以**单独调**上下文窗口、最大输出 token、输入模态，见下一节。
- 在 **设置 → 模型** 里，每条连接以它自己的路由 id 出现，和手写 `llm-pi-ai`
  的那几条并列。

## 按模型自定义

网关的 `/models` 只给 id 和名字，不给窗口和上限——所以这些数字原本是本插件写死的
兜底值。现在每个模型后面都有一行设置：

| 项 | 含义 | 默认 |
| --- | --- | --- |
| **上下文** | `contextWindow`，算 token 预算用 | `128000` |
| **最大输出** | `maxTokens` → 请求里的 `max_output_tokens` | 留空 = 不声明 |
| **收图** | 是否把 `image` 加进 `input` 模态 | 只收文本 |

改完点那一行的**保存**才生效；有覆盖的模型会带一个「已自定义」标记，点**恢复默认**可以撤掉。

三个字段都真的影响请求，不是摆设：

- `maxTokens` 会经 pi-ai 的
  `clampMaxTokensToContext(model, context, maxTokens)` 落到 `max_output_tokens`，
  并且**被上下文窗口反向截断**——窗口设得比输出上限还小的时候，实际发出去的数字
  会比填的小。
- `input` 决定带图请求能不能发。**这个网关多数模型不收图**，打开后带图会失败，
  所以默认是关的。

「最大输出」留空是有意的：网关没声明上限，猜一个数字等于把「平台没说」写成
「平台说了」。填了就是明确告诉 DSH 你希望的上限。

> 设置存在插件自己的状态文件里（`~/.dsh/state/<profile>/dsh-connect-qpcm-gateway/state.json`），
> 不写进你的 `llm-pi-ai` 配置。

## 为什么走 `/responses` 而不是 `/chat/completions`

这个网关两个端点都通，但 `/responses` 在实测里多出三样东西：

1. **推理内容以独立 `reasoning` 条目回来**（带 `encrypted_content`，可整条回放）。
2. **`reasoning.effort` 真的能调**：`high` 在难题上稳定产出 `reasoning_tokens`
   与明文推理摘要，`medium` 次之。
3. **多轮回放被接受**：把上一轮的 `reasoning` / `output_text` 原样放回 `input`，
   再追加新输入，实测 200；带不带 `encrypted_content` 都接受。

文本、工具调用、流式、多轮对话、系统提示在 `/responses` 上逐项验证通过。

### 推理档位只声明 off / medium / high

`thinkingLevelMap` 是按实测的 `reasoning_tokens` 定的，不是照着 OpenAI 文档抄的：

| 档位 | 实测表现 |
| --- | --- |
| `minimal` | 多数模型 0 token，什么都不做 |
| `low` | 半数模型 0 token |
| `medium` | 有产出，但部分模型仍为 0 |
| `high` | 稳定产出明文推理 |

`minimal` / `low` 显式钉成 `null`（不提供）——留着它们等于在菜单里承诺两个
多数模型上什么都不做的档位。`off` 映射到线上字面量 `none`，五个模型逐个验证 200。

### 推理明文不是每轮都有

网关的明文推理走 SSE 的 `response.reasoning_summary_text.delta`，且**只在流式请求
里发**；非流式请求只回 `encrypted_content`（加密）。即使流式，它也按模型和请求
波动——同一模型同一档位两次请求，一次有摘要、一次没有。因此面板不承诺「每轮都
看得见思考过程」；`reasoning_tokens` 在 usage 里始终可靠。

## 它不做什么

- **不改** profile 里已有的 `llm-pi-ai` 配置。本插件注册的路由 id 是
  `qpcm-gateway`，与 `gpt-2610` / `ds-v41-flash` / `zai` 不冲突——`registerAdapter`
  对已占用路由整组拒绝，所以这一点是硬要求。
- **不**把 API Key 写进配置、状态文件或日志。Key 只落 owner-only 的
  `~/.dsh/.credentials.yaml`，引用名默认 `QPCM_API_KEY`。
- **不**提供图像模型。`gpt-image-2.5-flare` 与 `-sunburst` 在 `/responses` 上稳定
  502，只在 `/images/generations` 上 200；而 DSH 的 LLM 接缝没有图像生成能力
  （`PiAiAdapter` 上有 `prepareCall` / `stream`，没有 `generateImages`；`dsh-llm`
  里也搜不到相关接口）。列出来只会让模型选择器里出现一个必然失败的条目，所以
  这些 id 在目录里标为「不是对话模型」，不进候选。它们在 `/chat/completions`
  上同样是 400。

## 配置怎么分层

| 层 | 位置 | 谁写 |
| --- | --- | --- |
| 出厂默认 | 本 bundle 的 `cordis.patch.yml`（以及 profile patch 里的同名行） | 安装时写入；操作者可以在 profile patch 里钉死 |
| 面板状态 | `$DSH_HOME/state/<profile>/dsh-connect-qpcm-gateway/state.json` | 面板 |
| API Key | `~/.dsh/.credentials.yaml` → `refs.QPCM_API_KEY` | 面板 |

生效值 = 状态文件里有的字段覆盖出厂默认，没有的字段继续跟随 patch。这样面板写路径
不会因为写配置而重载本插件（重载会打断正在跑的请求）。

### `cordis.patch.yml` 里的字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://ai.qpcmqam.cn/v1` | OpenAI 兼容根地址（`/responses` 挂在其下） |
| `displayName` | `QPCM Gateway` | 模型选择器里的显示名 |
| `apiKeyEnv` | `QPCM_API_KEY` | 凭据引用名（不是 key 本身） |
| `enabled` | `false` | 是否注册成 LLM provider |
| `enabledIds` | `[]` | 启用清单，见下 |
| `requestTimeoutMs` | `30000` | 单次请求超时 |
| `cacheSeconds` | `60` | 模型目录缓存秒数 |
| `allowedHosts` | `[]` | 追加可信 Host 名 |

### `enabledIds` 的三态

| 值 | 含义 |
| --- | --- |
| `[]` | 不过滤——目录里每个 chat 模型都提供（新增的模型自动跟上） |
| `["__hide_all__", ...]` | 一个都不提供 |
| `["id", ...]` | 严格白名单 |

裸 `[]` 已经被「全部」占了，所以「全不选」必须走哨兵。Host 与客户端读同一个字面量。

## 面板能做什么

- **源站地址**：改 Base URL，或一键恢复默认。改地址会丢掉旧目录（换端点等于换了一个目录）。
- **API Key**：保存即验证——存完立刻拉一次 `/models`，成功与否当场显示；也能清除。
- **模型目录**：显示 id、显示名、能不能当对话模型用；全选 / 全不选 / 逐个勾选。
- **接入开关**：开 / 关 provider 注册，不需要重装插件、不需要重启。

## 排障

| 现象 | 原因 |
| --- | --- |
| 目录报 `HTTP 401` | key 不对或已失效，重新保存 |
| 目录报 `MISSING_CREDENTIAL` | 还没存 key |
| 选择器里没有模型 | 「接入」开关没开，或者勾选清单是「全不选」 |
| `provider.failed` 里提到 peer | 这台 Host 缺 `@earendil-works/pi-ai` 或 `@deepseek-ai/dsh-llm-pi-ai` |
| 推理档位菜单里没有 `minimal`/`low` | 故意的，见上文「推理档位只声明 off / medium / high」 |
| 某轮没显示思考过程 | 网关只在流式且它愿意的时候发明文摘要；`reasoning_tokens` 仍计入 usage |

面板里的每一次写操作都是同源请求；Host 侧对 `Host` / `Origin` 有围栏，跨站页面
拿不到这块面板的读写面。

## 许可证

MIT
