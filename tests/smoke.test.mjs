// Runtime smoke test: loads the real bundle with a fully mocked Cordis
// context, runs apply(), and exercises every tool/command/listener path,
// including the v0.4.1 contract fixes (plan-flip session-mode immunity,
// child escalation, background JobOutcome shape, settings persistence).
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function makeAgent(id, origin) {
  const writes = []
  const session = {
    id: 'session-' + id,
    header: { origin: origin || '' },
    events: [],
    append(kind, payload) { writes.push({ kind, payload }) },
    requestHeader() {
      const last = writes.filter((w) => w.kind === 'request/header').at(-1)
      return last ? { config: last.payload.header.config } : null
    },
  }
  return { id, session, writes }
}

function makeContext() {
  const ctx = {
    listeners: {},
    on(name, fn) {
      ;(ctx.listeners[name] || (ctx.listeners[name] = [])).push(fn)
    },
    get(name) { return ctx.services[name] },
  }
  const services = {
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }, { id: 'opencode-go' }],
      listModels: async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }],
      stream: async function* () {
        yield { type: 'text-delta', text: 'MOCK ADVICE' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    tools: { registered: [], register(tool) { this.registered.push(tool) } },
    commands: { registered: [], register(cmd) { this.registered.push(cmd) } },
    planMode: { get: () => ({ active: false }), set: () => 'committed' },
    agentDefaultModel: {
      saved: [],
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }),
      saveSelection: async (sel) => { this.saved.push(sel) },
    },
    systemPrompt: { sections: [], section(s) { this.sections.push(s) } },
    subagents: {
      list: () => ['spawn'],
      started: [],
      async start(name, request) {
        const localAgent = makeAgent('worker-' + this.started.length, 'subagent')
        this.started.push({ name, request })
        return {
          localAgent,
          result: Promise.resolve({ output: [{ type: 'text', text: 'worker-ok' }], stopReason: 'stop' }),
          dispose: async () => {},
        }
      },
    },
    agents: { get: () => null },
    settings: {
      updates: [],
      register(ns, schema) {
        const scope = {
          get: () => ({
            strongProvider: 'deepseek-official',
            strongModel: 'deepseek-v4-pro',
            strongEffort: 'max',
            cheapProvider: 'deepseek-official',
            cheapModel: 'deepseek-v4-flash',
            cheapEffort: 'high',
            subagentPolicy: 'inherit',
          }),
          watch: () => () => {},
          update: async (patch) => { this.updates.push(patch) },
        }
        this.scope = scope
        return scope
      },
    },
    jobs: {
      controllers: [],
      hooks: null,
      attachController(name) { this.controllers.push(name) },
      start(spec) {
        this.hooks = spec.run()
        return 'subagent-1'
      },
    },
  }
  ctx.services = services
  return { ctx, services }
}

test('apply() registers every surface and loads without throwing', () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const names = services.tools.registered.map((t) => t.name).sort()
  assert.deepEqual(names, ['tier_advisor', 'tier_configure', 'tier_review', 'tier_route', 'tier_status', 'tier_worker'])
  assert.deepEqual(services.commands.registered.map((c) => c.name).sort(), ['advisor', 'tier'])
  assert.equal(services.systemPrompt.sections.length, 1)
  assert.equal(services.systemPrompt.sections[0].name, 'tier-routing')
  assert.ok(services.systemPrompt.sections[0].text().includes('Tiered model routing'))
  assert.ok(services.jobs.controllers.includes('tier-worker'), 'jobs controller attached')
  assert.ok(services.settings.scope, 'settings scope created')
  for (const event of ['agent/inbox/inserted', 'session/event', 'agent/error', 'tools/pre-execute']) {
    assert.ok(ctx.listeners[event] && ctx.listeners[event].length >= 1, 'listener registered for ' + event)
  }
  assert.equal(ctx.listeners['agent/request'], undefined, 'does not wrap DSH model-selection waterfall')
})

test('tier_route applies per-session mode and writes the session header', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  const out = await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  assert.equal(out.applied, 'cheap')
  assert.ok(!out.message.includes('Saved as the session default'), 'persist defaults to false')
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(headers.length, 1)
  assert.deepEqual(headers[0].payload.header.config, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
})

test('plan-flip handler honors an explicit per-session mode (v0.4.1 fix)', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  services.agents.get = (id) => (id === main.session.id ? main : null)
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  main.writes.length = 0
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(headers.length, 1, 'plan flip wrote exactly one header')
  assert.equal(headers[0].payload.header.config.model, 'deepseek-v4-flash', 'cheap session must NOT flip to strong on plan entry')
})

test('plan-flip handler still follows plan state in auto mode', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  services.agents.get = (id) => (id === main.session.id ? main : null)
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(headers[0].payload.header.config.model, 'deepseek-v4-pro', 'auto mode enters plan on strong')
  main.writes.length = 0
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: false } })
  assert.equal(main.writes.filter((w) => w.kind === 'request/header')[0].payload.header.config.model, 'deepseek-v4-flash')
})

