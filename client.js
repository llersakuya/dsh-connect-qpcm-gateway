/**
 * dsh-connect-qpcm-gateway — Client half.
 *
 * 一块配置面板，挂在 `plugins.bundle.config`（键 = 本 bundle 的包名），与
 * dsh-connect-modelscope-token-plan / dshmarket / dsh-connect-workbuddy 是同一个
 * 挂载点——profile 里 `ui-settings` 是关的，这个槽位才是真正被渲染的那一个。
 *
 * 面板只做四件事：改端点、存 key、拉目录、勾模型。所有判断（哪些 id 能走
 * chat、清单怎么解释、provider 有没有挂上）都由 Host 的 `/snapshot` 说，客户端
 * **不重算**——两处各算一遍就是两套真相的开始。
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-qpcm-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 与 Host 的 `NS` 一致：路由前缀与 slot key 都用它。 */
    const NS = 'dsh-connect-qpcm-gateway'
    const SNAPSHOT_PATH = `/api/${NS}/snapshot`
    const CONNECTIONS_PATH = `/api/${NS}/connections`
    const KEY_PATH = `/api/${NS}/key`
    const REFRESH_PATH = `/api/${NS}/refresh`
    const LIMITS_PATH = `/api/${NS}/limits`
    /** 请求超时：面板上每一次点击都要有个上限，否则按钮会永久转圈。 */
    const FETCH_TIMEOUT_MS = 20_000

    // ---------------------------------------------------------------------
    // 字典
    // ---------------------------------------------------------------------

    const zh = {
      'panel.title': 'QPCM 网关接入',
      'panel.subtitle': '把 OpenAI 兼容网关接成 DSH 的模型来源',
      'panel.loading': '读取中…',
      'panel.error': '读取失败：{error}',
      'panel.retry': '重试',
      'panel.refresh': '刷新',

      'endpoint.title': '源站地址',
      'endpoint.hint': 'OpenAI 兼容根地址，通常以 /v1 结尾。',
      'endpoint.placeholder': 'https://ai.qpcmqam.cn/v1',
      'endpoint.save': '保存地址',
      'endpoint.reset': '恢复默认',

      'key.title': 'API Key',
      'key.hint': '存在本机凭据文件里（引用名 {ref}），不会写进配置或日志。',
      'key.placeholder': '粘贴 API Key',
      'key.save': '保存并验证',
      'key.clear': '清除',
      'key.configured': '已配置（来源：{source}）',
      'key.missing': '还没有配置',
      'key.saving': '保存中…',
      'key.saved': '已保存，并已拉取模型目录。',
      'key.cleared': '已清除。',
      'key.readonly': '本机凭据文件不可写。',

      'models.title': '模型目录',
      'models.fetch': '拉取模型',
      'models.fetching': '拉取中…',
      'models.count': '共 {total} 个，可用 {chat} 个',
      'models.offered': '当前提供 {count} 个模型',
      'models.empty': '目录还是空的。先保存 API Key，再拉取模型。',
      'models.nonChat': '不是对话模型（只能走 /images/generations），已排除',
      'models.selectAll': '全选',
      'models.selectNone': '全不选',
      'models.selection.all': '提供全部可用模型',
      'models.selection.list': '只提供勾选的模型',
      'models.selection.none': '一个都不提供',
      'models.updated': '更新于 {time}',

      'conn.title': 'API 组',
      'conn.hint': '每一组有独立端点、独立 Key、独立模型清单。它们会同时出现在模型选择器里。',
      'conn.add': '添加一组',
      'conn.adding': '添加中…',
      'conn.remove': '删除这一组',
      'conn.removing': '删除中…',
      'conn.added': '已添加，填好地址和 Key 就能用。',
      'conn.removed': '已删除。',
      'conn.created': '新建 {count} 个',
      'conn.max': '最多 {max} 组。',
      'conn.name': '名称',
      'conn.namePlaceholder': '例如 主力 / 备用',
      'conn.count': '{count} 组',
      'conn.current': '当前配置的是：{name}',
      'conn.empty': '还没有任何一组。点「添加一组」开始。',
      'conn.rename': '改名',
      'conn.confirmRemove': '删除这一组？它的 Key 引用会留着，但不再被使用。',
      'conn.alias': '路由 id',
      'conn.aliasHint': '模型选择器里的分组名，也是 <provider>/<model> 里的前半段。',
      'limits.custom': '已自定义',
      'limits.context': '上下文',
      'limits.maxTokens': '最大输出',
      'limits.maxTokens.auto': '自动',
      'limits.image': '收图',
      'limits.image.hint': '声明这个模型能接收图片输入。网关多数模型不接受，打开后带图请求可能失败。',
      'limits.save': '保存',
      'limits.reset': '恢复默认',
      'limits.reset.done': '已恢复默认。',
      'limits.saved': '已保存这个模型的限制。',
      'limits.badContext': '上下文窗口必须是正整数。',
      'limits.badMaxTokens': '最大输出必须是正整数，或者留空表示自动。',

      'provider.title': '接入',
      'provider.needsKey': '这一组还没有可用的 Key，打开开关也不会出现模型。',
      'provider.hint': '打开后，这些模型会出现在模型选择器里。',
      'provider.on': '已接入',
      'provider.off': '未接入',
      'provider.route': '路由 id：{id}',
      'provider.protocol': '协议：{api}，推理档位：{efforts}',
      'provider.noLlm': '这台 Host 没有 llm 服务，无法接入。',
      'provider.failed': '接入失败：{error}',

      'catalog.MISSING_CREDENTIAL': '还没有配置 API Key。',
      'catalog.UNAUTHORIZED': 'API Key 被拒绝，请检查后重新保存。',
      'catalog.TIMEOUT': '源站响应超时。',
      'catalog.NETWORK': '连不上源站，检查网络或地址。',
      'catalog.MALFORMED': '源站返回的不是模型目录。',
      'catalog.UPSTREAM': '源站报错。',

      'common.saving': '保存中…',
      'common.saved': '已保存',
      'common.failed': '失败：{error}',
    }

    const en = {
      'panel.title': 'QPCM Gateway',
      'panel.subtitle': 'Connect an OpenAI-compatible gateway as a DSH model source',
      'panel.loading': 'Loading…',
      'panel.error': 'Could not read: {error}',
      'panel.retry': 'Retry',
      'panel.refresh': 'Refresh',

      'endpoint.title': 'Base URL',
      'endpoint.hint': 'OpenAI-compatible root address, usually ending in /v1.',
      'endpoint.placeholder': 'https://ai.qpcmqam.cn/v1',
      'endpoint.save': 'Save URL',
      'endpoint.reset': 'Restore default',

      'key.title': 'API key',
      'key.hint': 'Stored in the local credential file under {ref}; never written to config or logs.',
      'key.placeholder': 'Paste the API key',
      'key.save': 'Save and verify',
      'key.clear': 'Clear',
      'key.configured': 'Configured (source: {source})',
      'key.missing': 'Not configured yet',
      'key.saving': 'Saving…',
      'key.saved': 'Saved, and the model catalogue was fetched.',
      'key.cleared': 'Cleared.',
      'key.readonly': 'The local credential file is not writable.',

      'models.title': 'Model catalogue',
      'models.fetch': 'Fetch models',
      'models.fetching': 'Fetching…',
      'models.count': '{total} in total, {chat} usable',
      'models.offered': 'Currently offering {count} models',
      'models.empty': 'The catalogue is empty. Save an API key first, then fetch models.',
      'models.nonChat': 'Not a chat model (images only) and is excluded',
      'models.selectAll': 'Select all',
      'models.selectNone': 'Select none',
      'models.selection.all': 'Offering every usable model',
      'models.selection.list': 'Offering only the ticked models',
      'models.selection.none': 'Offering nothing',
      'models.updated': 'Updated {time}',

      'conn.title': 'API groups',
      'conn.hint': 'Each group has its own endpoint, key, and model list. All of them appear in the model picker at the same time.',
      'conn.add': 'Add a group',
      'conn.adding': 'Adding…',
      'conn.remove': 'Delete this group',
      'conn.removing': 'Deleting…',
      'conn.added': 'Added. Fill in the endpoint and key to use it.',
      'conn.removed': 'Deleted.',
      'conn.created': '{count} available',
      'conn.max': 'At most {max} groups.',
      'conn.name': 'Name',
      'conn.namePlaceholder': 'e.g. primary / backup',
      'conn.count': '{count} groups',
      'conn.current': 'Editing: {name}',
      'conn.empty': 'No groups yet. Click "Add a group" to start.',
      'conn.rename': 'Rename',
      'conn.confirmRemove': 'Delete this group? Its key reference stays on disk but is no longer used.',
      'conn.alias': 'route id',
      'conn.aliasHint': 'The group name in the model picker, and the first half of <provider>/<model>.',

      'limits.custom': 'customized',
      'limits.context': 'context',
      'limits.maxTokens': 'max output',
      'limits.maxTokens.auto': 'auto',
      'limits.image': 'images',
      'limits.image.hint': 'Declare that this model accepts image input. Most gateway models do not, so image requests may fail afterwards.',
      'limits.save': 'Save',
      'limits.reset': 'Reset',
      'limits.reset.done': 'Reset to the default.',
      'limits.saved': 'Saved the limits for this model.',
      'limits.badContext': 'The context window must be a positive integer.',
      'limits.badMaxTokens': 'The max output must be a positive integer, or empty for automatic.',

      'provider.title': 'Integration',
      'provider.needsKey': 'This group has no usable key, so turning it on will not surface any model.',
      'provider.hint': 'Once on, these models appear in the model selector.',
      'provider.on': 'Connected',
      'provider.off': 'Not connected',
      'provider.route': 'Route id: {id}',
      'provider.protocol': 'Protocol: {api}; reasoning levels: {efforts}',
      'provider.noLlm': 'This Host has no llm service, so integration is unavailable.',
      'provider.failed': 'Integration failed: {error}',

      'catalog.MISSING_CREDENTIAL': 'No API key is configured.',
      'catalog.UNAUTHORIZED': 'The API key was rejected; check it and save again.',
      'catalog.TIMEOUT': 'The gateway timed out.',
      'catalog.NETWORK': 'Could not reach the gateway; check the network or the address.',
      'catalog.MALFORMED': 'The gateway did not return a model catalogue.',
      'catalog.UPSTREAM': 'The gateway reported an error.',

      'common.saving': 'Saving…',
      'common.saved': 'Saved',
      'common.failed': 'Failed: {error}',
    }

    /** 把 `{name}` 占位符填上；缺参数就原样留着，方便发现漏传。 */
    function format(template, params) {
      if (params === undefined) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
      )
    }

    // ---------------------------------------------------------------------
    // HTTP
    // ---------------------------------------------------------------------

    async function request(path, init) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(path, {
          cache: 'no-store',
          ...init,
          ...(controller === null ? {} : { signal: controller.signal }),
        })
        return await response.json().catch(() => null)
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    const getJson = (path) => request(path, { headers: { accept: 'application/json' } })

    const postJson = (path, payload) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })

    // ---------------------------------------------------------------------
    // 样式：全部走主题 token，深色/浅色跟着系统走。
    // ---------------------------------------------------------------------

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        padding: '4px 2px 28px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.55,
      },
      header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: 0.1 },
      subtitle: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      section: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      sectionTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
      hint: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      input: {
        flex: '1 1 260px',
        minWidth: 200,
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        fontFamily: 'inherit',
        outline: 'none',
      },
      button: {
        height: 32,
        padding: '0 13px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      primary: {
        height: 32,
        padding: '0 14px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        fontSize: 13,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      list: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 },
      item: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '6px 8px',
        borderRadius: 7,
        fontSize: 13,
      },
      itemExcluded: { opacity: 0.55 },
      itemName: { fontWeight: 500 },
      itemId: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      spacer: { flex: '1 1 auto' },
      // ---- 逐模型限制 ----
      itemWrap: { display: 'flex', flexDirection: 'column' },
      limitsRow: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        padding: '2px 8px 10px 30px',
        fontSize: 12,
      },
      limitsField: { display: 'flex', alignItems: 'center', gap: 5 },
      limitsLabel: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      limitsInput: {
        width: 92,
        height: 26,
        padding: '0 7px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      limitsMini: {
        height: 26,
        padding: '0 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      limitsMiniOn: {
        height: 26,
        padding: '0 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      customBadge: {
        fontSize: 10.5,
        padding: '0 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      status: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      statusError: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      statusOk: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' },
      badge: {
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      badgeOn: {
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-state-success-primary)',
        whiteSpace: 'nowrap',
      },
      empty: {
        padding: '14px 10px',
        textAlign: 'center',
        fontSize: 12.5,
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px dashed var(--dsw-alias-border-l1)',
        borderRadius: 8,
      },
      switchTrack: {
        position: 'relative',
        width: 38,
        height: 22,
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        cursor: 'pointer',
        padding: 0,
        flex: '0 0 auto',
      },
      switchTrackOn: {
        position: 'relative',
        width: 38,
        height: 22,
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
        padding: 0,
        flex: '0 0 auto',
      },
      switchKnob: {
        position: 'absolute',
        top: 2.5,
        left: 2.5,
        width: 15,
        height: 15,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 140ms ease',
      },
      switchKnobOn: {
        position: 'absolute',
        top: 2.5,
        left: 18.5,
        width: 15,
        height: 15,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 140ms ease',
      },

      // ---- 连接分组 ----
      tabs: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 },
      tab: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      tabOn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        fontSize: 13,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      tabDot: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--dsw-alias-label-secondary)',
        opacity: 0.5,
      },
      tabDotOn: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--dsw-alias-state-success-primary)',
      },
    }

    /** 连线状态点：开启时用实心绿点，关闭时用暗点。 */
    function tabDot(on) {
      return on === true ? S.tabDotOn : S.tabDot
    }

    /**
     * 条件样式：`J(条件, 追加样式, 基础样式)`。
     *
     * 面板里「禁用 + 高亮色」这类组合出现太多次，写成一个函数比到处展开三元短。
     */
    function J(when, extra, base) {
      return when ? { ...base, ...extra } : base
    }

    /** 时间戳 → 本地短时间；0 表示「还没有」。 */
    function clockOf(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      try {
        return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    // ---------------------------------------------------------------------
    // 面板
    // ---------------------------------------------------------------------

    function Panel(props) {
      const tt = typeof props?.tt === 'function' ? props.tt : (key) => key
      const localeSubscribe = props?.localeSubscribe
      const { useState, useEffect, useCallback, useRef } = React

      // owner 会按 `view` 派发两次：`summary` 只放一行摘要，`page` 放整块表单。
      const summaryOnly = props?.view === 'summary'

      const [snapshot, setSnapshot] = useState(null)
      const [loadError, setLoadError] = useState(null)
      /** 当前正在编辑的连接 id；null = 用快照里的第一条。 */
      const [activeId, setActiveId] = useState(null)
      const [urlDraft, setUrlDraft] = useState('')
      const [nameDraft, setNameDraft] = useState('')
      const [keyDraft, setKeyDraft] = useState('')
      const [busy, setBusy] = useState(null)
      const [note, setNote] = useState(null)
      // 逐模型限制的编辑草稿：`{ "<连接id>/<模型id>": {contextWindow, maxTokens, image} }`。
      const [limitDrafts, setLimitDrafts] = useState({})
      const [, setLocaleRevision] = useState(0)

      /** 组件还活着吗——异步回调回来时用它挡掉过期 setState。 */
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        if (typeof localeSubscribe !== 'function') return undefined
        return localeSubscribe(() => setLocaleRevision((revision) => revision + 1))
      }, [localeSubscribe])

      const load = useCallback(async () => {
        try {
          const body = await getJson(SNAPSHOT_PATH)
          if (!alive.current) return
          if (body === null || body.ok !== true) {
            setLoadError(typeof body?.error === 'string' ? body.error : 'no response')
            return
          }
          setLoadError(null)
          setSnapshot(body)
        } catch (error) {
          if (alive.current) setLoadError(error?.message ?? String(error))
        }
      }, [])

      useEffect(() => {
        void load()
        return undefined
      }, [load])

      // 轮询：Host 说多久就多久。后台标签页不轮询（省电，也免得一堆无谓请求）。
      const pollSeconds = snapshot?.pollSeconds
      useEffect(() => {
        if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load()
        }, pollSeconds * 1000)
        return () => clearInterval(timer)
      }, [pollSeconds, load])

      /** 当前编辑的连接：优先 activeId，失效时回落到第一条。 */
      const connections = Array.isArray(snapshot?.connections) ? snapshot.connections : []
      const active = connections.find((connection) => connection.id === activeId) ?? connections[0] ?? null

      // 端点/名称草稿只在切换连接时同步：之后用户正在输入，别抢他的光标。
      const seededFor = useRef(null)
      useEffect(() => {
        if (active === null) return
        if (seededFor.current === active.id) return
        seededFor.current = active.id
        setUrlDraft(active.baseURL)
        setNameDraft(active.displayName)
        setKeyDraft('')
        setLimitDrafts({})
      }, [active])

      /** 统一的写操作外壳：置 busy、收错误、刷新快照。 */
      const write = useCallback(
        async (kind, path, payload, successNote) => {
          setBusy(kind)
          setNote(null)
          try {
            const body = await postJson(path, payload)
            if (!alive.current) return null
            if (body === null || body.ok !== true) {
              setNote({ kind: 'error', text: format(tt('common.failed'), { error: body?.error ?? 'no response' }) })
              return body
            }
            if (successNote !== undefined) setNote({ kind: 'ok', text: successNote })
            await load()
            return body
          } catch (error) {
            if (alive.current) setNote({ kind: 'error', text: format(tt('common.failed'), { error: error?.message ?? error }) })
            return null
          } finally {
            if (alive.current) setBusy(null)
          }
        },
        [load, tt],
      )

      /** 草稿的键：跨连接不能撞，所以带上连接 id。 */
      const draftKey = (modelId) => `${active === null ? '' : active.id}/${modelId}`

      /**
       * 某个模型在**没有任何草稿**时的显示值，即 snapshot 里的生效值。
       *
       * `maxTokens` 用 `''` 而不是 `null` 表示「没设」：输入框的 value 只在两者
       * 都不是时才是空串，`null` 会被渲染成字符串。
       */
      const baseLimitsOf = useCallback((model) => {
        const limits = model.limits ?? {}
        const input = Array.isArray(limits.input) ? limits.input : ['text']
        return {
          contextWindow: limits.contextWindow ?? 128000,
          maxTokens: limits.maxTokens === null || limits.maxTokens === undefined ? '' : limits.maxTokens,
          input,
          image: input.includes('image'),
          touched: false,
        }
      }, [])

      /**
       * 某个模型当前要显示的三个值。
       *
       * 草稿是**覆盖**而不是替换：点「收图」只记下 `image`，上下文窗口与最大
       * 输出仍要显示 snapshot 里的值，否则那两个框会空掉。
       */
      const limitsOf = useCallback(
        (model) => {
          const base = baseLimitsOf(model)
          const draft = limitDrafts[draftKey(model.id)]
          return draft === undefined ? base : { ...base, ...draft }
        },
        [limitDrafts, active, baseLimitsOf],
      )

      /**
       * 改草稿（不落盘——面板上还有「保存」这一步，避免每敲一个数字就重建适配器）。
       *
       * 新草稿先铺满当前生效值，这样后续任何单字段修改都不会把别的字段抹掉。
       */
      const editLimit = useCallback(
        (model, patch) => {
          const key = draftKey(model.id)
          setLimitDrafts((previous) => {
            const base = previous[key] ?? baseLimitsOf(model)
            return { ...previous, [key]: { ...base, ...patch, touched: true } }
          })
          setNote(null)
        },
        [active, baseLimitsOf],
      )

      /** 把某个模型的限制写回 Host。`reset` 为真时删掉覆盖、回到默认。 */
      const saveLimits = useCallback(
        async (model, reset) => {
          if (active === null) return
          const key = draftKey(model.id)
          const clearDraft = () =>
            setLimitDrafts((previous) => {
              const next = { ...previous }
              delete next[key]
              return next
            })
          if (reset === true) {
            const body = await write(
              'limits',
              LIMITS_PATH,
              { id: active.id, model: model.id, reset: true },
              tt('limits.reset.done'),
            )
            if (body !== null && body.ok === true) clearDraft()
            return
          }
          const draft = limitsOf(model)
          const window = Number(draft.contextWindow)
          const max = draft.maxTokens === '' || draft.maxTokens === null ? null : Number(draft.maxTokens)
          if (!Number.isInteger(window) || window <= 0) {
            setNote({ kind: 'error', text: tt('limits.badContext') })
            return
          }
          if (max !== null && (!Number.isInteger(max) || max <= 0)) {
            setNote({ kind: 'error', text: tt('limits.badMaxTokens') })
            return
          }
          const input = draft.image === true ? ['text', 'image'] : ['text']
          const body = await write(
            'limits',
            LIMITS_PATH,
            { id: active.id, model: model.id, contextWindow: window, ...(max === null ? {} : { maxTokens: max }), input },
            tt('limits.saved'),
          )
          if (body !== null && body.ok === true) clearDraft()
        },
        [active, limitsOf, tt, write],
      )

      // ---- 首屏 ----
      // 摘要视图不渲染 loading/错误块：owner 会把这一行放进折叠标题里，
      // 那里放一整块重试按钮不合适。
      if (snapshot === null) {
        if (summaryOnly) {
          return h(
            'span',
            { style: S.status },
            loadError === null ? tt('panel.loading') : format(tt('panel.error'), { error: loadError }),
          )
        }
        return h(
          'div',
          { style: S.page },
          h('div', { style: S.header }, h('h3', { style: S.title }, tt('panel.title'))),
          loadError !== null
            ? h(
                'div',
                { style: S.section },
                h('p', { style: S.statusError }, format(tt('panel.error'), { error: loadError })),
                h('div', { style: S.row }, h('button', { style: S.button, onClick: () => void load() }, tt('panel.retry'))),
              )
            : h('p', { style: S.hint }, tt('panel.loading')),
        )
      }

      const { provider, defaults, maxConnections } = snapshot

      // `view: 'summary'`：折叠态那一行，说「几组、接没接、一共几个模型」。
      if (summaryOnly) {
        const parts = []
        parts.push(format(tt('conn.count'), { count: connections.length }))
        const enabled = connections.filter((connection) => connection.enabled === true)
        parts.push(enabled.length > 0 ? tt('provider.on') : tt('provider.off'))
        const offered = connections.reduce((sum, connection) => sum + (connection.catalog?.offeredCount ?? 0), 0)
        if (offered > 0) parts.push(format(tt('models.offered'), { count: offered }))
        const failed = connections.some((connection) => connection.catalog?.errorCode !== null && connection.catalog?.errorCode !== undefined)
        return h('span', { style: failed ? S.statusError : S.status }, parts.join(' · '))
      }

      /** 新建一组。 */
      const addConnection = async () => {
        const body = await write('connection', CONNECTIONS_PATH, { action: 'create' }, tt('conn.added'))
        if (body !== null && body.ok === true && body.connection !== undefined) setActiveId(body.connection.id)
      }

      /** 删除当前这一组。 */
      const removeConnection = async () => {
        if (active === null) return
        const body = await write(
          'connection',
          CONNECTIONS_PATH,
          { action: 'delete', id: active.id },
          tt('conn.removed'),
        )
        if (body !== null && body.ok === true) setActiveId(null)
      }

      const canAdd = connections.length < (maxConnections ?? 8)
      const off = active !== null && active.enabled !== true

      // 当前连接的三态
      const catalog = active === null ? null : active.catalog
      const credential = active === null ? null : active.credential
      const selection = catalog === null ? 'all' : catalog.selection
      const chatModels = catalog === null ? [] : catalog.models.filter((model) => model.chat === true)
      const hasCatalog = catalog !== null && catalog.models.length > 0

      /** 当前勾着的 id 清单——必须按三态还原，否则「全选」态下取消一个会变成只选它。 */
      const currentIds = () => {
        if (catalog === null) return []
        if (selection === 'all') return chatModels.map((model) => model.id)
        if (selection === 'none') return []
        return catalog.models.filter((model) => model.selected === true).map((model) => model.id)
      }

      /**
       * 勾选结果 → 线编码。
       *
       * 三条边界要收口：勾满 = `[]`（等价于「不过滤」，且跟随目录新增）；
       * 勾空 = 哨兵（`[]` 已经被「全部」占了）；其余是严格白名单。
       */
      const withSelection = (ids) => {
        if (ids.length === 0) return ['__hide_all__']
        if (chatModels.length > 0 && ids.length >= chatModels.length) return []
        return ids
      }

      const toggleModel = (modelId) => {
        if (active === null) return
        const current = currentIds()
        const next = current.includes(modelId) ? current.filter((entry) => entry !== modelId) : [...current, modelId]
        void write('models', CONNECTIONS_PATH, { action: 'update', id: active.id, enabledIds: withSelection(next) })
      }

      const selectAll = () =>
        active === null ? undefined : void write('models', CONNECTIONS_PATH, { action: 'update', id: active.id, enabledIds: [] })
      const selectNone = () =>
        active === null
          ? undefined
          : void write('models', CONNECTIONS_PATH, { action: 'update', id: active.id, enabledIds: ['__hide_all__'] })

      const selectionLabel =
        selection === 'all'
          ? tt('models.selection.all')
          : selection === 'none'
            ? tt('models.selection.none')
            : tt('models.selection.list')

      const credentialLabel =
        credential === null
          ? ''
          : credential.configured === true
            ? format(tt('key.configured'), { source: credential.source ?? 'file' })
            : tt('key.missing')

      const catalogProblem =
        catalog !== null && catalog.errorCode !== null && catalog.errorCode !== undefined
          ? tt(`catalog.${catalog.errorCode}`) === `catalog.${catalog.errorCode}`
            ? catalog.error
            : tt(`catalog.${catalog.errorCode}`)
          : null

      return h(
        'div',
        { style: S.page },

        // ---- 标题 ----
        h(
          'div',
          { style: S.header },
          h('h3', { style: S.title }, tt('panel.title')),
          h('p', { style: S.subtitle }, tt('panel.subtitle')),
          h('span', { style: S.spacer }),
          h(
            'button',
            { style: busy === null ? S.button : { ...S.button, ...S.buttonDisabled }, disabled: busy !== null, onClick: () => void load() },
            tt('panel.refresh'),
          ),
        ),

        // ---- 分组列表 ----
        h(
          'div',
          { style: S.section },
          h(
            'div',
            { style: S.sectionHead },
            h('h4', { style: S.sectionTitle }, tt('conn.title')),
            h('span', { style: S.badge }, format(tt('conn.count'), { count: connections.length })),
            h('span', { style: S.spacer }),
            h(
              'button',
              {
                style: busy !== null || !canAdd ? { ...S.primary, ...S.buttonDisabled } : S.primary,
                disabled: busy !== null || !canAdd,
                onClick: () => void addConnection(),
              },
              busy === 'connection' ? tt('conn.adding') : tt('conn.add'),
            ),
          ),
          h('p', { style: S.hint }, tt('conn.hint')),
          !canAdd ? h('p', { style: S.hint }, format(tt('conn.max'), { max: maxConnections ?? 8 })) : null,

          connections.length === 0
            ? h('div', { style: S.empty }, tt('conn.empty'))
            : h(
                'div',
                { style: S.tabs },
                connections.map((connection) =>
                  h(
                    'button',
                    {
                      key: connection.id,
                      style: connection.id === (active === null ? '' : active.id) ? S.tabOn : S.tab,
                      title: `${connection.id} — ${connection.baseURL}`,
                      onClick: () => setActiveId(connection.id),
                    },
                    h('span', { style: tabDot(connection.enabled === true) }),
                    connection.displayName,
                  ),
                ),
              ),
        ),

        active === null
          ? null
          : h(
              'div',
              null,

              // ---- 这一组的端点与名称 ----
              h(
                'div',
                { style: S.section },
                h(
                  'div',
                  { style: S.sectionHead },
                  h('h4', { style: S.sectionTitle }, tt('endpoint.title')),
                  h('span', { style: S.badge }, format(tt('conn.current'), { name: active.displayName })),
                  h('span', { style: S.spacer }),
                  h(
                    'button',
                    {
                      style: J(busy !== null, S.buttonDisabled, S.button),
                      disabled: busy !== null,
                      onClick: () => {
                        // 删除是破坏性操作，用原生 confirm 挡住误点。
                        if (typeof confirm === 'function' && !confirm(tt('conn.confirmRemove'))) return
                        void removeConnection()
                      },
                    },
                    busy === 'connection' ? tt('conn.removing') : tt('conn.remove'),
                  ),
                ),
                h('p', { style: S.hint }, tt('endpoint.hint')),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    style: S.input,
                    value: nameDraft,
                    placeholder: tt('conn.namePlaceholder'),
                    spellCheck: false,
                    onChange: (event) => setNameDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && nameDraft.trim() !== '') {
                        void write('conn', CONNECTIONS_PATH, { action: 'update', id: active.id, displayName: nameDraft }, tt('common.saved'))
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      style: J(busy !== null || nameDraft.trim() === '' || nameDraft.trim() === active.displayName, S.buttonDisabled, S.button),
                      disabled: busy !== null || nameDraft.trim() === '' || nameDraft.trim() === active.displayName,
                      onClick: () =>
                        void write('conn', CONNECTIONS_PATH, { action: 'update', id: active.id, displayName: nameDraft }, tt('common.saved')),
                    },
                    tt('conn.rename'),
                  ),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    style: S.input,
                    value: urlDraft,
                    placeholder: tt('endpoint.placeholder'),
                    spellCheck: false,
                    onChange: (event) => setUrlDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        void write('conn', CONNECTIONS_PATH, { action: 'update', id: active.id, baseURL: urlDraft }, tt('common.saved'))
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      style: J(busy !== null || urlDraft.trim() === '' || urlDraft.trim() === active.baseURL, S.buttonDisabled, S.primary),
                      disabled: busy !== null || urlDraft.trim() === '' || urlDraft.trim() === active.baseURL,
                      onClick: () =>
                        void write('conn', CONNECTIONS_PATH, { action: 'update', id: active.id, baseURL: urlDraft }, tt('common.saved')),
                    },
                    tt('endpoint.save'),
                  ),
                  defaults.baseURL !== active.baseURL
                    ? h(
                        'button',
                        {
                          style: S.button,
                          disabled: busy !== null,
                          onClick: () => {
                            setUrlDraft(defaults.baseURL)
                            void write('conn', CONNECTIONS_PATH, { action: 'update', id: active.id, baseURL: defaults.baseURL }, tt('common.saved'))
                          },
                        },
                        tt('endpoint.reset'),
                      )
                    : null,
                ),
                h('p', { style: S.hint }, format(tt('conn.aliasHint'), {})),
                h('p', { style: S.itemId }, `${tt('conn.alias')}: ${active.id}`),
              ),

              // ---- API Key ----
              h(
                'div',
                { style: S.section },
                h(
                  'div',
                  { style: S.sectionHead },
                  h('h4', { style: S.sectionTitle }, tt('key.title')),
                  h('span', { style: credential.configured === true ? S.badgeOn : S.badge }, credentialLabel),
                ),
                h('p', { style: S.hint }, format(tt('key.hint'), { ref: credential.ref })),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    style: S.input,
                    type: 'password',
                    value: keyDraft,
                    placeholder: tt('key.placeholder'),
                    spellCheck: false,
                    autoComplete: 'off',
                    onChange: (event) => setKeyDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && keyDraft.trim() !== '') {
                        void write('key', KEY_PATH, { id: active.id, value: keyDraft }, tt('key.saved')).then(() => setKeyDraft(''))
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      style: J(busy !== null || keyDraft.trim() === '' || credential.writable === false, S.buttonDisabled, S.primary),
                      disabled: busy !== null || keyDraft.trim() === '' || credential.writable === false,
                      onClick: () => {
                        void write('key', KEY_PATH, { id: active.id, value: keyDraft }, tt('key.saved')).then(() => setKeyDraft(''))
                      },
                    },
                    busy === 'key' ? tt('key.saving') : tt('key.save'),
                  ),
                  credential.configured === true
                    ? h(
                        'button',
                        {
                          style: J(busy !== null || credential.writable === false, S.buttonDisabled, S.button),
                          disabled: busy !== null || credential.writable === false,
                          onClick: () => void write('key', KEY_PATH, { id: active.id, clear: true }, tt('key.cleared')),
                        },
                        tt('key.clear'),
                      )
                    : null,
                ),
                credential.writable === false ? h('p', { style: S.statusError }, tt('key.readonly')) : null,
              ),

              // ---- 模型目录 ----
              h(
                'div',
                { style: S.section },
                h(
                  'div',
                  { style: S.sectionHead },
                  h('h4', { style: S.sectionTitle }, tt('models.title')),
                  h(
                    'span',
                    { style: S.badge },
                    format(tt('models.count'), { total: catalog.models.length, chat: chatModels.length }),
                  ),
                  h('span', { style: S.spacer }),
                  h(
                    'button',
                    {
                      style: J(busy !== null, S.buttonDisabled, S.button),
                      disabled: busy !== null,
                      onClick: () => void write('refresh', REFRESH_PATH, { id: active.id }),
                    },
                    busy === 'refresh' ? tt('models.fetching') : tt('models.fetch'),
                  ),
                ),
                catalogProblem !== null ? h('p', { style: S.statusError }, catalogProblem) : null,
                catalog.fetchedAt > 0
                  ? h('p', { style: S.hint }, format(tt('models.updated'), { time: clockOf(catalog.fetchedAt) }))
                  : null,

                !hasCatalog
                  ? h('div', { style: S.empty }, tt('models.empty'))
                  : h(
                      'div',
                      null,
                      h(
                        'div',
                        { style: S.row },
                        h('span', { style: S.status }, format(tt('models.offered'), { count: catalog.offeredCount })),
                        h('span', { style: S.status }, `· ${selectionLabel}`),
                        h('span', { style: S.spacer }),
                        h(
                          'button',
                          { style: S.button, disabled: busy !== null || selection === 'all', onClick: selectAll },
                          tt('models.selectAll'),
                        ),
                        h(
                          'button',
                          { style: S.button, disabled: busy !== null || selection === 'none', onClick: selectNone },
                          tt('models.selectNone'),
                        ),
                      ),
                      h(
                        'div',
                        { style: S.list },
                        catalog.models.map((model) => {
                          const limits = limitsOf(model)
                          const overridden = Array.isArray(model.overridden) ? model.overridden : []
                          // 不能用 <label> 包整行：里面的数字输入框会把点击转给复选框。
                          return h(
                            'div',
                            { key: model.id, style: S.itemWrap },
                            h(
                              'div',
                              {
                                style: model.chat === true ? S.item : { ...S.item, ...S.itemExcluded },
                                title: model.chat === true ? model.id : `${model.id} — ${tt('models.nonChat')}`,
                              },
                              h('input', {
                                type: 'checkbox',
                                checked: model.selected === true,
                                disabled: busy !== null || model.chat !== true,
                                onChange: () => toggleModel(model.id),
                              }),
                              h('span', { style: S.itemName }, model.name),
                              model.name !== model.id ? h('span', { style: S.itemId }, model.id) : null,
                              h('span', { style: S.spacer }),
                              overridden.length > 0 && model.chat === true
                                ? h('span', { style: S.customBadge }, tt('limits.custom'))
                                : null,
                              model.chat === true ? null : h('span', { style: S.badge }, tt('models.nonChat')),
                            ),
                            model.chat === true
                              ? h(
                                  'div',
                                  { style: S.limitsRow },
                                  h(
                                    'span',
                                    { style: S.limitsField },
                                    h('span', { style: S.limitsLabel }, tt('limits.context')),
                                    h('input', {
                                      style: S.limitsInput,
                                      type: 'number',
                                      min: 1,
                                      step: 1024,
                                      value: limits.contextWindow === '' ? '' : String(limits.contextWindow),
                                      disabled: busy !== null,
                                      'aria-label': `${model.id} ${tt('limits.context')}`,
                                      onChange: (event) => editLimit(model, { contextWindow: event.target.value }),
                                    }),
                                  ),
                                  h(
                                    'span',
                                    { style: S.limitsField },
                                    h('span', { style: S.limitsLabel }, tt('limits.maxTokens')),
                                    h('input', {
                                      style: S.limitsInput,
                                      type: 'number',
                                      min: 1,
                                      step: 256,
                                      value:
                                        limits.maxTokens === null || limits.maxTokens === undefined
                                          ? ''
                                          : String(limits.maxTokens),
                                      placeholder: tt('limits.maxTokens.auto'),
                                      disabled: busy !== null,
                                      'aria-label': `${model.id} ${tt('limits.maxTokens')}`,
                                      onChange: (event) => editLimit(model, { maxTokens: event.target.value }),
                                    }),
                                  ),
                                  h(
                                    'button',
                                    {
                                      style: limits.image === true ? S.limitsMiniOn : S.limitsMini,
                                      disabled: busy !== null,
                                      title: tt('limits.image.hint'),
                                      onClick: () => editLimit(model, { image: limits.image !== true }),
                                    },
                                    tt('limits.image'),
                                  ),
                                  h('span', { style: S.spacer }),
                                  h(
                                    'button',
                                    {
                                      style: limits.touched === true ? S.primary : S.limitsMini,
                                      disabled: busy !== null,
                                      onClick: () => void saveLimits(model, false),
                                    },
                                    tt('limits.save'),
                                  ),
                                  overridden.length > 0
                                    ? h(
                                        'button',
                                        { style: S.limitsMini, disabled: busy !== null, onClick: () => void saveLimits(model, true) },
                                        tt('limits.reset'),
                                      )
                                    : null,
                                )
                              : null,
                          )
                        }),
                      ),
                    ),
              ),

              // ---- 接入开关 ----
              h(
                'div',
                { style: S.section },
                h(
                  'div',
                  { style: S.sectionHead },
                  h('h4', { style: S.sectionTitle }, tt('provider.title')),
                  h('span', { style: active.enabled ? S.badgeOn : S.badge }, active.enabled ? tt('provider.on') : tt('provider.off')),
                  h('span', { style: S.spacer }),
                  h(
                    'button',
                    {
                      style: active.enabled ? S.switchTrackOn : S.switchTrack,
                      role: 'switch',
                      'aria-checked': active.enabled === true,
                      'aria-label': tt('provider.title'),
                      disabled: busy !== null || provider.llmAvailable !== true,
                      onClick: () =>
                        void write('provider', CONNECTIONS_PATH, {
                          action: 'update',
                          id: active.id,
                          enabled: active.enabled !== true,
                        }),
                    },
                    h('span', { style: active.enabled ? S.switchKnobOn : S.switchKnob }),
                  ),
                ),
                h('p', { style: S.hint }, tt('provider.hint')),
                h('p', { style: S.hint }, format(tt('provider.route'), { id: active.id })),
                active.protocol?.endpoint
                  ? h(
                      'p',
                      { style: S.hint },
                      format(tt('provider.protocol'), {
                        api: active.protocol.api ?? 'openai-responses',
                        efforts: (active.protocol.efforts ?? []).join(' / '),
                      }),
                    )
                  : null,
                provider.llmAvailable !== true ? h('p', { style: S.statusError }, tt('provider.noLlm')) : null,
                provider.error !== null && provider.error !== undefined
                  ? h('p', { style: S.statusError }, format(tt('provider.failed'), { error: provider.error }))
                  : null,
                off && credential !== null && credential.configured !== true
                  ? h('p', { style: S.hint }, tt('provider.needsKey'))
                  : null,
              ),
            ),

        // ---- 一行结果 ----
        note === null ? null : h('p', { style: note.kind === 'ok' ? S.statusOk : S.statusError }, note.text),
      )
    }

    // ---------------------------------------------------------------------
    // 注册
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh, en })
          } catch {
            return () => {}
          }
        }, `${NS}: dictionaries`)

        let translate = (key) => key
        try {
          translate = ctx.locale.bind(NS)
        } catch {}
        const tt = (key) => {
          try {
            return translate(key)
          } catch {
            return key
          }
        }

        ctx.effect(() => {
          try {
            return ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: NS,
                  locale: NS,
                  inject: () => ({ tt, localeSubscribe: ctx.locale.subscribe.bind(ctx.locale) }),
                },
                Panel,
              ),
            )
          } catch (error) {
            console.warn(`[${NS}] config panel registration failed:`, error)
            return () => {}
          }
        }, `${NS}: config panel`)
      },
    }
  },
})
