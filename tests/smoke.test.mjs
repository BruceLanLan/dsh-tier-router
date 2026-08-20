// Runtime smoke test: loads the real bundle with a fully mocked Cordis
// context, runs apply(), and exercises every tool/command/listener path,
// including the v0.5.0 additions (fallback chains, task-intensity effort,
// followSession strong tier, effort validation against model metadata).
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

function makeContext(options = {}) {
  const ctx = {
    listeners: {},
    on(name, fn) {
      ;(ctx.listeners[name] || (ctx.listeners[name] = [])).push(fn)
    },
    get(name) { return ctx.services[name] },
  }
  const services = {
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }, { id: 'opencode-go' }, { id: 'cctq' }],
      listModels: async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }, { id: 'gpt-5.6-terra' }],
      resolveModelInfo: async (provider, model) => {
        const efforts = provider === 'cctq' ? ['low', 'medium', 'high'] : ['off', 'high', 'max']
        return { provider, id: model, name: model, reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } }
      },
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
            ...(options.omitMode ? {} : { mode: options.mode || 'auto' }),
            strongProvider: 'deepseek-official',
            strongModel: 'deepseek-v4-pro',
            strongEffort: 'max',
            strongFollowSession: true,
            strongFallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }],
            cheapProvider: 'cctq',
            cheapModel: 'gpt-5.6-terra',
            cheapEffort: 'medium',
            cheapFollowSession: false,
            cheapFallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }],
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
  assert.deepEqual(names, ['tier_advisor', 'tier_configure', 'tier_escalate_effort', 'tier_review', 'tier_route', 'tier_status', 'tier_worker'])
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

test('legacy settings without a mode retain the auto default', async () => {
  const { ctx, services } = makeContext({ omitMode: true })
  apply(ctx)
  const main = makeAgent('main')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('mode: global=auto, this session=auto'), out.status)
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
  assert.deepEqual(headers[0].payload.header.config, { provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
})

test('delegated mode pins the main agent to the session selection while children stay tiered', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const main = makeAgent('main')
  services.agents.get = (id) => (id === main.session.id ? main : null)
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'delegated' }, { agent: main, signal: undefined })
  assert.deepEqual(main.writes.filter((w) => w.kind === 'request/header').at(-1).payload.header.config, {
    provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high',
  })

  main.writes.length = 0
  for (const fn of ctx.listeners['agent/inbox/inserted']) {
    fn({ agent: main, message: { source: { kind: 'user' }, content: [] } })
  }
  assert.equal(main.writes.filter((w) => w.kind === 'request/header').length, 1)
  assert.equal(main.writes.at(-1).payload.header.config.model, 'gpt-5.6-sol')

  main.writes.length = 0
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  assert.equal(main.writes.filter((w) => w.kind === 'request/header').length, 1)
  assert.equal(main.writes.at(-1).payload.header.config.model, 'gpt-5.6-sol', 'plan flips do not tier-route the main agent')

  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'boom 1' } })
    await fn({ agent: main, error: { message: 'boom 2' } })
  }
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const mainStatus = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(!mainStatus.status.includes('(ESCALATED to strong)'), mainStatus.status)

  const child = makeAgent('child', 'subagent')
  const childStatus = await status.execute({}, { agent: child, signal: undefined })
  assert.ok(childStatus.status.includes('effective tier for calling agent: cheap'), childStatus.status)
})

test('persisted delegated mode keeps unoverridden main listeners pinned and routes children', async () => {
  const { ctx, services } = makeContext({ mode: 'delegated' })
  apply(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const main = makeAgent('main')
  services.agents.get = (id) => (id === main.session.id ? main : null)

  for (const fn of ctx.listeners['agent/inbox/inserted']) {
    fn({ agent: main, message: { source: { kind: 'user' }, content: [] } })
  }
  assert.equal(main.writes.filter((w) => w.kind === 'request/header').at(-1).payload.header.config.model, 'gpt-5.6-sol')

  main.writes.length = 0
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  assert.equal(main.writes.filter((w) => w.kind === 'request/header').at(-1).payload.header.config.model, 'gpt-5.6-sol')

  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const mainStatus = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(mainStatus.status.includes('mode: global=delegated, this session=delegated'), mainStatus.status)
  assert.ok(mainStatus.status.includes('effective tier for calling agent: session-default (delegated main; guard class strong)'), mainStatus.status)

  const child = makeAgent('child', 'subagent')
  child.session.events.push({ type: 'plan/mode', data: { active: true } })
  const childStatus = await status.execute({}, { agent: child, signal: undefined })
  assert.ok(childStatus.status.includes('effective tier for calling agent: strong'), childStatus.status)
})

test('session auto overrides delegated mode and restores plan-aware main routing', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'delegated' }, { agent: main, signal: undefined })
  main.writes.length = 0
  await route.execute({ tier: 'auto' }, { agent: main, signal: undefined })
  assert.equal(main.writes.filter((w) => w.kind === 'request/header').at(-1).payload.header.config.model, 'gpt-5.6-terra')
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
  assert.equal(headers[0].payload.header.config.model, 'gpt-5.6-terra', 'cheap session must NOT flip to strong on plan entry')
})