test('failure escalation now covers built-in-subagent children (v0.4.1 fix)', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const child = makeAgent('child', 'subagent')
  for (const fn of ctx.listeners['agent/error']) {
    fn({ agent: child, error: { message: 'boom 1' } })
    fn({ agent: child, error: { message: 'boom 2' } })
  }
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: child, signal: undefined })
  assert.ok(out.status.includes('effective tier for calling agent: strong'), 'escalated child resolves to strong')
  assert.ok(out.status.includes('(ESCALATED to strong)'))
})

test('foreground tier_worker settles with the worker result', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
  const out = await worker.execute({ task: 'say ok', tier: 'cheap' }, { agent: main, signal: undefined })
  assert.equal(out.output, 'worker-ok')
  assert.equal(out.stopReason, 'stop')
  assert.equal(out.model, 'deepseek-v4-flash')
  assert.equal(services.subagents.started.length, 1)
  assert.equal(services.subagents.started[0].name, 'spawn')
  assert.deepEqual(services.subagents.started[0].request.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  })
})

test('background tier_worker resolves a proper JobOutcome (v0.4.1 fix)', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
  const out = await worker.execute({ task: 'say ok', tier: 'cheap', background: true }, { agent: main, signal: undefined })
  assert.equal(out.background, true)
  assert.equal(out.jobId, 'subagent-1')
  assert.ok(services.jobs.hooks, 'jobs.start invoked the producer run()')
  const outcome = await services.jobs.hooks.done
  assert.equal(outcome.status, 'completed')
  assert.ok(outcome.detail.includes('deepseek-v4-flash'), 'detail carries tier/model')
  assert.equal(outcome.output, 'worker-ok')
})

test('tier_configure persists to settings by default, sessionOnly keeps it in memory', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r1 = await configure.execute({ tier: 'cheap', provider: 'opencode-go', model: 'deepseek-v4-flash' }, { agent: main, signal: undefined })
  assert.equal(r1.ok, true)
  assert.equal(services.settings.updates.length, 1, 'persisted once by default')
  const patch = services.settings.updates[0]
  assert.equal(patch.cheapProvider, 'opencode-go')
  assert.equal(patch.subagentPolicy, 'inherit')
  await configure.execute({ tier: 'strong', provider: 'opencode-go', model: 'deepseek-v4-pro', sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(services.settings.updates.length, 1, 'sessionOnly skipped persistence')
})

test('tier_advisor and tier_review stream through the configured strong tier', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const advisor = services.tools.registered.find((t) => t.name === 'tier_advisor')
  const review = services.tools.registered.find((t) => t.name === 'tier_review')
  const a = await advisor.execute({ question: 'should we proceed?' }, { agent: makeAgent('main'), signal: undefined })
  assert.equal(a.advice, 'MOCK ADVICE')
  assert.equal(a.ok, true)
  assert.equal(a.provider, 'deepseek-official')
  assert.equal(a.model, 'deepseek-v4-pro')
  const r = await review.execute({ focus: 'the change set' }, { agent: makeAgent('main'), signal: undefined })
  assert.equal(r.verdict, 'UNPARSED')
  assert.equal(r.ok, true)
})

test('guard denies high-impact commands on the cheap tier', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const guard = ctx.listeners['tools/pre-execute'][0]
  let denied = null
  let nextCalled = 0
  const result = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, async () => { nextCalled += 1 })
  assert.equal(result.kind, 'deny')
  assert.ok(result.reason.includes('cheap tier'))
  denied = result
  assert.equal(nextCalled, 0)
  const allowed = await guard({ agent: main, name: 'bash', arguments: { command: 'ls -la' } }, async () => 'ok')
  assert.equal(allowed, 'ok')
  assert.ok(denied)
})

test('auto routing folds plan state from the session log when planMode is unreachable', async () => {
  // Agent-plane install: the planMode service lives in an isolate realm the
  // bundle cannot reach; plan state must come from the session log fold.
  const { ctx, services } = makeContext()
  services.planMode = undefined
  apply(ctx)
  const main = makeAgent('main')
  services.agents.get = (id) => (id === main.session.id ? main : null)
  main.session.events.push({ type: 'plan/mode', data: { active: true } })
  for (const fn of ctx.listeners['agent/inbox/inserted']) {
    fn({ agent: main, message: { source: { kind: 'user' }, content: [] } })
  }
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(headers.length, 1)
  assert.equal(headers[0].payload.header.config.model, 'deepseek-v4-pro', 'plan-active session routes strong without the planMode service')
})

test('/tier plan appends plan/mode to the session log when planMode is unreachable', async () => {
  const { ctx, services } = makeContext()
  services.planMode = undefined
  apply(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const out = await cmd.handler({ agent: main, rawInput: 'plan', signal: undefined })
  assert.ok(out.text.includes('Plan mode: committed'), out.text)
  const appended = main.writes.filter((w) => w.kind === 'plan/mode')
  assert.equal(appended.length, 1)
  assert.deepEqual(appended[0].payload, { active: true })
})
