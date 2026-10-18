/**
 * dsh-connect-qpcm-gateway — Host half.
 *
 * 把 `https://ai.qpcmqam.cn/v1` 接成 DSH 的 OpenAI 兼容 LLM provider，并给 Web UI
 * 一块面板：填 Base URL / API Key、拉模型目录、勾选要提供的模型、开关「接入为
 * DSH 模型」。
 *
 * ## 三条承重设计
 *
 * 1. **两层配置，各管各的。** `cordis.patch.yml` 里的 `config` 是**出厂默认值**
 *    （操作者可以直接在 profile patch 里钉死端点）；面板改出来的东西住
 *    `$DSH_HOME/state/<profile>/<ns>/state.json`。生效值 = 状态文件 ?? 默认值。
 *    这样面板写路径不需要 `settings` 的 volatile 语义，也不会因为写配置而重载
 *    本插件（重载会断掉正在跑的请求）。
 *
 * 2. **API Key 只走凭据服务。** 引用名默认 `QPCM_API_KEY`，值落 owner-only 的
 *    `~/.dsh/.credentials.yaml`。状态文件与 `config` 里**永远没有**明文 key，
 *    面板读到的也只是 `{configured, source}`。
 *
 * 3. **provider 注册一次，模型清单是活的。** `PiAiAdapter` 每次操作都重读
 *    `profiles()`，所以勾选变化只需换掉那份 Map，不必注销再注册 provider。
 *
 * @module dsh-connect-qpcm-gateway
 */

import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

/** 插件 id：Cordis 行 id、settings 命名空间、路由前缀、客户端 slot key 都是它。 */
const NS = 'dsh-connect-qpcm-gateway'

/**
 * 第一条连接的 provider 路由 id。
 *
 * 它同时是**历史 id**：v0.3.0 之前本插件只有一条连接，会话里已经写下了
 * `<这个 id>/<模型>`。所以迁移时第一条连接必须沿用它，否则老会话里的模型引用
 * 会集体变成 UNKNOWN_MODEL。
 *
 * **不能**复用配置里已有的 `gpt-2610` / `ds-v41-flash`：`registerAdapter` 对已
 * 占用路由**整组拒绝**（`DUPLICATE_ADAPTER`），而那几条是操作者自己写在
 * `llm-pi-ai` 里的，本插件不得抢占。
 */
const PROVIDER_ID = 'qpcm-gateway'

/** 连接 id 就是 provider 路由 id，所以要能安全地拼进路由名。 */
const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9-]{1,48}$/

/** 最多几条连接：每条都要挂进模型选择器，没有上限会把那里淹掉。 */
const MAX_CONNECTIONS = 8

/** 出厂默认值（与 `cordis.patch.yml` 保持一致）。 */
const DEFAULTS = Object.freeze({
  baseURL: 'https://ai.qpcmqam.cn/v1',
  displayName: 'QPCM Gateway',
  apiKeyEnv: 'QPCM_API_KEY',
  enabled: false,
  enabledIds: [],
  requestTimeoutMs: 30_000,
  cacheSeconds: 60,
})

/**
 * 「全不选」哨兵。
 *
 * 裸 `[]` 已经表示「不过滤（全都提供）」，所以「一个都不提供」不能用空数组
 * 表达——否则点「全不选」反而把全部模型放出来。两侧（Host 的
 * `filterByEnabled` 与 Client 的 `selectionOf`）读同一个字面量。
 */
const HIDE_ALL_MODELS = '__hide_all__'

/** 目录没声明窗口时的保守兜底（pi-ai 会对该字段做算术，0 会算坏预算）。 */
const DEFAULT_CONTEXT_WINDOW = 128_000
/** 每 token 单价对额度制网关不可知，一律报零（零是哨兵，不是免费）。 */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
/** 可声明的输入模态。与 `dsh-llm-pi-ai` 的 `MODALITIES` 同集合。 */
const INPUT_MODALITIES = Object.freeze(['text', 'image'])
/** 面板与状态文件共用的覆盖字段名（只这三个，别的一律忽略）。 */
const OVERLAY_FIELDS = Object.freeze(['contextWindow', 'maxTokens', 'input'])
/**
 * 走不了 `/responses` 的 id。
 *
 * 图像模型实测：`gpt-image-2.5-flare` 在 `/responses` 上稳定 502，在
 * `/images/generations` 上 200。这不是「协议不对」而是「这个模型只能画图」，
 * 而 DSH 的 LLM 接缝**没有图像生成能力**（`PiAiAdapter` 上没有
 * `generateImages`，`dsh-llm` 里也搜不到相关接口），所以本插件无法把它们
 * 接成可用的模型——列出来只会让模型选择器里出现一个必然失败的条目。
 */
const NON_CHAT_PATTERN = /(^|[-_/])(image|embed|embedding|tts|whisper|audio|rerank)([-_/]|$)/i

/** 线上协议。面板把它显示出来，排障时不用猜。 */
const WIRE_API = 'openai-responses'
/** 实测有推理产出的档位（原始档位名，见 {@link toDescriptor}）。 */
const REASONING_EFFORTS_SENT = Object.freeze(['off', 'medium', 'high'])
/** 一次在途流读取的空闲上限（与 peer 默认一致）。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000
/** 面板轮询快照的节奏，由 Host 下发，客户端跟随。 */
const POLL_SECONDS = 15
/** 状态文件版本；读侧遇到更高版本不覆写（别把新版写旧）。 */
const STATE_VERSION = 1

// ---------------------------------------------------------------------------
// 值读取：config 字段既可能是普通值，也可能是 schemastery 的访问器。
// 两种形状都读，写路径不依赖具体是哪一种。
// ---------------------------------------------------------------------------

function valueOf(raw, fallback) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    const value = raw.get()
    return value === undefined || value === null ? fallback : value
  }
  return raw
}