test('plan-flip handler still follows plan state in auto mode', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  services.agents.get = (id) => (id === main.session.id ? main : null)
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: true } })
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(headers[0].payload.header.config.model, 'deepseek-v4-pro', 'auto mode enters plan on strong (followSession -> session selection)')
  main.writes.length = 0
  for (const fn of ctx.listeners['session/event']) fn(main.session, { type: 'plan/mode', data: { active: false } })
  assert.equal(main.writes.filter((w) => w.kind === 'request/header')[0].payload.header.config.model, 'gpt-5.6-terra')
})

test('strong followSession semantics: session selection drives the strong header', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'strong' }, { agent: main, signal: undefined })
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.deepEqual(headers[0].payload.header.config, { provider: 'cctq', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
})

test('failure escalation now covers built-in-subagent children (v0.4.1 fix)', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const child = makeAgent('child', 'subagent')
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: child, error: { message: 'boom 1' } })
    await fn({ agent: child, error: { message: 'boom 2' } })
  }
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: child, signal: undefined })
  assert.ok(out.status.includes('effective tier for calling agent: strong'), 'escalated child resolves to strong')
  assert.ok(out.status.includes('(ESCALATED to strong)'))
})

test('fallback chain switches the header and is kept by inbox writes until TTL', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  main.writes.length = 0
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'unknown model', code: 'UNKNOWN_MODEL' } })
  }
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(headers.length, 1)
  assert.deepEqual(headers[0].payload.header.config, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }, 'cheap falls back to its chain entry')
  // Conservative recovery: no llm success event exists in the rc.7 agent loop,
  // so the fallback header is kept on the next inbox write while the TTL is valid.
  main.writes.length = 0
  for (const fn of ctx.listeners['agent/inbox/inserted']) {
    fn({ agent: main, message: { source: { kind: 'user' }, content: [] } })
  }
  const after = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(after.length, 1)
  assert.equal(after[0].payload.header.config.model, 'deepseek-v4-flash', 'fallback header is kept until the TTL expires')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('fallback state: index=0/1'), out.status)
  assert.ok(out.status.includes('cheap effort: high'), 'cheap effort raised by the retry error: ' + out.status)
})

test('mode switches clear per-agent fallback state', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'quota', code: 'QUOTA' } })
  }
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  main.writes.length = 0
  for (const fn of ctx.listeners['agent/inbox/inserted']) {
    fn({ agent: main, message: { source: { kind: 'user' }, content: [] } })
  }
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(headers.length, 1)
  assert.deepEqual(headers[0].payload.header.config, { provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium' }, 'primary model is used again after a mode switch')
})

test('chain exhaustion clears fallback state and lets escalation take over', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'unknown model', code: 'UNKNOWN_MODEL' } })
    await fn({ agent: main, error: { message: 'unknown model again', code: 'UNKNOWN_MODEL' } })
  }
  const headers = main.writes.filter((w) => w.kind === 'request/header')
  assert.equal(headers[headers.length - 1].payload.header.config.model, 'deepseek-v4-pro', 'second failure escalates to strong after the chain is exhausted')
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('main model (no fallback active)'), out.status)
  assert.ok(out.status.includes('ESCALATED to strong'), out.status)
})

test('cheap effort ladder raises on cheap-tier retry errors', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  for (const fn of ctx.listeners['agent/error']) {
    await fn({ agent: main, error: { message: 'timeout', code: 'TIMEOUT' } })
  }
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('cheap effort: high'), out.status)
})

test('guard denials raise the cheap effort', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const guard = ctx.listeners['tools/pre-execute'][0]
  const result = await guard({ agent: main, name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, async () => {})
  assert.equal(result.kind, 'deny')
  assert.ok(result.reason.includes('raised to high'), result.reason)
  const status = services.tools.registered.find((t) => t.name === 'tier_status')
  const out = await status.execute({}, { agent: main, signal: undefined })
  assert.ok(out.status.includes('cheap effort: high'), out.status)
})

test('tier_escalate_effort raises one step and respects the model ceiling', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const route = services.tools.registered.find((t) => t.name === 'tier_route')
  await route.execute({ tier: 'cheap' }, { agent: main, signal: undefined })
  const tool = services.tools.registered.find((t) => t.name === 'tier_escalate_effort')
  const r1 = await tool.execute({}, { agent: main, signal: undefined })
  assert.equal(r1.ok, true)
  assert.equal(r1.effort, 'high')
  const r2 = await tool.execute({}, { agent: main, signal: undefined })
  assert.equal(r2.ok, false, 'cctq declares only low/medium/high')
  assert.ok(r2.message.includes('declares only'), r2.message)
})


