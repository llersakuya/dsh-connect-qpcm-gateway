import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Context, Service } = await import('@deepseek-ai/cordis')
const plugin = await import('../lib/index.js')

const EXPECTED_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const home = await mkdtemp(join(tmpdir(), 'qpcm-levels-'))
const savedHome = process.env.DSH_HOME
const savedFetch = globalThis.fetch
process.env.DSH_HOME = home
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({ data: [{ id: 'plain-model' }, { id: 'overlaid-model' }] }),
})

const dir = join(home, 'state', 'dsh-connect-qpcm-gateway')
await mkdir(dir, { recursive: true })
await writeFile(
  join(dir, 'state.json'),
  JSON.stringify({
    version: 1,
    connections: [
      {
        id: 'qpcm-gateway',
        displayName: 'QPCM Gateway',
        baseURL: 'https://gateway.invalid/v1',
        apiKeyEnv: 'QPCM_TEST_KEY',
        enabled: true,
        enabledIds: [],
        autoEnableSpent: true,
        catalog: [
          { id: 'plain-model', name: 'plain-model', chat: true },
          { id: 'overlaid-model', name: 'overlaid-model', chat: true },
        ],
        catalogAt: Date.now(),
        overlays: { 'overlaid-model': { contextWindow: 1000, input: ['text'] } },
      },
    ],
  }),
)

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label) {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return
    await pause(10)
  }
  throw new Error('Timed out: ' + label)
}

const root = new Context()
const routes = new Map()
let captured = null

class Web extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
  }
  register(spec) {
    routes.set(spec.path, spec.handler)
    return () => routes.delete(spec.path)
  }
}
class Credentials extends Service {
  constructor(ctx) {
    super(ctx, 'credentials')
  }
  async resolve() {
    return { value: 'test-key', source: 'test' }
  }
  async describe() {
    return { configured: true, writable: true, source: 'test' }
  }
}
class Llm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
  }
  registerAdapter(providers, adapter) {
    captured = { providers, adapter }
    const dispose = () => {}
    dispose.replace = (next) => {
      captured.providers = next
    }
    return dispose
  }
  registerConfigurableProviders() {
    const dispose = () => {}
    dispose.replace = () => {}
    return dispose
  }
}

try {
  root.plugin(Web)
  root.plugin(Llm)
  root.plugin(Credentials)
  root.plugin(plugin, {})
  await until(() => routes.has('/api/dsh-connect-qpcm-gateway/snapshot'), 'snapshot route')

  async function snapshot() {
    let body
    await routes.get('/api/dsh-connect-qpcm-gateway/snapshot')(
      { method: 'GET', headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' } },
      { setHeader() {}, writeHead() {}, end(text) { body = JSON.parse(text) } },
    )
    return body
  }

  await until(async () => {
    const body = await snapshot()
    return body.connections.length === 1 && body.connections[0].catalog.models.length === 2
  }, 'catalog loaded')

  const body = await snapshot()
  const plain = body.connections[0].catalog.models.find((m) => m.id === 'plain-model')
  const overlaid = body.connections[0].catalog.models.find((m) => m.id === 'overlaid-model')

  assert.equal(plain.limits.contextWindow, 256000, 'default context window must be 256k')
  assert.deepEqual(plain.limits.input, ['text', 'image'], 'image input must be on by default')
  assert.deepEqual(plain.overridden, [], 'defaults must not look like manual overrides')
  assert.equal(overlaid.limits.contextWindow, 1000, 'explicit overlay must win')
  assert.deepEqual(overlaid.limits.input, ['text'], 'explicit text-only overlay must win')

  assert.ok(captured !== null, 'adapter must be registered')
  assert.deepEqual(captured.providers, ['qpcm-gateway'])

  for (const model of ['plain-model', 'overlaid-model']) {
    const resolved = await captured.adapter.resolveModel('qpcm-gateway', model)
    const ids = resolved.reasoning.efforts.map((effort) => effort.id)
    assert.deepEqual(ids, EXPECTED_EFFORTS, `${model} must offer the full ladder`)
    assert.equal(
      resolved.reasoning.defaultEffort,
      undefined,
      `${model} must declare no default effort so the provider-default (auto) entry appears`,
    )
    const labels = resolved.reasoning.efforts.map((effort) => effort.name)
    assert.deepEqual(labels, ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Xhigh', 'Max'])
  }

  const plainResolved = await captured.adapter.resolveModel('qpcm-gateway', 'plain-model')
  assert.equal(plainResolved.context.contextWindow, 256000)
  assert.deepEqual([...plainResolved.inputModalities], ['text', 'image'])

  console.log('PASS defaults: 256k window, image on, explicit overlays still win')
  console.log('PASS ladder:', EXPECTED_EFFORTS.join(' / '), '+ provider default (auto)')
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  globalThis.fetch = savedFetch
  await root.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}
