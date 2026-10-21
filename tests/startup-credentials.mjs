import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Run with the installed Harness peers available (no production credentials are read).
const { Context, Service } = await import('@deepseek-ai/cordis')
const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
const legacy = process.argv.includes('--legacy')
const code = legacy
  ? source.replace("export const inject = ['webServer', 'credentials']", "export const inject = ['webServer']")
      .replace('if (!force && fresh && connection.catalogError === null && connection.catalogErrorCode === null)', 'if (!force && fresh)')
  : source
const plugin = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const home = await mkdtemp(join(tmpdir(), 'qpcm-startup-test-'))
const savedHome = process.env.DSH_HOME
const savedFetch = globalThis.fetch
process.env.DSH_HOME = home
const dir = join(home, 'state', 'dsh-connect-qpcm-gateway')
await mkdir(dir, { recursive: true })
const connections = ['qpcm-gateway', 'connection-2'].map((id, index) => ({
  id, displayName: id, baseURL: 'https://gateway.invalid/v1',
  apiKeyEnv: index ? 'QPCM_TEST_SECOND' : 'QPCM_TEST_FIRST', enabled: false,
  enabledIds: ['test-model'], autoEnableSpent: true,
  catalog: [{ id: 'test-model', name: 'test-model', chat: true }],
  catalogAt: Date.now(), catalogError: null, catalogErrorCode: 'MISSING_CREDENTIAL',
  overlays: { 'test-model': { contextWindow: 256000, input: ['text', 'image'] } },
}))
await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, connections }))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await pause(10) }
  throw new Error('Timed out: ' + label)
}

try {
  // Two completely separate contexts: initial boot and a subsequent restart.
  for (let boot = 1; boot <= 2; boot++) {
    const root = new Context()
    const routes = new Map()
    let ready = false, earlyReads = 0, requests = 0
    let release
    const gate = new Promise(resolve => { release = resolve })
    class Web extends Service {
      constructor(ctx) { super(ctx, 'webServer') }
      register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) }
    }
    class Credentials extends Service {
      constructor(ctx) { super(ctx, 'credentials') }
      async [Service.init]() { await gate; ready = true }
      async resolve(ref) {
        if (!ready) { earlyReads++; return undefined }
        return { value: ref === 'QPCM_TEST_FIRST' ? 'test-first-key' : 'test-second-key', source: 'test' }
      }
      async describe() { return { configured: ready, writable: true, source: 'test' } }
    }
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://gateway.invalid/v1/models')
      assert.ok(['Bearer test-first-key', 'Bearer test-second-key'].includes(options.headers.authorization))
      requests++
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'test-model' }] }) }
    }
    try {
      root.plugin(Web)
      root.plugin(plugin, { cacheSeconds: 3600 })
      root.plugin(Credentials)
      await pause(60)
      // The legacy plugin mounts and reads before Credentials.init completes.
      if (legacy) {
        console.log('LEGACY early credential reads:', earlyReads, 'routes mounted before readiness:', routes.size)
        assert.ok(earlyReads > 0 || routes.size > 0, 'legacy must reproduce the startup race')
      } else {
        assert.equal(routes.size, 0, 'must wait for credentials service initialization')
        assert.equal(earlyReads, 0)
      }
      release()
      await until(() => routes.has('/api/dsh-connect-qpcm-gateway/snapshot'), 'snapshot route')
      async function snapshot() {
        let body
        await routes.get('/api/dsh-connect-qpcm-gateway/snapshot')(
          { method: 'GET', headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' } },
          { setHeader() {}, writeHead() {}, end(text) { body = JSON.parse(text) } },
        )
        return body
      }
      if (legacy) {
        await until(async () => (await snapshot()).connections.length === 2, 'connections loaded')
        const s = await snapshot()
        assert.equal(s.connections[0].credential.configured, true)
        assert.equal(s.connections[0].catalog.errorCode, 'MISSING_CREDENTIAL')
        console.log('LEGACY reproduced: configured=true but persisted MISSING_CREDENTIAL remains')
        break
      }
      await until(async () => {
        const s = await snapshot()
        return s.connections.length === 2 && s.connections.every(c => c.credential.configured && c.catalog.errorCode === null)
      }, 'credential-ready catalogs')
      const s = await snapshot()
      assert.equal(earlyReads, 0)
      assert.equal(requests, boot === 1 ? 2 : 0, 'retry failed fresh entries, cache successful entries on restart')
      assert.deepEqual(s.connections.map(c => c.credential.ref), ['QPCM_TEST_FIRST', 'QPCM_TEST_SECOND'])
      assert.ok(s.connections.every(c => c.catalog.models[0].limits.contextWindow === 256000))
      assert.ok(s.connections.every(c => c.catalog.models[0].limits.input.includes('image')))
      await until(async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).connections.every(c => c.catalogErrorCode === null), 'state persisted')
      console.log('PASS boot', boot, ': no early reads; both keys configured; errors clear; selections and limits preserved')
    } finally { release(); await root.fiber.dispose() }
  }
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
  globalThis.fetch = savedFetch
  await rm(home, { recursive: true, force: true })
}
