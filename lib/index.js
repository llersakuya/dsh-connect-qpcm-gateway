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
 * 本插件注册的 provider 路由 id。
 *
 * **不能**复用配置里已有的 `gpt-2610` / `ds-v41-flash`：`registerAdapter` 对已
 * 占用路由**整组拒绝**（`DUPLICATE_ADAPTER`），而那几条是操作者自己写在
 * `llm-pi-ai` 里的，本插件不得抢占。
 */
const PROVIDER_ID = 'qpcm-gateway'

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
 */
function toDescriptor(entry, cfg) {
  return {
    id: entry.id,
    name: entry.name,
    api: WIRE_API,
    provider: PROVIDER_ID,
    baseUrl: cfg.baseURL,
    input: ['text'],
    reasoning: true,
    cost: { ...NO_COST },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
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
 * 装配一个 `PiAiAdapter`。
 *
 * `readModels` 是**活读**：每次 `profiles()` 被调用时拿当前模型清单，清单变了
 * 就换一份新的 Map（`PiAiAdapter` 靠 Map 身份判断快照是否过期）。
 *
 * @param {{providerId: string, displayName: string, readModels: () => object[],
 *   readBaseURL: () => string, resolveApiKey: () => Promise<string>,
 *   get: (name: string) => unknown}} options
 * @returns {Promise<{adapter: object, setDisplayName: (name: string) => void}>}
 */
async function buildAdapter(options) {
  const [{ createProvider }, { openAIResponsesApi }, { PiAiAdapter }, { resolveRetryPolicy, resolveImageAttachmentAccess }] =
    await loadAdapterModule()
  const { providerId, readModels, readBaseURL, resolveApiKey, get } = options
  let displayName = options.displayName
  let profiles = new Map()
  let signature = ''

  const buildProvider = (models) => ({
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: 'QPCM gateway API key',
          async resolve({ credential } = {}) {
            const key = credential?.key
            return key === undefined || key.length === 0 ? undefined : { auth: { apiKey: key }, source: displayName }
          },
        },
      },
      models,
      api: openAIResponsesApi(),
    }),
    getModels: () => models,
  })

  /** 重建 profiles，但只在真的变了的时候换对象（否则每次操作都是一份新快照）。 */
  const refresh = () => {
    const models = readModels()
    const nextSignature = `${displayName}|${readBaseURL()}|${models.map((model) => model.id).join(',')}`
    if (nextSignature === signature) return
    signature = nextSignature
    profiles = new Map([
      [
        providerId,
        {
          provider: providerId,
          displayName,
          streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
          retryPolicy: resolveRetryPolicy(undefined, `${NS}.${providerId}.retryPolicy`),
          configuredMaxTokens: new Map(),
          modelErrors: new Map(),
          maxRequestImageBytes: 20_971_520,
          requestImagePixelBudget: 4_194_304,
          requestImageMaxBytes: 1_048_576,
          piProvider: buildProvider(models),
        },
      ],
    ])
  }

  const adapter = new PiAiAdapter({
    profiles: () => {
      refresh()
      return profiles
    },
    auth: INERT_AUTH,
    resolveApiKey: async () => resolveApiKey(),
    resolveAttachments: () => get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => get('fs')?.processPathFromHostPath?.(hostPath), ref),
  })

  return {
    adapter,
    setDisplayName: (next) => {
      if (next === displayName) return
      displayName = next
      refresh()
    },
  }
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
export function apply(ctx, config) {
  const defaults = configDefaults(config)

  /** 面板可写的运行时状态；`catalog` 是上一次拉到的目录（也用于冷启动）。 */
  const state = {
    baseURL: defaults.baseURL,
    displayName: defaults.displayName,
    enabled: defaults.enabled,
    enabledIds: [...defaults.enabledIds],
    catalog: [],
    catalogAt: 0,
    catalogError: null,
    catalogErrorCode: null,
    /** 适配器注册句柄。 */
    release: null,
    /** 已装配的适配器。 */
    built: null,
    /** provider 目录条目句柄。 */
    releaseDirectory: null,
    /** 注册失败原因（已脱敏）。 */
    registerError: null,
  }

  /** 生效配置 = 状态 ?? 出厂默认。 */
  const effective = () => ({
    baseURL: state.baseURL,
    displayName: state.displayName,
    apiKeyEnv: defaults.apiKeyEnv,
    enabled: state.enabled,
    enabledIds: state.enabledIds,
    requestTimeoutMs: defaults.requestTimeoutMs,
    cacheSeconds: defaults.cacheSeconds,
    allowedHosts: defaults.allowedHosts,
  })

  /** 现读凭据：每次操作都重读，面板刚存的 key 对下一次调用立刻生效。 */
  const readApiKey = async () => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return ''
    const hit = await credentials.resolve(defaults.apiKeyEnv).catch(() => undefined)
    const value = hit?.value
    return typeof value === 'string' ? value : ''
  }

  /** 适配器要的 descriptor 清单（活读：面板改了清单立刻反映到下一次操作）。 */
  const readDescriptors = () => {
    const cfg = effective()
    return filterByEnabled(state.catalog, cfg.enabledIds).map((entry) => toDescriptor(entry, cfg))
  }

  /** 把状态落盘；失败只记录，不影响内存里的行为。 */
  const persist = async () => {
    try {
      await writeState(ctx, {
        version: STATE_VERSION,
        baseURL: state.baseURL,
        displayName: state.displayName,
        enabled: state.enabled,
        enabledIds: state.enabledIds,
        catalog: state.catalog.map((entry) => ({ id: entry.id, name: entry.name, chat: entry.chat })),
        catalogAt: state.catalogAt,
      })
    } catch (error) {
      ctx.logger?.warn?.(`${NS}: could not persist plugin state: ${redact(error?.message ?? error)}`)
    }
  }

  /**
   * 注册（或撤销）provider：目录条目常驻，适配器只在启用时注册。
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
    const cfg = effective()
    try {
      if (state.built === null) {
        state.built = await buildAdapter({
          providerId: PROVIDER_ID,
          displayName: cfg.displayName,
          readModels: readDescriptors,
          readBaseURL: () => effective().baseURL,
          resolveApiKey: async () => {
            const key = await readApiKey()
            if (key === '') {
              const { LlmError } = await import('@deepseek-ai/dsh-llm')
              throw new LlmError(
                `${NS}: no API key for provider route "${PROVIDER_ID}" — open the plugin panel and save one under the credential reference "${cfg.apiKeyEnv}"`,
                'MISSING_CREDENTIAL',
              )
            }
            return key
          },
          get: (name) => ctx.get(name),
        })
      } else {
        state.built.setDisplayName(cfg.displayName)
      }

      if (state.releaseDirectory === null && typeof llm.registerConfigurableProviders === 'function') {
        state.releaseDirectory = llm.registerConfigurableProviders([
          { provider: PROVIDER_ID, displayName: cfg.displayName, settingsNs: NS, settingsPath: [], declared: false },
        ])
      }

      if (cfg.enabled === true) {
        if (state.release === null) state.release = llm.registerAdapter([PROVIDER_ID], state.built.adapter)
      } else if (state.release !== null) {
        state.release()
        state.release = null
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

  /** 拉一次目录（带 TTL），落盘，并重新对账注册状态。 */
  const refreshCatalog = async ({ force = false } = {}) => {
    const cfg = effective()
    const fresh = state.catalogAt !== 0 && Date.now() - state.catalogAt < cfg.cacheSeconds * 1000
    if (!force && fresh) {
      await reconcile()
      return { ok: state.catalogError === null, models: state.catalog, error: state.catalogError, errorCode: state.catalogErrorCode }
    }
    const result = await fetchCatalog(cfg, { apiKey: await readApiKey() })
    if (result.ok) {
      state.catalog = result.models
      state.catalogAt = Date.now()
    }
    // 失败时**保留**上一次的目录：key 过期不等于「模型全没了」，把清单清空会
    // 让操作者正在用的模型在下一次请求里变成 UNKNOWN_MODEL。
    state.catalogError = result.error
    state.catalogErrorCode = result.errorCode
    await reconcile()
    await persist()
    return result
  }

  /** 面板快照：面板需要知道的全部事实，一次给齐。 */
  const snapshot = async () => {
    const cfg = effective()
    const credentials = ctx.get('credentials')
    let credential = { ref: cfg.apiKeyEnv, configured: false, writable: credentials !== undefined, source: null }
    if (credentials !== undefined) {
      const info = await credentials.describe(cfg.apiKeyEnv).catch(() => undefined)
      if (info !== undefined) {
        credential = {
          ref: cfg.apiKeyEnv,
          configured: info.configured === true,
          writable: info.writable !== false,
          source: info.source ?? null,
        }
      }
    }
    const llm = ctx.get('llm')
    const selection = selectionOf(cfg.enabledIds)
    const chat = state.catalog.filter((entry) => entry.chat === true)
    const offered = filterByEnabled(state.catalog, cfg.enabledIds)
    return {
      ok: true,
      name: NS,
      providerId: PROVIDER_ID,
      pollSeconds: POLL_SECONDS,
      protocol: {
        api: WIRE_API,
        endpoint: `${cfg.baseURL}/responses`,
        efforts: REASONING_EFFORTS_SENT,
      },
      config: {
        baseURL: cfg.baseURL,
        displayName: cfg.displayName,
        apiKeyEnv: cfg.apiKeyEnv,
        enabled: cfg.enabled,
        enabledIds: cfg.enabledIds,
        requestTimeoutMs: cfg.requestTimeoutMs,
        cacheSeconds: cfg.cacheSeconds,
      },
      defaults: {
        baseURL: defaults.baseURL,
        displayName: defaults.displayName,
      },
      credential,
      provider: {
        llmAvailable: llm !== undefined,
        registered: state.release !== null,
        directoryDeclared: state.releaseDirectory !== null,
        error: state.registerError,
      },
      catalog: {
        error: state.catalogError,
        errorCode: state.catalogErrorCode,
        fetchedAt: state.catalogAt,
        modelCount: chat.length,
        offeredCount: offered.length,
        selection,
        models: state.catalog.map((entry) => ({
          id: entry.id,
          name: entry.name,
          chat: entry.chat,
          selected:
            entry.chat === true && (selection === 'all' || (selection === 'list' && cfg.enabledIds.includes(entry.id))),
        })),
      },
    }
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

  // ---- POST /api/<ns>/config：改 Base URL / 显示名 / 开关 / 清单 ----
  offs.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `/api/${NS}/config`,
      handler: route(async (request, response) => {
        const body = await readJsonBody(request, response)
        if (body === null) return
        let touched = false
        if (typeof body.baseURL === 'string' && body.baseURL.trim() !== '') {
          state.baseURL = normalizeBaseURL(body.baseURL)
          touched = true
        }
        if (typeof body.displayName === 'string' && body.displayName.trim() !== '') {
          state.displayName = body.displayName.trim()
          touched = true
        }
        if (typeof body.enabled === 'boolean') {
          state.enabled = body.enabled
          touched = true
        }
        if (Array.isArray(body.enabledIds)) {
          state.enabledIds = strList(body.enabledIds)
          touched = true
        }
        if (!touched) {
          writeJson(response, 200, { ok: false, error: 'nothing to change' })
          return
        }
        // 端点变了就等于换了一个目录：丢掉旧清单，让下一次拉取重新开始。
        if (typeof body.baseURL === 'string' && body.baseURL.trim() !== '') state.catalogAt = 0
        await reconcile()
        await persist()
        writeJson(response, 200, { ok: true })
      }, ['POST']),
    }),
  )

  // ---- POST /api/<ns>/key：存 / 清 API Key ----
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
        const ref = defaults.apiKeyEnv
        if (body.clear === true) {
          await credentials.unset(ref)
          state.catalog = []
          state.catalogAt = 0
          state.catalogError = null
          state.catalogErrorCode = null
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
        const result = await refreshCatalog({ force: true })
        writeJson(response, 200, {
          ok: true,
          catalog: { ok: result.ok, error: result.error, errorCode: result.errorCode, modelCount: result.models.length },
        })
      }, ['POST']),
    }),
  )

  // ---- POST /api/<ns>/refresh：重新拉目录 ----
  offs.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `/api/${NS}/refresh`,
      handler: route(async (request, response) => {
        const result = await refreshCatalog({ force: true })
        writeJson(response, 200, {
          ok: result.ok,
          error: result.error,
          errorCode: result.errorCode,
          modelCount: result.models.length,
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
      // 状态文件里有的字段才覆盖出厂默认；不在文件里的字段继续跟随 patch。
      if (stored !== null) {
        if (typeof stored.baseURL === 'string' && stored.baseURL.trim() !== '') state.baseURL = normalizeBaseURL(stored.baseURL)
        if (typeof stored.displayName === 'string' && stored.displayName.trim() !== '') state.displayName = stored.displayName.trim()
        if (typeof stored.enabled === 'boolean') state.enabled = stored.enabled
        if (Array.isArray(stored.enabledIds)) state.enabledIds = strList(stored.enabledIds)
        const catalog = normalizeCatalog(stored.catalog)
        if (catalog.length > 0) {
          state.catalog = catalog
          state.catalogAt = Number.isFinite(Number(stored.catalogAt)) ? Number(stored.catalogAt) : 0
        }
      }
      // 先用（可能来自磁盘的）目录把 provider 挂上，冷启动时模型选择器立刻就
      // 认得出这些 id；随后再联网刷新。
      await reconcile()
      if (disposed) return
      await refreshCatalog({ force: false }).catch((error) => {
        ctx.logger?.warn?.(`${NS}: catalog refresh failed: ${redact(error?.message ?? error)}`)
      })
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
