// dsh-tier-router — Tiered model routing for DeepSeek Harness.
//
// Routes model steps by task difficulty: a strong tier (default
// deepseek-v4-pro) handles planning / architecture / review, a cheap tier
// (default deepseek-v4-flash) handles routine implementation. Provides
// plan-mode-aware auto routing, /advisor + tier_advisor consultations,
// tier_review, a deterministic high-impact escalation guard, failure
// auto-escalation, and subagent tiering via tier_worker / subagent policy.
//
// Main sessions are routed by writing the session request/header before each
// step (agent/inbox/inserted + plan/mode events), which is the seam the
// api-proxy selection layer reads. Subagent children are routed directly at
// the agent/request waterfall.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { isHighImpact, resolveTierSpec } from './pure.js'

export const name = 'tier-routing'

export function apply(ctx) {
  const llm = ctx.get('llm')
  if (!llm) {
    console.error('tier: llm service unavailable')
    return
  }
  const commands = ctx.get('commands')
  const tools = ctx.get('tools')
  const planMode = ctx.get('planMode')
  const agentDefaultModel = ctx.get('agentDefaultModel')
  const systemPrompt = ctx.get('systemPrompt')
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')

  const state = {
    strong: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max', label: 'strong' },
    cheap: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', label: 'cheap' },
    mode: 'auto',
    subagentPolicy: 'inherit',
    escalateThreshold: 2,
    escalateWindowMs: 60000,
    escalateTtlMs: 180000,
  }
  const childTiers = new WeakMap()
  const sessionModes = new WeakMap()
  const escalations = new WeakMap()
  const diag = { requestSteps: 0, guardChecks: 0, guardDenies: 0, headerWrites: 0, inboxSeen: 0, planFlips: 0, errorsSeen: 0, escalations: 0, lastRouting: '', lastGuard: '', lastGuardError: '', lastHeader: '', lastError: '', lastEscalation: '' }

  let providerCache = null
  let providerCacheAt = 0
  function availableProviders() {
    const now = Date.now()
    if (providerCache && now - providerCacheAt < 10000) return providerCache
    try {
      providerCache = (llm.listProviders() || []).map(function (p) { return p.id })
      providerCacheAt = now
    } catch (e) {
      console.error('tier: listProviders failed: ' + String(e && e.message || e))
      providerCache = providerCache || []
    }
    return providerCache
  }

  function tierLabel(tier) { return tier.provider + '/' + tier.model + ' (' + tier.reasoningEffort + ')' }

  function agentIdentity(agent) {
    let id = '?'
    let origin = '?'
    try { id = String(agent && agent.id) } catch (e) { id = 'unreadable' }
    try { origin = String(agent && agent.session && agent.session.header && agent.session.header.origin || '') || '(main)' } catch (e) { origin = 'unreadable' }
    return id + '[' + origin + ']'
  }

  function isChildAgent(agent) {
    if (!agent) return false
    if (childTiers.has(agent)) return true
    try { return !!(agent.session && agent.session.header && agent.session.header.origin === 'subagent') } catch (e) { return false }
  }

  function effectiveMode(agent) {
    if (agent && sessionModes.has(agent)) return sessionModes.get(agent)
    return state.mode
  }

  function planActive(agent) {
    let active = false
    try {
      if (planMode && agent) {
        const st = planMode.get(agent)
        if (st && st.active) active = true
      }
    } catch (e) {}
    return active
  }

  function escalationActive(agent) {
    if (!agent || !escalations.has(agent)) return false
    const e = escalations.get(agent)
    if (e.until > Date.now()) return true
    escalations.delete(agent)
    return false
  }

  function resolveTarget(agent) {
    const spec = {
      explicitTier: agent && childTiers.has(agent) ? childTiers.get(agent) : undefined,
      sessionMode: agent ? sessionModes.get(agent) : undefined,
      escalated: escalationActive(agent),
      isChild: isChildAgent(agent),
      subagentPolicy: state.subagentPolicy,
      mode: state.mode,
      planActive: planActive(agent),
    }
    const tierName = resolveTierSpec(spec)
    return tierName === 'strong' ? state.strong : (tierName === 'cheap' ? state.cheap : null)
  }

  function headerConfigOf(session) {
    try {
      const h = session && session.requestHeader ? session.requestHeader() : undefined
      return h ? h.config : undefined
    } catch (e) { return undefined }
  }

  function ensureHeader(agent, target) {
    if (!agent || !target) return
    try {
      const session = agent.session
      if (!session || typeof session.append !== 'function' || typeof session.requestHeader !== 'function') return
      const cur = headerConfigOf(session)
      if (cur && cur.provider === target.provider && cur.model === target.model && cur.reasoningEffort === target.reasoningEffort) return
      session.append('request/header', {
        header: { config: { provider: target.provider, model: target.model, reasoningEffort: target.reasoningEffort } },
        reason: 'change',
      })
      diag.headerWrites = diag.headerWrites + 1
      diag.lastHeader = 'wrote ' + tierLabel(target) + ' for ' + agentIdentity(agent) + ' (was ' + (cur ? cur.provider + '/' + cur.model : 'none') + ')'
    } catch (e) {
      diag.lastHeader = 'header write failed: ' + String(e && e.message || e)
      console.error('tier: header write failed: ' + String(e && e.message || e))
    }
  }

  function defaultSelectionTarget() {
    try {
      if (agentDefaultModel) {
        const sel = agentDefaultModel.currentSelection()
        if (sel && typeof sel.provider === 'string') {
          return { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || 'high' }
        }
      }
    } catch (e) {}
    return null
  }

  const ADVISOR_SYSTEM = [
    'You are the Tier Advisor: the strong-tier consultant for a coding agent that implements work in a cheaper model.',
    'Answer ONE explicit decision question using the provided evidence. Do not implement; do not take over the task.',
    'Return, in order: Recommendation; Decisive evidence; Rejected alternatives; Risks; Implementation constraints; Acceptance criteria; Remaining uncertainty.',
    'If the evidence is insufficient, state the cheapest additional check needed instead of guessing. Be concise.',
  ].join('\n')

  const REVIEW_SYSTEM = [
    'You are the Tier Reviewer: an independent strong-tier reviewer for a coding agent.',
    'Review the provided work state and evidence for correctness, security, data integrity, compatibility, and completeness.',
    'Return, in order: Verdict (APPROVE or NEEDS-CHANGES or BLOCKED); Issues ranked by severity with concrete fixes; Unverified claims; Recommended follow-ups.',
    'Only claim what the evidence supports. Be concise.',
  ].join('\n')

  let msgSeq = 0
  async function streamText(tier, system, userText, signal) {
    if (availableProviders().indexOf(tier.provider) === -1) {
      throw new Error('provider "' + tier.provider + '" is not registered in this process. Registered: ' + availableProviders().join(', '))
    }
    const options = {
      provider: tier.provider,
      model: tier.model,
      reasoningEffort: tier.reasoningEffort,
      system: system,
      messages: [{
        id: 'tier-msg-' + (++msgSeq) + '-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }],
      signal: signal,
    }
    let text = ''
    let finish = null
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk && chunk.type === 'text-delta') text += chunk.text
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
      }
    } catch (e) {
      finish = { kind: 'error', failure: { message: String(e && e.message || e) } }
    }
    if (!finish) finish = { kind: 'error', failure: { message: 'stream ended without a finish chunk' } }
    if (finish.kind === 'stop' && text.trim().length > 0) return { text: text.trim(), ok: true, truncated: false }
    if (finish.kind === 'max-tokens' && text.trim().length > 0) return { text: text.trim() + '\n[truncated by max-tokens]', ok: true, truncated: true }
    if (finish.kind === 'aborted') return { text: 'Call was aborted.', ok: false }
    return { text: 'Call failed: ' + String(finish.failure && finish.failure.message || finish.kind), ok: false }
  }

  function effectiveExecutionTier(agent) {
    if (effectiveMode(agent) === 'off') {
      try {
        const sel = agentDefaultModel && agentDefaultModel.currentSelection()
        if (sel && sel.provider === state.cheap.provider && sel.model === state.cheap.model) return 'cheap'
      } catch (e) {}
      return 'strong'
    }
    const target = resolveTarget(agent)
    return target === state.cheap ? 'cheap' : 'strong'
  }

  async function listModelsText() {
    const lines = []
    for (const provider of availableProviders()) {
      try {
        const models = await llm.listModels(provider)
        lines.push(provider + ': ' + ((models || []).map(function (m) { return m.id }).join(', ') || '(no catalog)'))
      } catch (e) {
        lines.push(provider + ': (listModels failed: ' + String(e && e.message || e) + ')')
      }
    }
    return lines.join('\n')
  }

  function statusText(agent) {
    let sessionDefault = ''
    if (agentDefaultModel) {
      try {
        const sel = agentDefaultModel.currentSelection()
        if (sel && typeof sel.provider === 'string') sessionDefault = 'session default: ' + sel.provider + '/' + sel.model + ' (' + (sel.reasoningEffort || 'default') + ')'
      } catch (e) {}
    }
    return [
      'Tiered model routing',
      '  mode: global=' + state.mode + ', this session=' + (agent ? (sessionModes.has(agent) ? sessionModes.get(agent) : state.mode) : 'n/a') + ' (per-session via /tier strong|cheap|auto|off; escalate: ' + state.escalateThreshold + ' errors / ' + Math.round(state.escalateWindowMs / 1000) + 's window -> ' + Math.round(state.escalateTtlMs / 1000) + 's strong)',
      '  strong: ' + tierLabel(state.strong),
      '  cheap:  ' + tierLabel(state.cheap),
      '  subagents: ' + state.subagentPolicy,
      '  subagent providers: ' + (subagents ? subagents.list().join(', ') : 'n/a'),
      '  diag: requestSteps=' + diag.requestSteps + ' guardChecks=' + diag.guardChecks + ' guardDenies=' + diag.guardDenies + ' headerWrites=' + diag.headerWrites + ' inboxSeen=' + diag.inboxSeen + ' planFlips=' + diag.planFlips + ' errorsSeen=' + diag.errorsSeen + ' escalations=' + diag.escalations,
      diag.lastRouting ? '  lastRouting: ' + diag.lastRouting : '',
      diag.lastGuard ? '  lastGuard: ' + diag.lastGuard : '',
      diag.lastGuardError ? '  lastGuardError: ' + diag.lastGuardError : '',
      diag.lastHeader ? '  lastHeader: ' + diag.lastHeader : '',
      diag.lastError ? '  lastError: ' + diag.lastError : '',
      diag.lastEscalation ? '  lastEscalation: ' + diag.lastEscalation : '',
      sessionDefault ? '  ' + sessionDefault : '  session default: unavailable',
      '  providers: ' + availableProviders().join(', '),
    ].join('\n')
  }

  async function applyRoute(tier, persist, agent) {
    if (tier === 'auto') {
      if (agent) sessionModes.delete(agent)
      if (agent && !isChildAgent(agent)) ensureHeader(agent, planActive(agent) ? state.strong : state.cheap)
      return { applied: tier, message: 'Routing mode set to auto for THIS session (plan mode -> strong tier, execution -> cheap tier). Other sessions keep their own mode.' }
    }
    if (tier === 'off') {
      if (agent) sessionModes.set(agent, 'off')
      if (agent && !isChildAgent(agent)) {
        const def = defaultSelectionTarget()
        if (def) ensureHeader(agent, def)
      }
      return { applied: tier, message: 'Routing disabled for THIS session; its model returned to the default. Other sessions are unaffected; only explicit commands and tools act here.' }
    }
    const target = state[tier]
    if (!target) return { applied: tier, message: 'Unknown tier "' + tier + '". Use strong, cheap, auto, or off.' }
    if (availableProviders().indexOf(target.provider) === -1) {
      return { applied: tier, message: 'Provider "' + target.provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    if (agent) sessionModes.set(agent, tier)
    if (agent && !isChildAgent(agent)) ensureHeader(agent, target)
    let persisted = ''
    if (persist && agentDefaultModel) {
      try {
        await agentDefaultModel.saveSelection({ provider: target.provider, model: target.model, reasoningEffort: target.reasoningEffort })
        persisted = ' Saved as the session default.'
      } catch (e) {
        persisted = ' Could not persist the session default: ' + String(e && e.message || e)
      }
    }
    return { applied: tier, message: 'This session now routes to the ' + tier + ' tier (' + tierLabel(target) + '). Other sessions keep their own mode.' + persisted }
  }

  async function applyConfigure(args, agent) {
    const tierName = args.tier === 'strong' ? 'strong' : 'cheap'
    if (availableProviders().indexOf(args.provider) === -1) {
      return { ok: false, message: 'Provider "' + args.provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    const effort = args.reasoningEffort || state[tierName].reasoningEffort || (tierName === 'strong' ? 'max' : 'high')
    state[tierName] = { provider: args.provider, model: args.model, reasoningEffort: effort, label: tierName }
    if (args.subagentPolicy && ['inherit', 'cheap', 'strong'].indexOf(args.subagentPolicy) !== -1) state.subagentPolicy = args.subagentPolicy
    if (agent && !isChildAgent(agent) && (effectiveMode(agent) === tierName || effectiveMode(agent) === 'auto')) ensureHeader(agent, state[tierName])
    let persisted = ''
    if (args.persist && agentDefaultModel) {
      try {
        await agentDefaultModel.saveSelection({ provider: args.provider, model: args.model, reasoningEffort: effort })
        persisted = ' Saved as the session default.'
      } catch (e) {
        persisted = ' Could not persist the session default: ' + String(e && e.message || e)
      }
    }
    return { ok: true, message: 'Configured ' + tierName + ' tier: ' + tierLabel(state[tierName]) + '. Subagent policy: ' + state.subagentPolicy + '.' + persisted }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/request', async (payload, next) => {
      const config = await next()
      diag.requestSteps = diag.requestSteps + 1
      const stepNo = diag.requestSteps
      try {
        const agent = payload && payload.agent
        if (effectiveMode(agent) === 'off') { diag.lastRouting = 'step' + stepNo + ': mode=off, untouched (' + agentIdentity(agent) + ')'; return config }
        if (!config || typeof config !== 'object' || typeof config.provider !== 'string') { diag.lastRouting = 'step' + stepNo + ': no valid config'; return config }
        if (!isChildAgent(agent)) {
          diag.lastRouting = 'step' + stepNo + ': main agent ' + agentIdentity(agent) + ' — routing via session header (inbox/plan listeners)'
          return config
        }
        const target = resolveTarget(agent)
        if (!target || availableProviders().indexOf(target.provider) === -1) { diag.lastRouting = 'step' + stepNo + ': target unavailable (' + agentIdentity(agent) + ')'; return config }
        if (config.provider === target.provider && config.model === target.model && config.reasoningEffort === target.reasoningEffort) { diag.lastRouting = 'step' + stepNo + ': child already ' + tierLabel(target) + ' (' + agentIdentity(agent) + ')'; return config }
        const nextConfig = {}
        for (const key of Object.keys(config)) nextConfig[key] = config[key]
        nextConfig.provider = target.provider
        nextConfig.model = target.model
        nextConfig.reasoningEffort = target.reasoningEffort
        diag.lastRouting = 'step' + stepNo + ': child swapped ' + config.provider + '/' + config.model + ' -> ' + tierLabel(target) + ' (' + agentIdentity(agent) + ')'
        return nextConfig
      } catch (e) {
        diag.lastRouting = 'step' + stepNo + ': ERROR ' + String(e && e.message || e)
        console.error('tier: agent/request routing failed: ' + String(e && e.message || e))
        return config
      }
    })

    ctx.on('agent/inbox/inserted', (payload) => {
      diag.inboxSeen = diag.inboxSeen + 1
      try {
        const agent = payload && payload.agent
        const message = payload && payload.message
        if (!agent || !message) return
        if (effectiveMode(agent) === 'off') return
        try { if (!message.source || message.source.kind !== 'user') return } catch (e) {}
        if (isChildAgent(agent)) return
        ensureHeader(agent, resolveTarget(agent) || state.cheap)
      } catch (e) {
        console.error('tier: inbox routing failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'plan/mode') return
        diag.planFlips = diag.planFlips + 1
        const active = !!(event.data && event.data.active)
        const agent = agents ? agents.get(session.id) : undefined
        if (!agent || isChildAgent(agent)) return
        if (effectiveMode(agent) === 'off') return
        ensureHeader(agent, active ? state.strong : state.cheap)
      } catch (e) {
        console.error('tier: plan-flip routing failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('agent/error', (payload) => {
      diag.errorsSeen = diag.errorsSeen + 1
      try {
        const agent = payload && payload.agent
        if (!agent) return
        diag.lastError = '#' + diag.errorsSeen + ' ' + agentIdentity(agent) + ': ' + String((payload && payload.error && (payload.error.message || payload.error)) || 'unknown').slice(0, 140)
        if (effectiveMode(agent) === 'off') return
        const now = Date.now()
        let rec = escalations.get(agent)
        if (!rec || now - rec.windowStart > state.escalateWindowMs) {
          rec = { count: 0, windowStart: now, until: 0 }
          escalations.set(agent, rec)
        }
        rec.count = rec.count + 1
        if (rec.count >= state.escalateThreshold && rec.until < now) {
          rec.until = now + state.escalateTtlMs
          diag.escalations = diag.escalations + 1
          diag.lastEscalation = '#' + diag.escalations + ' escalated ' + agentIdentity(agent) + ' for ' + Math.round(state.escalateTtlMs / 1000) + 's after ' + rec.count + ' errors'
          if (!isChildAgent(agent)) ensureHeader(agent, state.strong)
          else {
            try { if (childTiers.has(agent)) childTiers.set(agent, 'strong') } catch (e) {}
          }
        }
      } catch (e) {
        console.error('tier: error handler failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      diag.guardChecks = diag.guardChecks + 1
      const checkNo = diag.guardChecks
      try {
        const tier = effectiveExecutionTier(exec.agent)
        if (tier !== 'cheap') { diag.lastGuard = 'check' + checkNo + ': tier=' + tier + ' allow (' + agentIdentity(exec.agent) + ')'; return next() }
        const hit = isHighImpact(exec.name, exec.arguments)
        if (!hit) { diag.lastGuard = 'check' + checkNo + ': tier=cheap, not high-impact (' + agentIdentity(exec.agent) + ')'; return next() }
        diag.guardDenies = diag.guardDenies + 1
        diag.lastGuard = 'check' + checkNo + ': DENIED (' + agentIdentity(exec.agent) + ') ' + hit.slice(0, 60)
        return {
          kind: 'deny',
          reason: hit + ' — this high-impact action would execute on the cheap tier (' + tierLabel(state.cheap) + '). Escalate first: call tier_route with tier "strong" (or /tier strong), then re-issue the action.',
        }
      } catch (e) {
        diag.lastGuardError = 'check' + checkNo + ': ' + String(e && e.message || e)
        console.error('tier: guard failed: ' + String(e && e.message || e))
        return next()
      }
    })
  }

  if (tools) {
    const statusTool = defineTool({
      name: 'tier_status',
      description: 'Report the live routing state of the tiered model routing plugin: mode, tier configuration, subagent policy, escalation state, listener counters, the effective tier computed for the calling agent, and any last routing/guard diagnostics.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: value.status }] },
      },
      async execute(args, exec) {
        let effective = 'unknown'
        let identity = 'unknown'
        let escalated = false
        try {
          effective = effectiveExecutionTier(exec.agent)
          identity = agentIdentity(exec.agent)
          escalated = escalationActive(exec.agent)
        } catch (e) {
          effective = 'error: ' + String(e && e.message || e)
        }
        let headerNow = 'none'
        try { const c = headerConfigOf(exec.agent && exec.agent.session); headerNow = c ? c.provider + '/' + c.model + '/' + (c.reasoningEffort || 'default') : 'none' } catch (e) { headerNow = 'unreadable' }
        const lines = [
          statusText(exec.agent),
          '  calling agent: ' + identity + (escalated ? ' (ESCALATED to strong)' : ''),
          '  effective tier for calling agent: ' + effective,
          '  current session header: ' + headerNow,
        ]
        return { status: lines.join('\n') }
      },
    })
    tools.register(statusTool)

    const advisorTool = defineTool({
      name: 'tier_advisor',
      description: 'Consult the strong-tier advisor model (configured as ' + tierLabel(state.strong) + ') on one hard decision before committing to an approach. Use when requirements stay ambiguous after inspection, the work implicates architecture/security/data integrity/compatibility, several root causes remain, two evidence-based attempts failed, or a high-cost judgement is needed. Provide ONE decision question plus evidence already gathered. Returns guidance to apply; implementation stays on the current model.',
      parameters: {
        question: { type: 'string', required: true, description: 'One explicit decision question, e.g. "Can the proposed cache policy expose stale authorization data?"' },
        evidence: { type: 'string', description: 'Relevant facts already collected: file paths, call graphs, outputs, errors, constraints.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            advice: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const head = value.ok ? 'Advisor (' + value.provider + '/' + value.model + '):' : 'Advisor call failed (' + value.provider + '/' + value.model + '):'
          return [{ type: 'text', text: head + '\n' + value.advice }]
        },
      },
      async execute(args, exec) {
        const user = 'Decision question:\n' + args.question + (args.evidence ? '\n\nEvidence:\n' + args.evidence : '')
        const result = await streamText(state.strong, ADVISOR_SYSTEM, user, exec.signal)
        return { advice: result.text, ok: result.ok, tier: state.strong.label, provider: state.strong.provider, model: state.strong.model }
      },
    })
    tools.register(advisorTool)

    const reviewTool = defineTool({
      name: 'tier_review',
      description: 'Independent strong-tier review (configured as ' + tierLabel(state.strong) + ') before declaring a task complete or merging high-risk changes. Pass the exact change set, validation commands and results, and the review focus. Returns a verdict and issues ranked by severity.',
      parameters: {
        focus: { type: 'string', required: true, description: 'What is being reviewed: the change set, files, and the risk being checked.' },
        evidence: { type: 'string', description: 'Validation results, diffs, command outputs, acceptance criteria.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', required: true },
            review: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const head = value.ok ? 'Review (' + value.provider + '/' + value.model + '): ' + value.verdict : 'Review call failed (' + value.provider + '/' + value.model + '):'
          return [{ type: 'text', text: head + '\n' + value.review }]
        },
      },
      async execute(args, exec) {
        const user = 'Review focus:\n' + args.focus + (args.evidence ? '\n\nEvidence:\n' + args.evidence : '')
        const result = await streamText(state.strong, REVIEW_SYSTEM, user, exec.signal)
        let verdict = 'FAILED'
        if (result.ok) {
          const first = String(result.text).split('\n')[0] || ''
          const match = first.match(/APPROVE|NEEDS-CHANGES|BLOCKED/i)
          verdict = match ? match[0].toUpperCase() : 'UNPARSED'
        }
        return { verdict: verdict, review: result.text, ok: result.ok, tier: state.strong.label, provider: state.strong.provider, model: state.strong.model }
      },
    })
    tools.register(reviewTool)

    const routeTool = defineTool({
      name: 'tier_route',
      description: 'Set the routing mode for THIS session only (other sessions keep their own mode). strong = ' + tierLabel(state.strong) + ' for hard stretches (architecture, debugging, design); cheap = ' + tierLabel(state.cheap) + ' for routine implementation; auto = strong while plan mode is active and cheap while executing; off = disable per-step routing for this session and return it to its default model.',
      parameters: {
        tier: { type: 'string', required: true, enum: ['strong', 'cheap', 'auto', 'off'], description: 'Routing tier to apply.' },
        persist: { type: 'boolean', description: 'For strong or cheap, also persist the choice as the session default model selection. Default true.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            applied: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: 'Tier route (' + value.applied + '): ' + value.message }] },
      },
      async execute(args, exec) {
        return applyRoute(args.tier, args.persist !== false, exec.agent)
      },
    })
    tools.register(routeTool)

    const configureTool = defineTool({
      name: 'tier_configure',
      description: 'Configure which provider/model/effort backs each tier (strong and cheap) and the subagent policy. Any registered provider and model id work, e.g. deepseek-official/deepseek-v4-pro or other mounted routes. Changes apply immediately; pass persist: true to also save as the session default.',
      parameters: {
        tier: { type: 'string', required: true, enum: ['strong', 'cheap'], description: 'Which tier to configure.' },
        provider: { type: 'string', required: true, description: 'Registered provider route, e.g. "deepseek-official".' },
        model: { type: 'string', required: true, description: 'Model id for that provider, e.g. "deepseek-v4-pro" or "deepseek-v4-flash".' },
        reasoningEffort: { type: 'string', enum: ['off', 'high', 'max'], description: 'Reasoning effort for this tier. Default keeps the current value.' },
        subagentPolicy: { type: 'string', enum: ['inherit', 'cheap', 'strong'], description: 'Optional: how all subagent steps route (inherit = same rules as the main agent).' },
        persist: { type: 'boolean', description: 'Also save this tier as the session default model selection. Default false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: value.message }] },
      },
      async execute(args, exec) {
        return applyConfigure(args, exec.agent)
      },
    })
    tools.register(configureTool)

    const workerTool = defineTool({
      name: 'tier_worker',
      description: 'Delegate a bounded task packet to a fresh subagent that runs on a chosen tier: cheap (configured as ' + tierLabel(state.cheap) + ') for routine implementation, or strong (configured as ' + tierLabel(state.strong) + ') for hard analysis. Optional: outputSchema for a structured result, toolFilter to restrict the worker tools, maxDepth to cap delegation depth, persona to override the worker\'s system persona. Returns the worker\'s final output (or structured result) and stop reason.',
      parameters: {
        task: { type: 'string', required: true, description: 'Complete self-contained task packet for the worker: objective, in-scope/out-of-scope, constraints, expected return.' },
        tier: { type: 'string', enum: ['cheap', 'strong'], description: 'Tier the worker subagent runs on. Default cheap.' },
        provider: { type: 'string', description: 'Subagent provider name. Default: the first registered provider.' },
        outputSchema: { type: 'json', description: 'Optional object-rooted JSON Schema (supported subset) for a structured result; the worker returns a validated value.' },
        toolFilter: { type: 'json', description: 'Optional ToolRestriction object { allow?: string[], deny?: string[] } restricting which tools the worker may call.' },
        maxDepth: { type: 'integer', description: 'Optional absolute delegation-depth cap for the worker and its descendants.' },
        persona: { type: 'string', description: 'Optional per-child persona shadowing the deployment persona for this worker.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            output: { type: 'string', required: true },
            structured: { type: 'json' },
            stopReason: { type: 'string', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const head = 'Worker (' + value.tier + ' tier, ' + value.provider + '/' + value.model + ', ' + value.stopReason + '):'
          const body = value.structured !== undefined ? 'structured=' + JSON.stringify(value.structured).slice(0, 200) : value.output
          return [{ type: 'text', text: head + '\n' + body }]
        },
      },
      async execute(args, exec) {
        if (!subagents) throw new Error('tier_worker: subagents service is not mounted')
        const names = subagents.list()
        const providerName = args.provider || (names.length > 0 ? names[0] : null)
        if (!providerName) throw new Error('tier_worker: no subagent provider registered')
        const tierName = args.tier === 'strong' ? 'strong' : 'cheap'
        const tier = state[tierName]
        if (availableProviders().indexOf(tier.provider) === -1) {
          throw new Error('tier_worker: provider "' + tier.provider + '" is not registered. Registered: ' + availableProviders().join(', '))
        }
        const parent = exec.agent
        if (!parent) throw new Error('tier_worker: requires a calling agent')
        const request = {
          label: String(args.task).slice(0, 100),
          prompt: [{ type: 'text', text: String(args.task) }],
          parent: parent,
          agentOptions: { provider: tier.provider, model: tier.model },
          signal: exec.signal,
        }
        if (args.outputSchema && typeof args.outputSchema === 'object' && !Array.isArray(args.outputSchema)) request.outputSchema = args.outputSchema
        if (args.toolFilter && typeof args.toolFilter === 'object' && !Array.isArray(args.toolFilter)) request.toolFilter = args.toolFilter
        if (typeof args.maxDepth === 'number' && Number.isInteger(args.maxDepth) && args.maxDepth >= 0) request.maxDepth = args.maxDepth
        if (args.persona && typeof args.persona === 'string') request.persona = args.persona
        const run = await subagents.start(providerName, request)
        if (run && run.localAgent && run.localAgent !== parent) childTiers.set(run.localAgent, tierName)
        let result = null
        try {
          result = await run.result
        } finally {
          try { await run.dispose() } catch (e) {}
        }
        const out = []
        if (result && Array.isArray(result.output)) {
          for (const block of result.output) {
            if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text)
          }
        }
        const res = {
          output: out.join('\n').trim(),
          stopReason: result ? String(result.stopReason) : 'unknown',
          tier: tierName,
          provider: tier.provider,
          model: tier.model,
        }
        if (result && result.structured !== undefined) res.structured = result.structured
        return res
      },
    })
    tools.register(workerTool)
  }

  if (commands) {
    commands.register({
      name: 'advisor',
      description: 'Consult the strong-tier advisor on one hard question',
      input: { hint: 'one decision question, optionally followed by evidence' },
      handler: async (invocation) => {
        const q = String(invocation.rawInput || '').trim()
        if (!q) return { kind: 'success', text: statusText(invocation.agent) }
        try {
          const result = await streamText(state.strong, ADVISOR_SYSTEM, 'Decision question:\n' + q, invocation.signal)
          return { kind: 'success', text: 'Advisor (' + state.strong.provider + '/' + state.strong.model + '):\n' + result.text }
        } catch (e) {
          return { kind: 'error', text: 'advisor failed: ' + String(e && e.message || e) }
        }
      },
    })

    commands.register({
      name: 'tier',
      description: 'Control tiered model routing',
      input: { hint: 'status | strong | cheap | auto | off | plan | models | set <tier> <provider> <model> [effort] | subagent <inherit|cheap|strong> | review <focus>' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim()
        const parts = raw.split(/\s+/)
        const sub = (parts[0] || 'status').toLowerCase()
        const rest = parts.slice(1)
        const arg = rest.join(' ')
        try {
          if (sub === 'status') return { kind: 'success', text: statusText(invocation.agent) }
          if (sub === 'strong') { const r = await applyRoute('strong', true, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'cheap') { const r = await applyRoute('cheap', true, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'auto') { const r = await applyRoute('auto', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'off') { const r = await applyRoute('off', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'models') { return { kind: 'success', text: 'Registered providers and models:\n' + await listModelsText() } }
          if (sub === 'set') {
            const tier = rest[0]
            const provider = rest[1]
            const model = rest[2]
            const effort = rest[3]
            if (tier !== 'strong' && tier !== 'cheap') return { kind: 'error', text: 'usage: /tier set <strong|cheap> <provider> <model> [off|high|max]' }
            if (!provider || !model) return { kind: 'error', text: 'usage: /tier set <strong|cheap> <provider> <model> [off|high|max]' }
            const r = await applyConfigure({ tier: tier, provider: provider, model: model, reasoningEffort: effort, persist: false }, invocation.agent)
            return { kind: r.ok ? 'success' : 'error', text: r.message }
          }
          if (sub === 'subagent') {
            const policy = rest[0]
            if (['inherit', 'cheap', 'strong'].indexOf(policy) === -1) return { kind: 'error', text: 'usage: /tier subagent <inherit|cheap|strong>' }
            state.subagentPolicy = policy
            return { kind: 'success', text: 'Subagent policy set to "' + policy + '".' }
          }
          if (sub === 'plan') {
            state.mode = 'auto'
            let planText = ''
            if (planMode) {
              const outcome = planMode.set(invocation.agent, true)
              planText = ' Plan mode: ' + outcome + '.'
            } else {
              planText = ' Plan mode service is not mounted.'
            }
            ensureHeader(invocation.agent, state.strong)
            return { kind: 'success', text: 'Routing set to auto (strong plans, cheap executes). Strong header applied immediately.' + planText }
          }
          if (sub === 'review') {
            if (!arg) return { kind: 'error', text: 'usage: /tier review <focus to review>' }
            const result = await streamText(state.strong, REVIEW_SYSTEM, 'Review focus:\n' + arg, invocation.signal)
            return { kind: 'success', text: 'Review (' + state.strong.provider + '/' + state.strong.model + '):\n' + result.text }
          }
          return { kind: 'error', text: 'Unknown subcommand "' + sub + '". Use: status | strong | cheap | auto | off | plan | models | set | subagent | review' }
        } catch (e) {
          return { kind: 'error', text: 'tier command failed: ' + String(e && e.message || e) }
        }
      },
    })
  }

  if (systemPrompt) {
    systemPrompt.section({
      name: 'tier-routing',
      order: 120,
      text: function () {
        return [
          '## Tiered model routing',
          'This session uses tiered routing: strong = ' + tierLabel(state.strong) + '; cheap = ' + tierLabel(state.cheap) + '. Global routing default: ' + state.mode + ' (a per-session override may apply in this session); subagent policy: ' + state.subagentPolicy + '.',
          '- In auto mode, the session model follows plan state: plan mode runs on the strong tier, execution on the cheap tier (applied when a new message arrives or plan mode flips).',
          '- A deterministic guard denies high-impact tool calls (rm -rf, sudo, force push, credential/secret file edits, ...) while the cheap tier executes: call `tier_route` with tier "strong" first, then re-issue the action.',
          '- Repeated model-step errors automatically escalate the session to the strong tier for a few minutes (failure auto-escalation).',
          '- Delegate bounded implementation packets to `tier_worker` (cheap tier by default; use tier "strong" for hard analysis). You may pass outputSchema for structured results, toolFilter to restrict worker tools, and maxDepth to cap delegation depth.',
          '- Before committing to an approach, call `tier_advisor` when: requirements stay ambiguous after inspection; the work implicates architecture, security, authentication, data integrity, destructive migration, or compatibility and a decision is needed; several plausible root causes remain after the cheapest checks; two evidence-based attempts failed; or final validation exposes a high-cost unresolved risk. Provide ONE decision question plus the evidence already collected.',
          '- Call `tier_review` before declaring a high-risk task complete: pass the exact change set and validation results.',
          '- Use `tier_route` to switch tiers for a stretch of work; use `tier_configure` to change which provider/model backs each tier; use `tier_status` to inspect routing state.',
          '- Never claim a tier or model ran unless a tool result or step header identifies it.',
        ].join('\n')
      },
    })
  }

  console.log('tier: active — mode=' + state.mode + ' strong=' + tierLabel(state.strong) + ' cheap=' + tierLabel(state.cheap) + ' subagentPolicy=' + state.subagentPolicy + ' guard=on escalate=on')
}