test('/tier delegated switches the current session and /tier auto leaves it', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const delegated = await cmd.handler({ agent: main, rawInput: 'delegated', signal: undefined })
  assert.equal(delegated.kind, 'success')
  assert.ok(delegated.text.includes('only subagents are tier-routed'), delegated.text)
  const status = await cmd.handler({ agent: main, rawInput: 'status', signal: undefined })
  assert.ok(status.text.includes('this session=delegated'), status.text)
  const auto = await cmd.handler({ agent: main, rawInput: 'auto', signal: undefined })
  assert.equal(auto.kind, 'success')
  assert.ok(auto.text.includes('plan mode -> strong tier'), auto.text)
})

test('/tier set parses fallback chains and follow-session', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const r1 = await cmd.handler({ agent: main, rawInput: 'set cheap cctq gpt-5.6-terra medium --fallback deepseek-official deepseek-v4-flash high', signal: undefined })
  assert.equal(r1.kind, 'success', r1.text)
  assert.ok(r1.text.includes('gpt-5.6-terra'), r1.text)
  assert.ok(r1.text.includes('deepseek-official/deepseek-v4-flash@high'), r1.text)
  const r2 = await cmd.handler({ agent: main, rawInput: 'set strong follow-session', signal: undefined })
  assert.equal(r2.kind, 'success', r2.text)
  assert.ok(r2.text.includes('follows session selection'), r2.text)
  const r3 = await cmd.handler({ agent: main, rawInput: 'set cheap cctq gpt-5.6-terra medium --fallback cctq gpt-5.6-terra max', signal: undefined })
  assert.equal(r3.kind, 'error', 'fallback effort max is undeclared for cctq')
  assert.ok(r3.text.includes('declares only'), r3.text)
})

test('/tier effort validates against the cheap model declarations', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const ok = await cmd.handler({ agent: main, rawInput: 'effort high', signal: undefined })
  assert.equal(ok.kind, 'success', ok.text)
  assert.ok(ok.text.includes('set to "high"'), ok.text)
  const bad = await cmd.handler({ agent: main, rawInput: 'effort max', signal: undefined })
  assert.equal(bad.kind, 'error')
  assert.ok(bad.text.includes('declares only low, medium, high'), bad.text)
})

test('tier_configure rejects undeclared efforts and validates fallback chains', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r1 = await configure.execute({ tier: 'cheap', provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'max' }, { agent: main, signal: undefined })
  assert.equal(r1.ok, false)
  assert.ok(r1.message.includes('low, medium, high'), r1.message)
  const r2 = await configure.execute({ tier: 'cheap', provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'high', fallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }], sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r2.ok, true, r2.message)
  const r3 = await configure.execute({ tier: 'cheap', provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'medium', fallback: [{ provider: 'cctq', model: 'gpt-5.6-terra', reasoningEffort: 'max' }], sessionOnly: true }, { agent: main, signal: undefined })
  assert.equal(r3.ok, false, 'fallback entry effort must be declared by its model')
  assert.ok(r3.message.includes('low, medium, high'), r3.message)
})

test('foreground tier_worker settles with the worker result', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const worker = services.tools.registered.find((t) => t.name === 'tier_worker')
  const out = await worker.execute({ task: 'say ok', tier: 'cheap' }, { agent: main, signal: undefined })
  assert.equal(out.output, 'worker-ok')
  assert.equal(out.stopReason, 'stop')
  assert.equal(out.model, 'gpt-5.6-terra')
  assert.equal(services.subagents.started.length, 1)
  assert.equal(services.subagents.started[0].name, 'spawn')
  assert.deepEqual(services.subagents.started[0].request.agentOptions, {
    provider: 'cctq',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
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
  assert.ok(outcome.detail.includes('cctq/gpt-5.6-terra'), 'detail carries tier/model')
  assert.equal(outcome.output, 'worker-ok')
})

test('tier_configure persists followSession and fallback chains by default', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const configure = services.tools.registered.find((t) => t.name === 'tier_configure')
  const r1 = await configure.execute({ tier: 'cheap', provider: 'opencode-go', model: 'deepseek-v4-flash' }, { agent: main, signal: undefined })
  assert.equal(r1.ok, true)
  assert.equal(services.settings.updates.length, 1, 'persisted once by default')
  const patch = services.settings.updates[0]
  assert.equal(patch.mode, 'auto')
  assert.equal(patch.cheapProvider, 'opencode-go')
  assert.equal(patch.cheapFollowSession, false)
  assert.equal(patch.strongFollowSession, true)
  assert.deepEqual(patch.cheapFallback, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }])
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

test('/tier status reports fallback chains and cheap effort', async () => {
  const { ctx, services } = makeContext()
  apply(ctx)
  const main = makeAgent('main')
  const cmd = services.commands.registered.find((c) => c.name === 'tier')
  const out = await cmd.handler({ agent: main, rawInput: 'status', signal: undefined })
  assert.ok(out.text.includes('fallback: deepseek-official/deepseek-v4-pro@max'), out.text)
  assert.ok(out.text.includes('fallback: deepseek-official/deepseek-v4-flash@high'), out.text)
  assert.ok(out.text.includes('fallback TTL: 300s'), out.text)
})