function str(raw, fallback) {
  const value = valueOf(raw, fallback)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function num(raw, fallback) {
  const value = Number(valueOf(raw, fallback))
  return Number.isFinite(value) ? value : fallback
}

function bool(raw, fallback) {
  const value = valueOf(raw, fallback)
  return typeof value === 'boolean' ? value : fallback
}

function strList(raw) {
  const value = valueOf(raw, [])
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

/** HTTP 层永不把异常原文直接吐给浏览器：可能带着 key。 */
function redact(text, secret) {
  let out = String(text ?? '')
  if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('<redacted>')
  return out.replace(/(sk-[A-Za-z0-9_-]{6,})/g, '<redacted>')
}

function normalizeBaseURL(raw) {
  return str(raw, DEFAULTS.baseURL).replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// Config：导出即定义「这一行可以钉死什么」。
//
// 面板**不写**这些字段（它写状态文件），所以这里保持普通字段：操作者在
// profile patch 里改它们会让本行重载，那是钉死默认值该有的代价。
// ---------------------------------------------------------------------------

export const Config = Schema.object({
  baseURL: Schema.string()
    .default(DEFAULTS.baseURL)
    .description('OpenAI 兼容源站根地址（含 /v1）。面板另存一份覆盖值，这里只是出厂默认。'),
  displayName: Schema.string()
    .default(DEFAULTS.displayName)
    .description('模型选择器里这条 provider 的显示名。'),
  apiKeyEnv: Schema.string()
    .default(DEFAULTS.apiKeyEnv)
    .description('存 API Key 的凭据引用名（值住 ~/.dsh/.credentials.yaml）。'),
  enabled: Schema.boolean()
    .default(DEFAULTS.enabled)
    .description('把网关注册成 DSH 的 LLM provider。'),
  enabledIds: Schema.array(Schema.string())
    .default([])
    .description('启用清单；空 = 不过滤（目录里每个 chat 模型都提供）。'),
  requestTimeoutMs: Schema.number()
    .default(DEFAULTS.requestTimeoutMs)
    .description('单次上游请求超时（毫秒）。'),
  cacheSeconds: Schema.number()
    .default(DEFAULTS.cacheSeconds)
    .description('模型目录缓存秒数。'),
  allowedHosts: Schema.array(Schema.string())
    .default([])
    .description('追加可信 Host 名（默认 localhost / 127.0.0.1 / ::1）。'),
})

/** patch 里的出厂默认值。 */
function configDefaults(config) {
  const raw = config ?? {}
  return {
    baseURL: normalizeBaseURL(raw.baseURL ?? DEFAULTS.baseURL),
    displayName: str(raw.displayName, DEFAULTS.displayName),
    apiKeyEnv: str(raw.apiKeyEnv, DEFAULTS.apiKeyEnv),
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    enabledIds: strList(raw.enabledIds),
    requestTimeoutMs: Math.min(Math.max(num(raw.requestTimeoutMs, DEFAULTS.requestTimeoutMs), 1_000), 600_000),
    cacheSeconds: Math.min(Math.max(num(raw.cacheSeconds, DEFAULTS.cacheSeconds), 0), 3_600),
    allowedHosts: strList(raw.allowedHosts),
  }
}

// ---------------------------------------------------------------------------
// 状态文件：面板改出来的东西都在这儿。
// ---------------------------------------------------------------------------

/** DSH 主目录：操作者导出了 `DSH_HOME` 就用它，否则回落到 `~/.dsh`。 */
function dshHome() {
  return str(process.env.DSH_HOME, join(homedir(), '.dsh'))
}

/** profile 名要直接成为路径的一段，所以按**外部输入**校验。 */
const PROFILE_SEGMENT_RE = /^(?!\.)[A-Za-z0-9._-]{1,64}$/

/** 当前 profile 名；取不到就是 `null`（退回共享目录，行为零漂移）。 */
function profileSegment(ctx) {
  const raw = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
  const name = raw !== null && typeof raw === 'object' ? raw.name : undefined
  return typeof name === 'string' && PROFILE_SEGMENT_RE.test(name.trim()) ? name.trim() : null
}

/** 本插件的状态目录。 */
function stateDir(ctx) {
  const profile = profileSegment(ctx)
  return profile === null ? join(dshHome(), 'state', NS) : join(dshHome(), 'state', profile, NS)
}

/** 读状态文件；缺失、不可读、非 JSON 一律当「没设过」。 */
async function readState(ctx) {
  const file = join(stateDir(ctx), 'state.json')
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const version = Number(parsed.version)
    // 比本构建新的文件不读语义（字段可能不同），但也不删——升级回滚要它还活着。
    if (!Number.isInteger(version) || version > STATE_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

/** 原子写状态文件：临时文件（0600）→ rename 落位。失败抛错，由调用方决定吞不吞。 */
async function writeState(ctx, body) {
  const dir = stateDir(ctx)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'state.json')
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(temporary, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}

/**
 * 读状态文件里的连接。
 *
 * 兼容 v0.3.x 的**扁平**形状（那时只有一条连接，字段都在顶层）。迁移是有意的：
 * 老用户在升级后不该丢失已存的端点、勾选和逐模型覆盖。
 *
 * @param {object} stored - 状态文件内容。
 * @param {object} defaults - patch 出厂默认。
 * @returns {object[]}
 */
function readStoredConnections(stored, defaults) {
  if (Array.isArray(stored.connections)) {
    const list = normalizeConnections(stored.connections)
    if (list.length > 0) return list
  }
  // ---- v0.3.x 扁平形状 → 一条连接 ----
  const legacy = {
    id: PROVIDER_ID,
    displayName: typeof stored.displayName === 'string' && stored.displayName.trim() !== '' ? stored.displayName : defaults.displayName,
    baseURL: typeof stored.baseURL === 'string' && stored.baseURL.trim() !== '' ? stored.baseURL : defaults.baseURL,
    apiKeyEnv: defaults.apiKeyEnv,
    enabled: stored.enabled,
    enabledIds: stored.enabledIds,
    autoEnableSpent: stored.autoEnableSpent,
    catalog: stored.catalog,
    catalogAt: stored.catalogAt,
    overlays: stored.overlays,
  }
  const connection = normalizeConnection(legacy, 0)
  return connection === null ? [] : [connection]
}

// ---------------------------------------------------------------------------
// 模型目录：GET {baseURL}/models。
// ---------------------------------------------------------------------------

/** 一条 id 能不能走 chat/completions。 */
function isChatModelId(id) {
  return typeof id === 'string' && id !== '' && !NON_CHAT_PATTERN.test(id)
}

/** 归一一条平台条目（只留本插件用得到的字段）。 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = str(raw.id, '')
  if (id === '') return null
  const name = str(raw.display_name, '') || str(raw.name, '') || id
  return { id, name, chat: isChatModelId(id) }
}

/** 归一一份持久化的目录（状态文件里的那一份，形状可能是旧的）。 */
function normalizeCatalog(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const row of raw) {
    const entry = normalizeEntry(row)
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out
}

/**
 * 拉一次模型目录。
 *
 * 失败**不抛**给面板，而是返回 `{ok:false, error}`：面板要把「key 不对」与
 * 「网络不通」分开说，而不是整页失效。
 *
 * @param {{baseURL: string, requestTimeoutMs: number}} cfg
 * @param {{apiKey: string}} deps
 * @returns {Promise<{ok: boolean, models: object[], error: string|null, errorCode: string|null}>}
 */
async function fetchCatalog(cfg, deps) {
  if (deps.apiKey === '') return { ok: false, models: [], error: null, errorCode: 'MISSING_CREDENTIAL' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs)
  try {
    const response = await fetch(`${cfg.baseURL}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${deps.apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      const detail = redact(text.slice(0, 400), deps.apiKey).replace(/\s+/g, ' ').trim()
      return {
        ok: false,
        models: [],
        error: `HTTP ${response.status}${detail === '' ? '' : ` — ${detail}`}`,
        errorCode: response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'UPSTREAM',
      }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, models: [], error: 'the /models response was not JSON', errorCode: 'MALFORMED' }
    }
    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : []
    return { ok: true, models: normalizeCatalog(rows), error: null, errorCode: null }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      ok: false,
      models: [],
      error: aborted ? `the model listing timed out after ${cfg.requestTimeoutMs} ms` : redact(error?.message ?? error, deps.apiKey),
      errorCode: aborted ? 'TIMEOUT' : 'NETWORK',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 归一一条「按模型覆盖」。
 *
 * 只认三个字段，其余全部丢弃——状态文件是面板写的，但也是磁盘上的普通 JSON，
 * 不该让它往 descriptor 里塞任意键。非法值一律**丢弃该字段**而不是整条丢，
 * 这样面板填了一个错数字不会把同一个模型的另外两个设置一起清掉。
 *
 * @param {unknown} raw
 * @returns {{contextWindow?: number, maxTokens?: number, input?: string[]}|null}
 */
function normalizeOverlay(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  const window = num(raw.contextWindow, 0)
  if (window > 0) out.contextWindow = Math.trunc(window)
  const max = num(raw.maxTokens, 0)
  if (max > 0) out.maxTokens = Math.trunc(max)
  if (Array.isArray(raw.input)) {
    const list = []
    for (const value of raw.input) {
      if (typeof value === 'string' && INPUT_MODALITIES.includes(value) && !list.includes(value)) list.push(value)
    }
    // 空数组在 dsh-llm-pi-ai 里表示「不表态」（`declaredInput` 把它当 undefined），
    // 所以只有真的挑到了模态才写入；否则这个字段等于没设。
    if (list.length > 0) out.input = list
  }
  return Object.keys(out).length === 0 ? null : out
}

/** 归一整张覆盖表：`{ modelId: overlay }`。 */
function normalizeOverlays(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, value] of Object.entries(raw)) {
    if (id === '' || id === HIDE_ALL_MODELS) continue
    const overlay = normalizeOverlay(value)
    if (overlay !== null) out[id] = overlay
  }
  return out
}

// ---------------------------------------------------------------------------
// 连接：一组端点 + 一个凭据引用 + 自己的目录/勾选/覆盖。
// ---------------------------------------------------------------------------

/**
 * 归一一条连接。
 *
 * 连接 id 同时是 provider 路由 id，所以校验是**安全边界**而不是形式：它会被拼
 * 进 `registerAdapter` 的路由名，也会出现在 `<provider>/<model>` 这种会话引用里。
 *
 * @param {unknown} raw
 * @param {number} index - 兜底 id 用的序号（只在 id 非法时用）。
 * @returns {object|null}
 */
function normalizeConnection(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = str(raw.id, '')
  if (!CONNECTION_ID_RE.test(id)) return null
  return {
    id,
    displayName: str(raw.displayName, id),
    baseURL: normalizeBaseURL(raw.baseURL),
    apiKeyEnv: str(raw.apiKeyEnv, `QPCM_API_KEY_${id.replace(/-/g, '_').toUpperCase()}`),
    enabled: bool(raw.enabled, false),
    enabledIds: strList(raw.enabledIds),
    autoEnableSpent: raw.autoEnableSpent === true,
    catalog: normalizeCatalog(raw.catalog),
    catalogAt: num(raw.catalogAt, 0),
    catalogError: typeof raw.catalogError === 'string' ? raw.catalogError : null,
    catalogErrorCode: typeof raw.catalogErrorCode === 'string' ? raw.catalogErrorCode : null,
    overlays: normalizeOverlays(raw.overlays),
  }
}

/** 归一整张连接表；id 重复的只留第一条。 */
function normalizeConnections(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const [index, row] of raw.entries()) {
    const connection = normalizeConnection(row, index)
    if (connection === null || seen.has(connection.id)) continue
    seen.add(connection.id)
    out.push(connection)
    if (out.length >= MAX_CONNECTIONS) break
  }
  return out
}

/** 造一条默认连接（第一次装上、或状态文件损坏时用）。 */
function defaultConnection(defaults) {
  return {
    id: PROVIDER_ID,
    displayName: defaults.displayName,
    baseURL: defaults.baseURL,
    apiKeyEnv: defaults.apiKeyEnv,
    enabled: defaults.enabled,
    enabledIds: [...defaults.enabledIds],
    autoEnableSpent: false,
    catalog: [],
    catalogAt: 0,
    catalogError: null,
    catalogErrorCode: null,
    overlays: {},
  }
}

/** 一条连接对外暴露的身份（不含目录等大块内容）。 */
function connectionSummary(connection) {
  return {
    id: connection.id,
    displayName: connection.displayName,
    baseURL: connection.baseURL,
    apiKeyEnv: connection.apiKeyEnv,
    enabled: connection.enabled,
    enabledIds: connection.enabledIds,
    catalogAt: connection.catalogAt,
    catalogError: connection.catalogError,
    catalogErrorCode: connection.catalogErrorCode,
  }
}

/**
 * 目录条目 → pi-ai model descriptor。
 *
 * 协议选 `openai-responses` 而不是 `openai-completions`：实测这个网关两个端点
 * 都通，但 `/responses` 多出三样东西——`reasoning.effort` 真的能调、推理内容
 * 以独立的 `reasoning` 条目回来、`previous_response_id` 之外还能整条回放
 * `encrypted_content`（已逐条验证 200）。文本、工具、流式、多轮回放在
 * `/responses` 上全部实测通过。
 *
 * `compat.supportsDeveloperRole: false` 是有意的：pi-ai 缺省会**自动探测**这个
 * 标志，对非标准 provider 一律猜 `true`，于是每条请求都用 `developer` 角色。
 * 网关是多模型代理，`system` 才是每个后端都认的那一种写法。
 *
 * `maxTokens` 不声明：目录没给上限，猜一个数字会把「平台没说」写成「平台说了」。
 *
 * `thinkingLevelMap` 只映射**实测有推理产出**的档位。四个档位实测（难题上
 * `reasoning_tokens`）：
 *
 *   minimal  0 / 0 / 0 / 121 / —      ← 多数模型不产出
 *   low     67 / 65 / 0 / 0 / 146     ← 半数模型不产出
 *   medium  24 /146 /100 / 0 / 515
 *   high   328 /516 /261 /516 / 79
 *
 * `off` 映射到 `'none'`：pi-ai 在「不思考」时发的就是这个字面量，网关接受
 * （五个模型逐个验证 200）。`minimal`/`low` 显式钉成 `null`——留着它们等于
 * 在菜单里承诺两个多数模型上什么都不做的档位。
 *
 * 三个字段可被面板逐模型覆盖（`overlay`）：`contextWindow`、`maxTokens`、
 * `input`。它们都真的影响请求——`maxTokens` 经
 * `clampMaxTokensToContext(model, context, maxTokens)` 落到
 * `max_output_tokens`（再被 contextWindow 截断），`input` 决定能不能收图。
 * 不覆盖时保持这里的原样：窗口用 128k 兜底、`maxTokens` **不声明**（目录没给
 * 上限，猜一个数字会把「平台没说」写成「平台说了」）、模态只有 `text`。
 *
 * @param {object} entry - 目录条目（至少 `{id, name}`）。
 * @param {{id: string, baseURL: string}} connection - 这条模型所属的连接；`id` 即 provider 路由。
 * @param {{contextWindow?: number, maxTokens?: number, input?: string[]}|undefined} overlay
 */
function toDescriptor(entry, connection, overlay) {
  return {
    id: entry.id,
    name: entry.name,
    api: WIRE_API,
    // 必须跟着连接走：descriptor 的 provider 决定这条模型归属哪个路由，
    // 写死会让所有连接都声称自己属于第一条。
    provider: connection.id,
    baseUrl: connection.baseURL,
    input: overlay?.input ?? ['text'],
    reasoning: true,
    cost: { ...NO_COST },
    contextWindow: overlay?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    ...(overlay?.maxTokens === undefined ? {} : { maxTokens: overlay.maxTokens }),
    thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: 'medium', high: 'high' },
    compat: { supportsDeveloperRole: false },
  }
}

/**
 * 按启用清单过滤：哨兵 → 一个都不给；空清单 → 全部 chat 模型；否则严格白名单。
 *
 * @param {object[]} models - 目录条目。
 * @param {string[]} enabledIds - 线的编码，见 {@link HIDE_ALL_MODELS}。
 * @returns {object[]} 要提供给 DSH 的条目。
 */
function filterByEnabled(models, enabledIds) {
  if (enabledIds.includes(HIDE_ALL_MODELS)) return []
  const chat = models.filter((entry) => entry.chat === true)
  if (enabledIds.length === 0) return chat
  const allow = new Set(enabledIds)
  return chat.filter((entry) => allow.has(entry.id))
}

/** 清单的判别式：`all` | `none` | `list`。 */
function selectionOf(enabledIds) {
  if (enabledIds.includes(HIDE_ALL_MODELS)) return 'none'
  return enabledIds.length === 0 ? 'all' : 'list'
}

// ---------------------------------------------------------------------------
// 适配器：peer 依赖的那一半，动态 import，只 memoize 成功。
// ---------------------------------------------------------------------------

/** inert pi-ai auth 平面：认证只走本插件自己的凭据解析器。 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {},
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

let adapterModulePromise

/**
 * 加载 peer 模块。
 *
 * 只 memoize **成功**：把 promise 本身钉在槽里意味着一次 `import()` 失败之后，
 * 即使操作者把 peer 装好了，本进程也永远救不回来——可恢复的安装问题会变成
 * 「必须重启 Host」。
 */
function loadAdapterModule() {
  if (adapterModulePromise === undefined) {
    adapterModulePromise = Promise.all([
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-ai/api/openai-responses.lazy'),
      import('@deepseek-ai/dsh-llm-pi-ai'),
      import('@deepseek-ai/dsh-llm'),
    ]).catch((error) => {
      adapterModulePromise = undefined
      throw error
    })
  }
  return adapterModulePromise
}

/**
 * 装配一个 `PiAiAdapter`，服务**所有**连接。
 *
 * 一个适配器带多份 profile，而不是每条连接一个适配器：`registerAdapter` 接受
 * provider 数组，且 `resolveApiKey(provider, profile)` 带 provider 参数——所以
 * 「一组一个 key」不需要多个适配器，一个就够，启停与注销也只有一处状态。
 *
 * 读模型是**活读**：每次 `profiles()` 被调用时重算全部连接的 descriptor，变了
 * 就换一份新的 Map（`PiAiAdapter` 靠 Map 身份判断快照是否过期）。
 *
 * @param {{readConnections: () => object[],
 *   readModelsFor: (connection: object) => object[],
 *   resolveApiKey: (providerId: string) => Promise<string>,
 *   get: (name: string) => unknown}} options
 * @returns {Promise<{adapter: object}>}
 */
async function buildAdapter(options) {
  const [{ createProvider }, { openAIResponsesApi }, { PiAiAdapter }, { resolveRetryPolicy, resolveImageAttachmentAccess }] =
    await loadAdapterModule()
  const { readConnections, readModelsFor, get } = options
  let profiles = new Map()
  let signature = ''

  /**
   * 一个 provider 对象 = 一条连接。
   *
   * `createProvider` 的 `id` 必须是路由 id，否则 pi-ai 无法把模型归属回这条路由。
   */
  const buildProvider = (connection, models) => ({
    ...createProvider({
      id: connection.id,
      name: connection.displayName,
      auth: {
        apiKey: {
          name: `${connection.displayName} API key`,
          async resolve({ credential } = {}) {
            const key = credential?.key
            return key === undefined || key.length === 0 ? undefined : { auth: { apiKey: key }, source: connection.displayName }
          },
        },
      },
      models,
      api: openAIResponsesApi(),
    }),
    getModels: () => models,
  })

  /**
   * 重建 profiles，但只在真的变了的时候换对象（否则每次操作都是一份新快照）。
   *
   * 指纹必须覆盖 descriptor 里**所有**可能变的东西，以及每条连接的显示名与
   * baseURL——漏掉任何一项都会出现「面板上改了、实际请求还是老值」。
   */
  const refresh = () => {
    const connections = readConnections()
    const parts = []
    const next = new Map()
    for (const connection of connections) {
      const models = readModelsFor(connection)
      parts.push(`${connection.id}@${connection.baseURL}#${connection.displayName}`)
      for (const model of models) {
        parts.push(
          `${model.id}:${model.contextWindow}:${model.maxTokens ?? '-'}:${(model.input ?? []).join('+')}`,
        )
      }
      next.set(connection.id, {
        provider: connection.id,
        displayName: connection.displayName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, `${NS}.${connection.id}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        maxRequestImageBytes: 20_971_520,
        requestImagePixelBudget: 4_194_304,
        requestImageMaxBytes: 1_048_576,
        piProvider: buildProvider(connection, models),
      })
    }
    const nextSignature = parts.join('|')
    if (nextSignature === signature) return
    signature = nextSignature
    profiles = next
  }

  const adapter = new PiAiAdapter({
    profiles: () => {
      refresh()
      return profiles
    },
    auth: INERT_AUTH,
    // provider 参数在这里是关键：每条连接用各自的凭据引用，互不串用。
    resolveApiKey: async (providerId) => resolveApiKey(providerId),
    resolveAttachments: () => get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => get('fs')?.processPathFromHostPath?.(hostPath), ref),
  })

  return { adapter }
}

// ---------------------------------------------------------------------------
// HTTP：面板唯一的读写面。同源围栏 + 写操作恒 200 的域结果。
// ---------------------------------------------------------------------------

/** HTML 里那几个默认可信 Host，与 peer 一致。 */
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1']

/** 剥端口并小写；IPv6 字面量要连方括号一起剥。 */
function hostName(host) {
  if (typeof host !== 'string') return ''
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/** 同源围栏：Host 必须是可信名，Origin（若有）必须与 Host 一致。 */
function isAdmitted(request, allowedHosts) {
  const host = typeof request.headers?.host === 'string' ? request.headers.host.toLowerCase() : ''
  if (host === '' || !allowedHosts.has(hostName(host))) return false
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host.toLowerCase() === host
  } catch {
    return false
  }
}

function writeJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(payload)
}

/** 读一个 JSON 请求体；坏了回 400 并返回 null。 */
async function readJsonBody(request, response) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_048_576) {
      writeJson(response, 413, { ok: false, error: 'request body too large' })
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeJson(response, 400, { ok: false, error: 'expected a JSON object' })
      return null
    }
    return parsed
  } catch {
    writeJson(response, 400, { ok: false, error: 'request body was not JSON' })
    return null
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * Host 入口。
 *
 * @param ctx - Host 根上下文（硬依赖只有 `webServer`，其余都是可选的）。
 * @param config - 这一行的 patch 配置（出厂默认值）。
 */
/**
 * Host 入口。
 *
 * @param ctx - Host 根上下文（硬依赖只有 `webServer`，其余都是可选的）。
 * @param config - 这一行的 patch 配置（出厂默认值）。
 */
export function apply(ctx, config) {
  const defaults = configDefaults(config)

  /**
   * 面板可写的运行时状态。
   *
   * `connections` 是唯一的事实来源：每条连接自带端点、凭据引用、目录、勾选、
   * 逐模型覆盖。原来那套顶层的 baseURL/enabled/catalog/overlays 全部收进去了。
   */
  const state = {
    connections: [],
    /** 适配器注册句柄。 */
    release: null,
    /** 已装配的适配器。 */
    built: null,
    /** provider 目录条目句柄。 */
    releaseDirectory: null,
    /** 注册失败原因（已脱敏）。 */
    registerError: null,
  }

  /** 按 id 找连接。 */
  const find = (id) => state.connections.find((connection) => connection.id === id) ?? null

  /** 现读凭据：每次操作都重读，面板刚存的 key 对下一次调用立刻生效。 */
  const readApiKey = async (connection) => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return ''
    const hit = await credentials.resolve(connection.apiKeyEnv).catch(() => undefined)
    const value = hit?.value
    return typeof value === 'string' ? value : ''
  }

  /** 一条连接要提供的 descriptor 清单（活读）。 */
  const descriptorsFor = (connection) =>
    filterByEnabled(connection.catalog, connection.enabledIds).map((entry) =>
      toDescriptor(entry, connection, connection.overlays[entry.id]),
    )

  /** 把状态落盘；失败只记录，不影响内存里的行为。 */
  const persist = async () => {
    try {
      await writeState(ctx, {
        version: STATE_VERSION,
        connections: state.connections.map((connection) => ({
          id: connection.id,
          displayName: connection.displayName,
          baseURL: connection.baseURL,
          apiKeyEnv: connection.apiKeyEnv,
          enabled: connection.enabled,
          enabledIds: connection.enabledIds,
          autoEnableSpent: connection.autoEnableSpent,
          catalog: connection.catalog.map((entry) => ({ id: entry.id, name: entry.name, chat: entry.chat })),
          catalogAt: connection.catalogAt,
          catalogError: connection.catalogError,
          catalogErrorCode: connection.catalogErrorCode,
          overlays: connection.overlays,
        })),
      })
    } catch (error) {
      ctx.logger?.warn?.(`${NS}: could not persist plugin state: ${redact(error?.message ?? error)}`)
    }
  }

  /**
   * 注册（或撤销）provider：目录条目常驻，适配器只服务已启用的连接。
   *
   * 目录条目常驻是有意的——它让 Settings → Models 里始终看得见这条路，即使
   * 现在没启用，也能显示「已声明、未配置」。适配器才是真正提供模型的那一半。
   */
  const reconcile = async () => {
    const llm = ctx.get('llm')
    if (llm === undefined) {
      state.registerError = 'this Host has no llm service'
      return
    }
    try {
      if (state.built === null) {
        state.built = await buildAdapter({
          readConnections: () => state.connections.filter((connection) => connection.enabled === true),
          readModelsFor: descriptorsFor,
          resolveApiKey: async (providerId) => {
            const connection = find(providerId)
            if (connection === null) return ''
            const key = await readApiKey(connection)
            if (key === '') {
              const { LlmError } = await import('@deepseek-ai/dsh-llm')
              throw new LlmError(
                `${NS}: no API key for provider route "${providerId}" — open the plugin panel and save one under the credential reference "${connection.apiKeyEnv}"`,
                'MISSING_CREDENTIAL',
              )
            }
            return key
          },
          get: (name) => ctx.get(name),
        })
      }

      if (typeof llm.registerConfigurableProviders === 'function') {
        const directory = state.connections.map((connection) => ({
          provider: connection.id,
          displayName: connection.displayName,
          settingsNs: NS,
          settingsPath: [],
          declared: false,
        }))
        if (state.releaseDirectory === null) {
          if (directory.length > 0) state.releaseDirectory = llm.registerConfigurableProviders(directory)
        } else {
          state.releaseDirectory.replace(directory)
        }
      }

      // 启用的连接才进适配器路由表。全部停用时也必须注册过至少一条——
      // registerAdapter 不接受空数组，所以「全关」等于「不注册」。
      const active = state.connections.filter((connection) => connection.enabled === true).map((connection) => connection.id)
      if (state.release === null) {
        if (active.length > 0) state.release = llm.registerAdapter(active, state.built.adapter)
      } else if (active.length === 0) {
        state.release()
        state.release = null
      } else {
        state.release.replace(active)
      }
      state.registerError = null
    } catch (error) {
      state.registerError = redact(error?.message ?? error)
      ctx.logger?.warn?.(`${NS}: provider registration failed: ${state.registerError}`)
      for (const key of ['release', 'releaseDirectory']) {
        if (state[key] === null) continue
        try {
          state[key]()
        } catch {}
        state[key] = null
      }
    }
  }

  /** 拉一条连接的目录（带 TTL），落盘，并重新对账注册状态。 */
  const refreshCatalog = async (connection, { force = false } = {}) => {
    const fresh =
      connection.catalogAt !== 0 && Date.now() - connection.catalogAt < defaults.cacheSeconds * 1000
    if (!force && fresh) {
      await reconcile()
      return {
        ok: connection.catalogError === null,
        models: connection.catalog,
        error: connection.catalogError,
        errorCode: connection.catalogErrorCode,
      }
    }
    const result = await fetchCatalog(
      { baseURL: connection.baseURL, requestTimeoutMs: defaults.requestTimeoutMs },
      { apiKey: await readApiKey(connection) },
    )
    if (result.ok) {
      connection.catalog = result.models
      connection.catalogAt = Date.now()
    }
    // 失败时**保留**上一次的目录：key 过期不等于「模型全没了」，把清单清空会
    // 让操作者正在用的模型在下一次请求里变成 UNKNOWN_MODEL。
    connection.catalogError = result.error
    connection.catalogErrorCode = result.errorCode
    await reconcile()
    await persist()
    return result
  }

  /** 面板快照：面板需要知道的全部事实，一次给齐。 */
  const snapshot = async () => {
    const credentials = ctx.get('credentials')
    const llm = ctx.get('llm')
    const connections = []
    for (const connection of state.connections) {
      let credential = {
        ref: connection.apiKeyEnv,
        configured: false,
        writable: credentials !== undefined,
        source: null,
      }
      if (credentials !== undefined) {
        const info = await credentials.describe(connection.apiKeyEnv).catch(() => undefined)
        if (info !== undefined) {
          credential = {
            ref: connection.apiKeyEnv,
            configured: info.configured === true,
            writable: info.writable !== false,
            source: info.source ?? null,
          }
        }
      }
      const selection = selectionOf(connection.enabledIds)
      const chat = connection.catalog.filter((entry) => entry.chat === true)
      const offered = filterByEnabled(connection.catalog, connection.enabledIds)
      connections.push({
        ...connectionSummary(connection),
        credential,
        protocol: {
          api: WIRE_API,
          endpoint: `${connection.baseURL}/responses`,
          efforts: REASONING_EFFORTS_SENT,
        },
        catalog: {
          error: connection.catalogError,
          errorCode: connection.catalogErrorCode,
          fetchedAt: connection.catalogAt,
          modelCount: chat.length,
          offeredCount: offered.length,
          selection,
          models: connection.catalog.map((entry) => {
            const overlay = connection.overlays[entry.id]
            return {
              id: entry.id,
              name: entry.name,
              chat: entry.chat,
              selected:
                entry.chat === true &&
                (selection === 'all' || (selection === 'list' && connection.enabledIds.includes(entry.id))),
              // 面板要显示「实际生效」的值，而不是「你填过的」值：没覆盖时把兜底
              // 值一起送出去，否则输入框空着，用户不知道背后跑的是什么。
              limits: {
                contextWindow: overlay?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
                maxTokens: overlay?.maxTokens ?? null,
                input: overlay?.input ?? ['text'],
              },
              // 哪些字段是人手工设过的（面板据此标「自定义」）。
              overridden: Object.keys(overlay ?? {}),
            }
          }),
        },
      })
    }
    return {
      ok: true,
      name: NS,
      pollSeconds: POLL_SECONDS,
      maxConnections: MAX_CONNECTIONS,
      defaults: {
        baseURL: defaults.baseURL,
        displayName: defaults.displayName,
        apiKeyEnv: defaults.apiKeyEnv,
        requestTimeoutMs: defaults.requestTimeoutMs,
        cacheSeconds: defaults.cacheSeconds,
      },
      provider: {
        llmAvailable: llm !== undefined,
        registered: state.release !== null,
        directoryDeclared: state.releaseDirectory !== null,
        error: state.registerError,
      },
      connections,
    }
  }

  /**
   * 归一一条「连接身份」的输入。
   *
   * id 可以不给：新建时由 displayName / baseURL 派生一个不冲突的。
   */
  const connectionIdFor = (body) => {
    const requested = str(body.id, '')
    if (requested !== '') return CONNECTION_ID_RE.test(requested) ? requested : null
    // 从显示名/主机名派一个 slug；实在没有就用序号。
    const seed = str(body.displayName, '') || str(body.baseURL, '')
    let slug = seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
    if (slug === '' || slug.length < 2) slug = `connection-${state.connections.length + 1}`
    let candidate = slug
    let n = 2
    while (state.connections.some((connection) => connection.id === candidate)) {
      candidate = `${slug.slice(0, 40)}-${n}`
      n += 1
    }
    return CONNECTION_ID_RE.test(candidate) ? candidate : null
  }

  /** 每个路由共用的一道门：同源围栏 + 方法判定。 */
  const route = (handler, methods) => {
    return async (request, response) => {
      const allowedHosts = new Set([...DEFAULT_ALLOWED_HOSTS, ...defaults.allowedHosts])
      if (!isAdmitted(request, allowedHosts)) {
        writeJson(response, 403, { ok: false, error: 'forbidden: unexpected Host/Origin' })
        return
      }
      const method = request.method === undefined ? 'GET' : request.method
      if (!methods.includes(method)) {
        writeJson(response, 405, { ok: false, error: `method ${method} is not allowed here` }, { allow: methods.join(', ') })
        return
      }
      try {
        await handler(request, response)
      } catch (error) {
        writeJson(response, 200, { ok: false, error: redact(error?.message ?? error) })
      }
    }
  }

  const offs = []

  // ---- GET /api/<ns>/snapshot：面板轮询的只读面 ----
  offs.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `/api/${NS}/snapshot`,
      handler: route(async (request, response) => {
        writeJson(response, 200, await snapshot())
      }, ['GET', 'HEAD']),
    }),
  )

  // ---- POST /api/<ns>/connections：新增 / 改 / 删一条连接 ----
  offs.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `/api/${NS}/connections`,
      handler: route(async (request, response) => {
        const body = await readJsonBody(request, response)
        if (body === null) return
        const action = str(body.action, 'update')

        if (action === 'create') {
          if (state.connections.length >= MAX_CONNECTIONS) {
            writeJson(response, 200, { ok: false, error: `at most ${MAX_CONNECTIONS} connections` })
            return
          }
          const id = connectionIdFor(body)
          if (id === null) {
            writeJson(response, 200, { ok: false, error: 'could not derive a usable connection id' })
            return
          }
          const connection = defaultConnection(defaults)
          connection.id = id
          connection.displayName = str(body.displayName, `QPCM API ${state.connections.length + 1}`)
          // 新建的默认关着、默认不继承旧端点：让用户自己填，避免悄悄复用。
          connection.baseURL = normalizeBaseURL(body.baseURL ?? DEFAULTS.baseURL)
          connection.apiKeyEnv = str(body.apiKeyEnv, `QPCM_API_KEY_${id.replace(/-/g, '_').toUpperCase()}`)
          connection.enabled = false
          connection.enabledIds = []
          state.connections.push(connection)
          await reconcile()
          await persist()
          writeJson(response, 200, { ok: true, connection: connectionSummary(connection) })
          return
        }

        const id = str(body.id, '')
        const connection = find(id)
        if (connection === null) {
          writeJson(response, 200, { ok: false, error: `no connection "${id}"` })
          return
        }

        if (action === 'delete') {
          state.connections = state.connections.filter((row) => row.id !== id)
          await reconcile()
          await persist()
          writeJson(response, 200, { ok: true, deleted: id })
          return
        }

        // update
        let touched = false
        if (typeof body.baseURL === 'string' && body.baseURL.trim() !== '') {
          const next = normalizeBaseURL(body.baseURL)
          if (next !== connection.baseURL) {
            // 端点变了 = 换了一个目录，旧清单必须丢掉。
            connection.catalog = []
            connection.catalogAt = 0
            connection.catalogError = null
            connection.catalogErrorCode = null
          }
          connection.baseURL = next
          touched = true
        }
        if (typeof body.displayName === 'string' && body.displayName.trim() !== '') {
          connection.displayName = body.displayName.trim()
          touched = true
        }
        if (typeof body.enabled === 'boolean') {
          connection.enabled = body.enabled
          // 人一旦亲手拨过开关，自动接入就不再掺和。
          connection.autoEnableSpent = true
          touched = true
        }
        if (Array.isArray(body.enabledIds)) {
          connection.enabledIds = strList(body.enabledIds)
          touched = true
        }
        if (!touched) {
          writeJson(response, 200, { ok: false, error: 'nothing to change' })
          return
        }
        await reconcile()
        await persist()
        writeJson(response, 200, { ok: true, connection: connectionSummary(connection) })
      }, ['POST']),
    }),
  )

  // ---- POST /api/<ns>/key：存 / 清某条连接的 API Key ----
  offs.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `/api/${NS}/key`,
      handler: route(async (request, response) => {
        const body = await readJsonBody(request, response)
        if (body === null) return
        const credentials = ctx.get('credentials')
        if (credentials === undefined) {
          writeJson(response, 200, { ok: false, error: 'this Host has no credentials service' })
          return
        }
        const connection = find(str(body.id, ''))
        if (connection === null) {
          writeJson(response, 200, { ok: false, error: `no connection "${str(body.id, '')}"` })
          return
        }
        const ref = connection.apiKeyEnv
        if (body.clear === true) {
          await credentials.unset(ref)
          connection.catalog = []
          connection.catalogAt = 0
          connection.catalogError = null
          connection.catalogErrorCode = null
          await reconcile()
          await persist()
          writeJson(response, 200, { ok: true, cleared: true })
          return
        }
        const value = typeof body.value === 'string' ? body.value.trim() : ''
        if (value === '') {
          writeJson(response, 200, { ok: false, error: 'the API key must not be empty' })
          return
        }
        await credentials.set(ref, value)
        // 存完立刻试拉一次目录：面板上「保存」与「能不能用」是同一件事。
        const result = await refreshCatalog(connection, { force: true })
        // 目录拉通就顺手把这条连接挂上：装完之后少一次「还要再点一下开关」。
        // 只在首次接入时自动开（原本就是关着、且没有任何历史勾选意图），
        // 用户主动关掉之后不会因为重存 key 又被打开。
        if (
          result.ok &&
          connection.enabled !== true &&
          connection.enabledIds.length === 0 &&
          connection.autoEnableSpent !== true
        ) {
          connection.enabled = true
          connection.autoEnableSpent = true
          await reconcile()
          await persist()
        }
        writeJson(response, 200, {
          ok: true,
          autoEnabled: connection.enabled === true,
          catalog: { ok: result.ok, error: result.error, errorCode: result.errorCode, modelCount: result.models.length },
        })
      }, ['POST']),
    }),
  )

  // ---- POST /api/<ns>/refresh：重新拉一条连接的目录 ----
  offs.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `/api/${NS}/refresh`,
      handler: route(async (request, response) => {
        const body = await readJsonBody(request, response)
        if (body === null) return
        const connection = find(str(body.id, ''))
        if (connection === null) {
          writeJson(response, 200, { ok: false, error: `no connection "${str(body.id, '')}"` })
          return
        }
        const result = await refreshCatalog(connection, { force: true })
        writeJson(response, 200, {
          ok: result.ok,
          error: result.error,
          errorCode: result.errorCode,
          modelCount: result.models.length,
        })
      }, ['POST']),
    }),
  )

  // ---- POST /api/<ns>/limits：按模型覆盖 contextWindow / maxTokens / input ----
  offs.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `/api/${NS}/limits`,
      handler: route(async (request, response) => {
        const body = await readJsonBody(request, response)
        if (body === null) return
        const connection = find(str(body.id, ''))
        if (connection === null) {
          writeJson(response, 200, { ok: false, error: `no connection "${str(body.id, '')}"` })
          return
        }
        const modelId = str(body.model, '')
        if (modelId === '') {
          writeJson(response, 200, { ok: false, error: 'a model id is required' })
          return
        }
        // `reset` 或三个字段全空 = 回到默认（删掉这一条覆盖）。
        const overlay = body.reset === true ? null : normalizeOverlay(body)
        if (overlay === null) delete connection.overlays[modelId]
        else connection.overlays[modelId] = overlay
        // descriptor 变了就得让适配器重建（maxTokens / contextWindow 进的是
        // pi-ai 的 model 对象，不是每次请求现算的）。reconcile 负责这件事。
        await reconcile()
        await persist()
        const current = connection.overlays[modelId]
        writeJson(response, 200, {
          ok: true,
          model: modelId,
          limits: {
            contextWindow: current?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            maxTokens: current?.maxTokens ?? null,
            input: current?.input ?? ['text'],
          },
          overridden: Object.keys(current ?? {}),
        })
      }, ['POST']),
    }),
  )

  // ---- 挂载：读状态 → 注册 → 拉目录；卸载时清干净 ----
  ctx.effect(() => {
    let disposed = false
    void (async () => {
      const stored = await readState(ctx)
      if (disposed) return
      if (stored !== null) {
        const connections = readStoredConnections(stored, defaults)
        if (connections.length > 0) state.connections = connections
      }
      if (state.connections.length === 0) state.connections = [defaultConnection(defaults)]
      // 先用（可能来自磁盘的）目录把 provider 挂上，冷启动时模型选择器立刻就
      // 认得出这些 id；随后再联网刷新。
      await reconcile()
      if (disposed) return
      for (const connection of state.connections) {
        await refreshCatalog(connection, { force: false }).catch((error) => {
          ctx.logger?.warn?.(`${NS}: catalog refresh failed: ${redact(error?.message ?? error)}`)
        })
        if (disposed) return
      }
    })()

    return () => {
      disposed = true
      for (const off of offs.splice(0)) {
        try {
          off?.()
        } catch {}
      }
      for (const key of ['release', 'releaseDirectory']) {
        if (state[key] === null) continue
        try {
          state[key]()
        } catch {}
        state[key] = null
      }
    }
  }, `${NS}: routes`)
}

/** 硬依赖只有 `webServer`；settings / credentials / llm 都是可选服务。 */
export const inject = ['webServer']

export const name = NS
