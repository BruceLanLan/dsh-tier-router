// dsh-tier-router — Tiered model routing for DeepSeek Harness.
//
// v0.5.0 (tier-router-plus): every tier carries an ordered fallback chain and
// reasoning effort is picked by task intensity — the strong tier follows the
// session model selection by default, the cheap tier starts at medium and can
// raise to high/max (bounded by the model's declared efforts).
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
// session request header; subagent children receive their tier directly at
// creation (tier_worker agentOptions), never by rewriting the model-selection
// waterfall. Tier configuration persists in the
// `tier-router` settings namespace; per-session routing modes are transient.

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { syncInstalledTieredPreset } from './preset-sync.js'
import {
  isHighImpact, resolveTierSpec,
  classifyFallback, validateReasoningEffort, migrateTierConfig,
  advanceFallback, fallbackActive, nextEffortStep, EFFORT_LADDER,
} from './pure.js'

export const name = 'tier-routing'

export const Config = z.object({
  hostPresetSync: z.boolean().default(false),
})

const fallbackEntrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

const tierSchema = z.object({
  mode: z.union(['auto', 'strong', 'cheap', 'delegated', 'off']).default('auto'),
  strongProvider: z.string().default('deepseek-official'),
  strongModel: z.string().default('deepseek-v4-pro'),
  strongEffort: z.string().default('max'),
  strongFollowSession: z.boolean().default(true),
  strongFallback: z.array(fallbackEntrySchema).default([]),
  cheapProvider: z.string().default('deepseek-official'),
  cheapModel: z.string().default('deepseek-v4-flash'),
  cheapEffort: z.string().default('medium'),
  cheapFollowSession: z.boolean().default(false),
  cheapFallback: z.array(fallbackEntrySchema).default([]),
  subagentPolicy: z.union(['inherit', 'cheap', 'strong']).default('inherit'),
})

export function apply(ctx, config = {}) {
  if (config.hostPresetSync === true) {
    try {
      const outcome = syncInstalledTieredPreset(fileURLToPath(new URL('../agent-presets/', import.meta.url)))
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info('tier: preset ' + outcome + ' in DSH discovery root')
    } catch (e) {
      const message = 'tier: preset sync failed: ' + String(e && e.message || e)
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message)
      else console.error(message)
    }
    return
  }
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
  const settings = ctx.get('settings')
  const jobs = ctx.get('jobs')
  if (jobs && typeof jobs.attachController === 'function') {
    // jobs.start refuses an owner no controller serves; attaching one from
    // the host-scoped context guarantees background tier_worker works even
    // when the composition loads dsh-tool-jobs only under agent scopes.
    try {
      jobs.attachController('tier-worker')
    } catch (e) {
      console.error('tier: jobs controller attach failed (background tier_worker may be refused): ' + String(e && e.message || e))
    }
  }

  const state = {
    strong: migrateTierConfig('strong', null),
    cheap: migrateTierConfig('cheap', null),
    mode: 'auto',
    subagentPolicy: 'inherit',
    escalateThreshold: 2,
    escalateWindowMs: 60000,
    escalateTtlMs: 180000,
    fallbackTtlMs: 300000,
    effortTtlMs: 300000,
  }
  const childTiers = new WeakMap()
  const sessionModes = new WeakMap()
  const sessionBaselines = new WeakMap()
  const escalations = new WeakMap()
  const fallbackStates = new WeakMap()
  const cheapEfforts = new WeakMap()
  const diag = { requestSteps: 0, guardChecks: 0, guardDenies: 0, headerWrites: 0, inboxSeen: 0, planFlips: 0, errorsSeen: 0, escalations: 0, fallbacks: 0, effortRaises: 0, lastRouting: '', lastGuard: '', lastGuardError: '', lastHeader: '', lastError: '', lastEscalation: '', lastFallback: '', lastEffort: '' }

  // ---- durable tier configuration (settings namespace) --------------------
  let settingsScope = null
  if (settings && typeof settings.register === 'function') {
    try {
      settingsScope = settings.register('tier-router', tierSchema)
      const saved = settingsScope.get()
      state.mode = ['auto', 'strong', 'cheap', 'delegated', 'off'].indexOf(saved.mode) !== -1 ? saved.mode : 'auto'
      state.strong = migrateTierConfig('strong', { followSession: saved.strongFollowSession, provider: saved.strongProvider, model: saved.strongModel, reasoningEffort: saved.strongEffort, fallback: saved.strongFallback })
      state.cheap = migrateTierConfig('cheap', { followSession: saved.cheapFollowSession, provider: saved.cheapProvider, model: saved.cheapModel, reasoningEffort: saved.cheapEffort, fallback: saved.cheapFallback })
      state.subagentPolicy = saved.subagentPolicy
      settingsScope.watch((next) => {
        try {
          state.mode = ['auto', 'strong', 'cheap', 'delegated', 'off'].indexOf(next.mode) !== -1 ? next.mode : 'auto'
          state.strong = migrateTierConfig('strong', { followSession: next.strongFollowSession, provider: next.strongProvider, model: next.strongModel, reasoningEffort: next.strongEffort, fallback: next.strongFallback })
          state.cheap = migrateTierConfig('cheap', { followSession: next.cheapFollowSession, provider: next.cheapProvider, model: next.cheapModel, reasoningEffort: next.cheapEffort, fallback: next.cheapFallback })
          state.subagentPolicy = next.subagentPolicy
        } catch (e) {
          console.error('tier: settings watch failed: ' + String(e && e.message || e))
        }
      })
    } catch (e) {
      console.error('tier: settings registration failed, config stays in-memory: ' + String(e && e.message || e))
    }
  }

  async function persistTierConfig() {
    if (!settingsScope) return ''
    try {
      await settingsScope.update({
        mode: state.mode,
        strongProvider: state.strong.provider,
        strongModel: state.strong.model,
        strongEffort: state.strong.reasoningEffort,
        strongFollowSession: state.strong.followSession,
        strongFallback: state.strong.fallback,
        cheapProvider: state.cheap.provider,
        cheapModel: state.cheap.model,
        cheapEffort: state.cheap.reasoningEffort,
        cheapFollowSession: state.cheap.followSession,
        cheapFallback: state.cheap.fallback,
        subagentPolicy: state.subagentPolicy,
      })
      return ' Saved to tier-router settings.'
    } catch (e) {
      console.error('tier: settings update failed: ' + String(e && e.message || e))
      return ' (settings persist failed: ' + String(e && e.message || e) + ')'
    }
  }

  // ---- registration isolation: a name conflict must not kill the plugin ---
  function safeRegister(label, fn) {
    try {
      fn()
      return true
    } catch (e) {
      console.error('tier: ' + label + ' registration failed (continuing without it): ' + String(e && e.message || e))
      return false
    }
  }

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

  function delegatedMain(agent) {
    return !!agent && !isChildAgent(agent) && effectiveMode(agent) === 'delegated'
  }

  function planActive(agent) {
    // Fold the session log the same way dsh-plan-mode does ("last plan/mode
    // event wins"), instead of reading the planMode service. The service lives
    // inside the preset's plan-mode isolate realm, which is not reachable from
    // this standing-scope row; the session log is the shared source of truth.
    try {
      const events = agent && agent.session && agent.session.events
      if (!events) return false
      let active = false
      for (const e of events) {
        if (e && e.type === 'plan/mode') active = !!(e.data && e.data.active)
      }
      return active
    } catch (e) { return false }
  }

  function setPlanMode(agent, active) {
    // Prefer the plan-mode service (pending-intent semantics + narration) when
    // it is reachable; otherwise append the identical log event so state folds
    // the same for everyone (the plan-mode plugin reads the log, not our call).
    if (planMode && agent) {
      try {
        const outcome = planMode.set(agent, active)
        if (outcome) return outcome
      } catch (e) {}
    }
    if (agent && agent.session && typeof agent.session.append === 'function') {
      try {
        agent.session.append('plan/mode', { active })
        return 'committed'
      } catch (e) {}
    }
    return 'unavailable'
  }

  function escalationActive(agent) {
    if (!agent || !escalations.has(agent)) return false
    const e = escalations.get(agent)
    if (e.until > Date.now()) return true
    // Only clean up records whose escalation already expired (until > 0).
    // A counting record (until === 0) must survive routing lookups between
    // errors, or consecutive failures would never reach the threshold.
    if (e.until > 0) escalations.delete(agent)
    return false
  }

  function tierNameFor(agent, planActiveOverride) {
    const spec = {
      explicitTier: agent && childTiers.has(agent) ? childTiers.get(agent) : undefined,
      sessionMode: agent ? sessionModes.get(agent) : undefined,
      escalated: escalationActive(agent),
      isChild: isChildAgent(agent),
      subagentPolicy: state.subagentPolicy,
      mode: state.mode,
      planActive: planActiveOverride === undefined ? planActive(agent) : planActiveOverride,
    }
    return resolveTierSpec(spec)
  }

  function resolveTarget(agent, planActiveOverride) {
    const tierName = tierNameFor(agent, planActiveOverride)
    return tierName ? effectiveTarget(agent, tierName) : null
  }

  function headerOf(session) {
    try { return session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined } catch (e) { return undefined }
  }

  function headerConfigOf(session) {
    const header = headerOf(session)
    return header ? header.config : undefined
  }

  function captureBaseline(agent) {
    if (!agent || sessionBaselines.has(agent)) return sessionBaselines.get(agent) || null
    let baseline = null
    try {
      const current = headerConfigOf(agent.session)
      if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
        baseline = { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort || 'high' }
      }
    } catch (e) {}
    if (!baseline) {
      try {
        const options = agent.options
        if (options && typeof options.provider === 'string' && typeof options.model === 'string') {
          baseline = { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort || 'high' }
        }
      } catch (e) {}
    }
    if (!baseline) baseline = defaultSelectionTarget()
    if (baseline) sessionBaselines.set(agent, baseline)
    return baseline
  }

  function ensureHeader(agent, target) {
    if (!agent || !target) return
    try {
      const session = agent.session
      if (!session || typeof session.append !== 'function' || typeof session.requestHeader !== 'function') return
      const currentHeader = headerOf(session)
      const cur = currentHeader && currentHeader.config
      if (cur && cur.provider === target.provider && cur.model === target.model && cur.reasoningEffort === target.reasoningEffort) return
      session.append('request/header', {
        header: { config: { ...(cur || {}), provider: target.provider, model: target.model, reasoningEffort: target.reasoningEffort } },
        reason: 'change',
      })
      diag.headerWrites = diag.headerWrites + 1
      diag.lastHeader = 'wrote ' + tierLabel(target) + ' for ' + agentIdentity(agent) + ' (was ' + (cur ? cur.provider + '/' + cur.model : 'none') + ')'
    } catch (e) {
      diag.lastHeader = 'header write failed: ' + String(e && e.message || e)
      console.error('tier: header write failed: ' + String(e && e.message || e))
    }
  }

  // `agent/inbox/inserted` runs before ReactLoopAgent builds the request. The
  // loop uses AgentOptions for its first/resumed request, so keep options and
  // the durable request header in sync instead of relying on a header alone.
  function applyTarget(agent, target) {
    if (!agent || !target) return
    captureBaseline(agent)
    try {
      if (agent.options && typeof agent.options === 'object') {
        agent.options.provider = target.provider
        agent.options.model = target.model
      }
    } catch (e) {
      console.error('tier: agent options update failed: ' + String(e && e.message || e))
    }
    ensureHeader(agent, target)
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

  function tierOf(tierName) { return tierName === 'strong' ? state.strong : state.cheap }

  function chainFor(agent, tierName) {
    const tier = tierOf(tierName)
    return (tier && Array.isArray(tier.fallback)) ? tier.fallback : []
  }

  function activeFallbackTarget(agent, tierName) {
    if (!agent || !fallbackStates.has(agent)) return null
    const rec = fallbackStates.get(agent)
    const now = Date.now()
    if (rec.tierName !== tierName || rec.index < 0 || rec.until <= now) {
      fallbackStates.delete(agent)
      return null
    }
    const chain = chainFor(agent, tierName)
    if (rec.index >= chain.length) {
      fallbackStates.delete(agent)
      return null
    }
    return chain[rec.index]
  }

  function triggerFallback(agent, tierName, failureText) {
    const chain = chainFor(agent, tierName)
    if (!Array.isArray(chain) || chain.length === 0) return { exhausted: true }
    let rec = fallbackStates.get(agent)
    const now = Date.now()
    if (!rec || rec.tierName !== tierName || rec.index < 0 || rec.until <= now) rec = { index: -1, until: 0 }
    const next = advanceFallback(rec, chain, now, state.fallbackTtlMs)
    if (!next) {
      fallbackStates.delete(agent)
      diag.lastFallback = '#' + (diag.fallbacks + 1) + ' chain exhausted for ' + agentIdentity(agent) + ' (' + tierName + '): ' + failureText
      return { exhausted: true }
    }
    fallbackStates.set(agent, { ...next, tierName: tierName })
    diag.fallbacks = diag.fallbacks + 1
    const target = chain[next.index]
    diag.lastFallback = '#' + diag.fallbacks + ' fallback ' + tierName + ' -> ' + target.provider + '/' + target.model + ' (TTL ' + Math.round(state.fallbackTtlMs / 1000) + 's, index ' + next.index + ') for ' + agentIdentity(agent) + ': ' + failureText
    return { target: target, index: next.index }
  }

  function clearRoutingTransients(agent) {
    if (!agent) return
    fallbackStates.delete(agent)
    cheapEfforts.delete(agent)
  }

  function cheapEffortState(agent) {
    if (!agent || !cheapEfforts.has(agent)) return null
    const rec = cheapEfforts.get(agent)
    if (rec.until !== 0 && rec.until <= Date.now()) {
      cheapEfforts.delete(agent)
      return null
    }
    return rec
  }

  function currentCheapEffort(agent) {
    const rec = cheapEffortState(agent)
    return rec ? rec.effort : state.cheap.reasoningEffort
  }

  async function declaredEfforts(provider, model) {
    try {
      if (llm && typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(provider, model)
        if (info && info.reasoning && Array.isArray(info.reasoning.efforts)) {
          return info.reasoning.efforts.map(function (e) { return e && e.id }).filter(function (x) { return typeof x === 'string' })
        }
      }
    } catch (e) {
    }
    return null
  }

  async function validateEffortFor(provider, model, effort) {
    const declared = await declaredEfforts(provider, model)
    if (declared === null) return { ok: true, available: [] }
    return validateReasoningEffort(effort, declared)
  }

  async function raiseCheapEffort(agent, reason) {
    if (!agent) return { raised: false, effort: null, message: 'no agent' }
    const current = currentCheapEffort(agent)
    const declared = await declaredEfforts(state.cheap.provider, state.cheap.model)
    const next = nextEffortStep(current, declared)
    if (!next) {
      const ceiling = declared && declared.length ? ' model ' + state.cheap.provider + '/' + state.cheap.model + ' declares only: ' + declared.join(', ') : ' already at max'
      diag.lastEffort = 'effort raise blocked: cheap effort stays ' + current + ' for ' + agentIdentity(agent) + ' (' + reason + ');' + ceiling
      return { raised: false, effort: current, message: 'Cheap tier effort stays ' + current + ';' + ceiling + '.' }
    }
    cheapEfforts.set(agent, { effort: next, until: Date.now() + state.effortTtlMs })
    diag.effortRaises = diag.effortRaises + 1
    diag.lastEffort = '#' + diag.effortRaises + ' cheap effort ' + current + ' -> ' + next + ' (' + reason + ') for ' + agentIdentity(agent)
    return { raised: true, effort: next, message: 'Cheap tier effort raised to ' + next + ' for this session (TTL ' + Math.round(state.effortTtlMs / 1000) + 's).' }
  }

  function strongStandaloneTarget() {
    if (state.strong.followSession) {
      const sel = defaultSelectionTarget()
      if (sel) return sel
    }
    return state.strong
  }

  function effectiveTarget(agent, tierName) {
    const tier = tierOf(tierName)
    const fallback = activeFallbackTarget(agent, tierName)
    if (fallback) return { tierName: tierName, provider: fallback.provider, model: fallback.model, reasoningEffort: fallback.reasoningEffort }
    if (tierName === 'strong') {
      if (tier.followSession) {
        const sel = defaultSelectionTarget()
        if (sel) return { tierName: tierName, provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || 'high' }
      }
      return { tierName: tierName, provider: tier.provider, model: tier.model, reasoningEffort: tier.reasoningEffort }
    }
    return { tierName: tierName, provider: tier.provider, model: tier.model, reasoningEffort: currentCheapEffort(agent) }
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
    if (effectiveMode(agent) === 'off' || delegatedMain(agent)) {
      try {
        const sel = agentDefaultModel && agentDefaultModel.currentSelection()
        if (sel && sel.provider === state.cheap.provider && sel.model === state.cheap.model) return 'cheap'
      } catch (e) {}
      return 'strong'
    }
    return tierNameFor(agent) === 'cheap' ? 'cheap' : 'strong'
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

  function chainText(tier) {
    const chain = tier && tier.fallback
    if (!Array.isArray(chain) || chain.length === 0) return '(none)'
    return chain.map(function (f) { return f.provider + '/' + f.model + '@' + f.reasoningEffort }).join(' -> ')
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
      '  mode: global=' + state.mode + ', this session=' + (agent ? (sessionModes.has(agent) ? sessionModes.get(agent) : state.mode) : 'n/a') + ' (per-session via /tier strong|cheap|auto|delegated|off; escalate: ' + state.escalateThreshold + ' errors / ' + Math.round(state.escalateWindowMs / 1000) + 's window -> ' + Math.round(state.escalateTtlMs / 1000) + 's strong)',
      '  strong: ' + tierLabel(state.strong) + (state.strong.followSession ? ' (follows session selection)' : '') + '; fallback: ' + chainText(state.strong),
      '  cheap:  ' + tierLabel(state.cheap) + '; fallback: ' + chainText(state.cheap),
      '  fallback TTL: ' + Math.round(state.fallbackTtlMs / 1000) + 's; effort TTL: ' + Math.round(state.effortTtlMs / 1000) + 's',
      '  config persisted: ' + (settingsScope ? 'yes (tier-router settings namespace)' : 'no (settings service unavailable, in-memory only)'),
      '  subagents: ' + state.subagentPolicy,
      '  subagent providers: ' + (subagents ? subagents.list().join(', ') : 'n/a') + '; background jobs: ' + (jobs ? 'available' : 'unavailable'),
      '  diag: requestSteps=' + diag.requestSteps + ' guardChecks=' + diag.guardChecks + ' guardDenies=' + diag.guardDenies + ' headerWrites=' + diag.headerWrites + ' inboxSeen=' + diag.inboxSeen + ' planFlips=' + diag.planFlips + ' errorsSeen=' + diag.errorsSeen + ' escalations=' + diag.escalations + ' fallbacks=' + diag.fallbacks + ' effortRaises=' + diag.effortRaises,
      diag.lastRouting ? '  lastRouting: ' + diag.lastRouting : '',
      diag.lastGuard ? '  lastGuard: ' + diag.lastGuard : '',
      diag.lastGuardError ? '  lastGuardError: ' + diag.lastGuardError : '',
      diag.lastHeader ? '  lastHeader: ' + diag.lastHeader : '',
      diag.lastError ? '  lastError: ' + diag.lastError : '',
      diag.lastEscalation ? '  lastEscalation: ' + diag.lastEscalation : '',
      diag.lastFallback ? '  lastFallback: ' + diag.lastFallback : '',
      diag.lastEffort ? '  lastEffort: ' + diag.lastEffort : '',
      sessionDefault ? '  ' + sessionDefault : '  session default: unavailable',
      '  providers: ' + availableProviders().join(', '),
    ].join('\n')
  }

  async function applyRoute(tier, persist, agent) {
    if (tier === 'auto') {
      if (agent) sessionModes.set(agent, 'auto')
      clearRoutingTransients(agent)
      if (agent && !isChildAgent(agent)) applyTarget(agent, effectiveTarget(agent, planActive(agent) ? 'strong' : 'cheap'))
      return { applied: tier, message: 'Routing mode set to auto for THIS session (plan mode -> strong tier, execution -> cheap tier). Other sessions keep their own mode.' }
    }
    if (tier === 'delegated') {
      if (agent) sessionModes.set(agent, 'delegated')
      clearRoutingTransients(agent)
      if (agent && !isChildAgent(agent)) {
        const selected = captureBaseline(agent) || defaultSelectionTarget()
        if (selected) applyTarget(agent, selected)
      }
      return { applied: tier, message: 'This session keeps its main agent on the session-selected model; only subagents are tier-routed.' }
    }
    if (tier === 'off') {
      if (agent) sessionModes.set(agent, 'off')
      clearRoutingTransients(agent)
      if (agent && !isChildAgent(agent)) {
        const def = captureBaseline(agent) || defaultSelectionTarget()
        if (def) applyTarget(agent, def)
      }
      return { applied: tier, message: 'Routing disabled for THIS session; its model returned to the default. Other sessions are unaffected; only explicit commands and tools act here (the high-impact guard still applies while this session\'s default stays the cheap tier).' }
    }
    const target = state[tier]
    if (!target) return { applied: tier, message: 'Unknown tier "' + tier + '". Use strong, cheap, auto, delegated, or off.' }
    if (availableProviders().indexOf(target.provider) === -1) {
      return { applied: tier, message: 'Provider "' + target.provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    if (agent) sessionModes.set(agent, tier)
    clearRoutingTransients(agent)
    if (agent && !isChildAgent(agent)) applyTarget(agent, effectiveTarget(agent, tier))
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
    const current = state[tierName]
    if (args.followSession === true && tierName !== 'strong') {
      return { ok: false, message: 'follow-session is only supported for the strong tier.' }
    }
    const provider = args.provider || current.provider
    const model = args.model || current.model
    if (availableProviders().indexOf(provider) === -1) {
      return { ok: false, message: 'Provider "' + provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    const effort = args.reasoningEffort || current.reasoningEffort
    if (args.reasoningEffort) {
      const check = await validateEffortFor(provider, model, args.reasoningEffort)
      if (!check.ok) {
        return { ok: false, message: 'Rejected effort "' + args.reasoningEffort + '" for ' + provider + '/' + model + ': the model declares only ' + check.available.join(', ') + '.' }
      }
    }
    const next = migrateTierConfig(tierName, {
      followSession: typeof args.followSession === 'boolean' ? args.followSession : current.followSession,
      provider: provider,
      model: model,
      reasoningEffort: effort,
      fallback: Array.isArray(args.fallback) ? args.fallback : current.fallback,
    })
    for (const fb of next.fallback) {
      const check = await validateEffortFor(fb.provider, fb.model, fb.reasoningEffort)
      if (!check.ok) {
        return { ok: false, message: 'Rejected fallback entry ' + fb.provider + '/' + fb.model + ' with effort "' + fb.reasoningEffort + '": the model declares only ' + check.available.join(', ') + '.' }
      }
    }
    state[tierName] = next
    if (args.subagentPolicy && ['inherit', 'cheap', 'strong'].indexOf(args.subagentPolicy) !== -1) state.subagentPolicy = args.subagentPolicy
    if (agent && !isChildAgent(agent) && (effectiveMode(agent) === tierName || effectiveMode(agent) === 'auto')) applyTarget(agent, effectiveTarget(agent, tierName))
    let persisted = ''
    if (args.sessionOnly !== true) persisted = await persistTierConfig()
    if (args.persist && agentDefaultModel) {
      try {
        await agentDefaultModel.saveSelection({ provider: provider, model: model, reasoningEffort: effort })
        persisted += ' Saved as the session default.'
      } catch (e) {
        persisted += ' Could not persist the session default: ' + String(e && e.message || e)
      }
    }
    return { ok: true, message: 'Configured ' + tierName + ' tier: ' + tierLabel(state[tierName]) + (state[tierName].followSession ? ' (follows session selection)' : '') + '; fallback: ' + chainText(state[tierName]) + '. Subagent policy: ' + state.subagentPolicy + '.' + persisted }
  }

  function parseSetArgs(tokens) {
    const out = {}
    let i = 0
    while (i < tokens.length) {
      const tok = tokens[i]
      if (tok === '--fallback') {
        const p = tokens[i + 1]
        const m = tokens[i + 2]
        const e = tokens[i + 3]
        if (!p || !m || !e) throw new Error('usage: --fallback <provider> <model> <effort>')
        if (!out.fallback) out.fallback = []
        out.fallback.push({ provider: p, model: m, reasoningEffort: e })
        i = i + 4
      } else if (tok === 'follow-session' || tok === '--follow-session') {
        out.followSession = true
        i = i + 1
      } else if (out.provider === undefined) {
        out.provider = tok
        i = i + 1
      } else if (out.model === undefined) {
        out.model = tok
        i = i + 1
      } else if (out.effort === undefined) {
        out.effort = tok
        i = i + 1
      } else {
        throw new Error('unexpected argument "' + tok + '" (expected --fallback <provider> <model> <effort> or follow-session)')
      }
    }
    return out
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/inbox/inserted', (payload) => {
      diag.inboxSeen = diag.inboxSeen + 1
      try {
        const agent = payload && payload.agent
        const message = payload && payload.message
        if (!agent || !message) return
        if (effectiveMode(agent) === 'off') return
        try { if (!message.source || message.source.kind !== 'user') return } catch (e) {}
        captureBaseline(agent)
        if (delegatedMain(agent)) {
          const selected = captureBaseline(agent) || defaultSelectionTarget()
          if (selected) applyTarget(agent, selected)
          return
        }
        // Children created by ordinary subagent tools inherit their parent
        // options. Update their options before the first loop request so the
        // configured policy is real routing, not merely guard classification.
        const target = resolveTarget(agent)
        if (target) applyTarget(agent, target)
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
        if (delegatedMain(agent)) {
          const selected = captureBaseline(agent) || defaultSelectionTarget()
          if (selected) applyTarget(agent, selected)
          return
        }
        // Use the event's own active flag (the session log may not include
        // this event yet) and let resolveTierSpec honor an explicit
        // per-session mode: a session locked to cheap/strong must NOT follow
        // plan-state flips.
        const target = resolveTarget(agent, active)
        if (target) applyTarget(agent, target)
      } catch (e) {
        console.error('tier: plan-flip routing failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('agent/error', async (payload) => {
      diag.errorsSeen = diag.errorsSeen + 1
      try {
        const agent = payload && payload.agent
        if (!agent) return
        const failure = payload && payload.error
        const failureText = String(failure && (failure.message || failure.code) || failure || 'unknown').slice(0, 140)
        diag.lastError = '#' + diag.errorsSeen + ' ' + agentIdentity(agent) + ': ' + failureText
        if (effectiveMode(agent) === 'off' || delegatedMain(agent)) return
        const failedTier = tierNameFor(agent)
        const now = Date.now()
        let rec = escalations.get(agent)
        if (!rec || now - rec.windowStart > state.escalateWindowMs) {
          rec = { count: 0, windowStart: now, until: 0 }
          escalations.set(agent, rec)
        }
        rec.count = rec.count + 1
        const escalatedNow = rec.count >= state.escalateThreshold && rec.until < now
        if (escalatedNow) {
          rec.until = now + state.escalateTtlMs
          diag.escalations = diag.escalations + 1
          diag.lastEscalation = '#' + diag.escalations + ' escalated ' + agentIdentity(agent) + ' for ' + Math.round(state.escalateTtlMs / 1000) + 's after ' + rec.count + ' errors'
          applyTarget(agent, effectiveTarget(agent, 'strong'))
        }
        const cls = classifyFallback(failure)
        if (cls !== 'ignore' && !escalatedNow && failedTier === 'cheap') {
          await raiseCheapEffort(agent, 'error retry (' + failureText.slice(0, 60) + ')')
        }
      } catch (e) {
        console.error('tier: error handler failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('agent/request-error', async (payload, next) => {
      try {
        const agent = payload && payload.agent
        const failure = payload && payload.failure
        if (!agent || effectiveMode(agent) === 'off' || delegatedMain(agent)) return next()
        if (classifyFallback(failure) !== 'fallback') return next()
        const tierName = tierNameFor(agent)
        if (!tierName) return next()
        const failureText = String(failure && (failure.message || failure.code) || 'unknown').slice(0, 140)
        const outcome = triggerFallback(agent, tierName, failureText)
        if (!outcome || !outcome.target) return next()
        applyTarget(agent, outcome.target)
        return { kind: 'retry' }
      } catch (e) {
        console.error('tier: request-error recovery failed: ' + String(e && e.message || e))
        return next()
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
        const raised = await raiseCheapEffort(exec.agent, 'high-impact guard deny')
        return {
          kind: 'deny',
          reason: hit + ' — this high-impact action would execute on the cheap tier (' + tierLabel(state.cheap) + '). Escalate first: call tier_route with tier "strong" (or /tier strong), then re-issue the action.' + (raised.raised ? ' Cheap tier effort raised to ' + raised.effort + '.' : ''),
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
      description: 'Report the live routing state of the tiered model routing plugin: mode, tier configuration, persistence state, escalation state, listener counters, the effective tier computed for the calling agent, and any last routing/guard diagnostics.',
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
          const guardTier = effectiveExecutionTier(exec.agent)
          effective = delegatedMain(exec.agent) ? 'session-default (delegated main; guard class ' + guardTier + ')' : guardTier
          identity = agentIdentity(exec.agent)
          escalated = escalationActive(exec.agent)
        } catch (e) {
          effective = 'error: ' + String(e && e.message || e)
        }
        let headerNow = 'none'
        try { const c = headerConfigOf(exec.agent && exec.agent.session); headerNow = c ? c.provider + '/' + c.model + '/' + (c.reasoningEffort || 'default') : 'none' } catch (e) { headerNow = 'unreadable' }
        let fallbackLine = '  fallback state: main model (no fallback active)'
        let effortLine = '  cheap effort: ' + currentCheapEffort(exec.agent)
        try {
          if (exec.agent && fallbackStates.has(exec.agent)) {
            const rec = fallbackStates.get(exec.agent)
            if (fallbackActive(rec, Date.now())) {
              const tname = rec.tierName
              const chain = tname ? chainFor(exec.agent, tname) : []
              fallbackLine = '  fallback state: tier=' + (tname || '?') + ' index=' + rec.index + '/' + chain.length + ' until=' + new Date(rec.until).toISOString() + ' (target ' + (chain[rec.index] ? chain[rec.index].provider + '/' + chain[rec.index].model : '?') + ')'
            }
          }
        } catch (e) {}
        const lines = [
          statusText(exec.agent),
          '  calling agent: ' + identity + (escalated ? ' (ESCALATED to strong)' : ''),
          '  effective tier for calling agent: ' + effective,
          fallbackLine,
          effortLine,
          '  current session header: ' + headerNow,
        ]
        return { status: lines.join('\n') }
      },
    })
    safeRegister('tier_status tool', () => tools.register(statusTool))

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
        const target = strongStandaloneTarget()
        const user = 'Decision question:\n' + args.question + (args.evidence ? '\n\nEvidence:\n' + args.evidence : '')
        const result = await streamText(target, ADVISOR_SYSTEM, user, exec.signal)
        return { advice: result.text, ok: result.ok, tier: state.strong.label, provider: target.provider, model: target.model }
      },
    })
    safeRegister('tier_advisor tool', () => tools.register(advisorTool))

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
        const target = strongStandaloneTarget()
        const user = 'Review focus:\n' + args.focus + (args.evidence ? '\n\nEvidence:\n' + args.evidence : '')
        const result = await streamText(target, REVIEW_SYSTEM, user, exec.signal)
        let verdict = 'FAILED'
        if (result.ok) {
          const first = String(result.text).split('\n')[0] || ''
          const match = first.match(/APPROVE|NEEDS-CHANGES|BLOCKED/i)
          verdict = match ? match[0].toUpperCase() : 'UNPARSED'
        }
        return { verdict: verdict, review: result.text, ok: result.ok, tier: state.strong.label, provider: target.provider, model: target.model }
      },
    })
    safeRegister('tier_review tool', () => tools.register(reviewTool))

    const routeTool = defineTool({
      name: 'tier_route',
      description: 'Set the routing mode for THIS session only (other sessions keep their own mode). strong = ' + tierLabel(state.strong) + ' for hard stretches (architecture, debugging, design); cheap = ' + tierLabel(state.cheap) + ' for routine implementation; auto = strong while plan mode is active and cheap while executing; delegated = keep the main agent on the session-selected model and route only subagents; off = disable per-step routing for this session and return it to its default model.',
      parameters: {
        tier: { type: 'string', required: true, enum: ['strong', 'cheap', 'auto', 'delegated', 'off'], description: 'Routing tier or delegated-only mode to apply to this session.' },
        persist: { type: 'boolean', description: 'Also persist the choice as the session default model selection. Default false.' },
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
        return applyRoute(args.tier, args.persist === true, exec.agent)
      },
    })
    safeRegister('tier_route tool', () => tools.register(routeTool))

    const configureTool = defineTool({
      name: 'tier_configure',
      description: 'Configure which provider/model/effort backs each tier (strong and cheap), optional followSession mode and fallback chains, and the subagent policy. Any registered provider and model id work. Efforts are validated against the target model\'s declared reasoning efforts when metadata is available (e.g. deepseek models declare off/high/max). The configuration persists in the tier-router settings namespace (pass sessionOnly: true for a transient change); persist: true also writes the session default model.',
      parameters: {
        tier: { type: 'string', required: true, enum: ['strong', 'cheap'], description: 'Which tier to configure.' },
        provider: { type: 'string', description: 'Registered provider route, e.g. "deepseek-official". Default keeps the current value.' },
        model: { type: 'string', description: 'Model id for that provider, e.g. "deepseek-v4-flash". Default keeps the current value.' },
        reasoningEffort: { type: 'string', description: 'Reasoning effort for this tier (any string; validated against the model\'s declared efforts). Default keeps the current value.' },
        followSession: { type: 'boolean', description: 'Strong tier only: when true the primary model follows the session model selection; the explicit provider/model/effort remain as the fallback base.' },
        fallback: { type: 'json', description: 'Optional ordered fallback chain: [{ provider, model, reasoningEffort }]. Default keeps the current chain.' },
        subagentPolicy: { type: 'string', enum: ['inherit', 'cheap', 'strong'], description: 'Optional: how all subagent steps route (inherit = same rules as the main agent).' },
        sessionOnly: { type: 'boolean', description: 'Keep the change in-memory only (default false = persist to settings).' },
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
    safeRegister('tier_configure tool', () => tools.register(configureTool))

    const escalateEffortTool = defineTool({
      name: 'tier_escalate_effort',
      description: 'Raise the cheap-tier reasoning effort one step for the calling agent (medium -> high -> max, bounded by what the cheap model actually declares). Call when the current task is harder than the cheap tier baseline: more reasoning effort may avoid further failed attempts.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            effort: { type: 'string' },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: value.message }] },
      },
      async execute(args, exec) {
        const r = await raiseCheapEffort(exec.agent, 'tier_escalate_effort tool')
        return { ok: r.raised, effort: r.effort || undefined, message: r.message }
      },
    })
    safeRegister('tier_escalate_effort tool', () => tools.register(escalateEffortTool))

    const workerTool = defineTool({
      name: 'tier_worker',
      description: 'Delegate a bounded task packet to a fresh subagent that runs on a chosen tier: cheap (configured as ' + tierLabel(state.cheap) + ') for routine implementation, or strong (configured as ' + tierLabel(state.strong) + ') for hard analysis. Optional: outputSchema for a structured result, toolFilter to restrict the worker tools, maxDepth to cap delegation depth, persona to override the worker\'s system persona, background to run via the jobs service. Returns the worker\'s final output (or structured result) and stop reason.',
      parameters: {
        task: { type: 'string', required: true, description: 'Complete self-contained task packet for the worker: objective, in-scope/out-of-scope, constraints, expected return.' },
        tier: { type: 'string', enum: ['cheap', 'strong'], description: 'Tier the worker subagent runs on. Default cheap.' },
        provider: { type: 'string', description: 'Subagent provider name. Default: the first registered provider.' },
        outputSchema: { type: 'json', description: 'Optional object-rooted JSON Schema (supported subset) for a structured result; the worker returns a validated value.' },
        toolFilter: { type: 'json', description: 'Optional ToolRestriction object { allow?: string[], deny?: string[] } restricting which tools the worker may call.' },
        maxDepth: { type: 'integer', description: 'Optional absolute delegation-depth cap for the worker and its descendants.' },
        persona: { type: 'string', description: 'Optional per-child persona shadowing the deployment persona for this worker.' },
        background: { type: 'boolean', description: 'Run the worker as a background job instead of blocking. Requires the jobs service.' },
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
            background: { type: 'boolean' },
            jobId: { type: 'string' },
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
          // Supply the complete route when the child is created instead of
          // rewriting DSH's agent/request waterfall. DSH rc.6's model-selection
          // listener destructures the downstream result without guarding an
          // undefined value, so an extra standing-scope waterfall listener can
          // make an otherwise valid request fail before it reaches the adapter.
          agentOptions: {
            provider: tier.provider,
            model: tier.model,
            reasoningEffort: tier.reasoningEffort,
          },
          signal: exec.signal,
        }
        if (args.outputSchema && typeof args.outputSchema === 'object' && !Array.isArray(args.outputSchema)) request.outputSchema = args.outputSchema
        if (args.toolFilter && typeof args.toolFilter === 'object' && !Array.isArray(args.toolFilter)) request.toolFilter = args.toolFilter
        if (typeof args.maxDepth === 'number' && Number.isInteger(args.maxDepth) && args.maxDepth >= 0) request.maxDepth = args.maxDepth
        if (args.persona && typeof args.persona === 'string') request.persona = args.persona

        const settleRun = async (run) => {
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
        }

        if (args.background === true && jobs) {
          const controller = new AbortController()
          const jobId = jobs.start({
            kind: 'subagent',
            label: String(args.task).slice(0, 100),
            owner: parent,
            run: () => ({
              cancel: (reason) => {
                controller.abort(reason ?? 'tier_worker background job killed')
              },
              // The jobs contract: done resolves to a JobOutcome —
              // { status: 'completed'|'killed'|'failed', detail?, output? } —
              // and must not reject.
              done: (async () => {
                try {
                  const run = await subagents.start(providerName, { ...request, signal: controller.signal })
                  const res = await settleRun(run)
                  return {
                    status: 'completed',
                    detail: 'tier=' + res.tier + ' model=' + res.provider + '/' + res.model + ' stopReason=' + res.stopReason,
                    output: res.structured !== undefined ? 'structured=' + JSON.stringify(res.structured) : res.output,
                  }
                } catch (e) {
                  return {
                    status: controller.signal.aborted ? 'killed' : 'failed',
                    detail: String(e && e.message || e),
                  }
                }
              })(),
            }),
          })
          return {
            output: 'started background worker',
            stopReason: 'background',
            tier: tierName,
            provider: tier.provider,
            model: tier.model,
            background: true,
            jobId: String(jobId),
          }
        }
        if (args.background === true && !jobs) {
          throw new Error('tier_worker: background mode requested but the jobs service is not mounted')
        }

        const run = await subagents.start(providerName, request)
        return settleRun(run)
      },
    })
    safeRegister('tier_worker tool', () => tools.register(workerTool))
  }

  if (commands) {
    safeRegister('/advisor command', () => commands.register({
      name: 'advisor',
      description: 'Consult the strong-tier advisor on one hard question',
      input: { hint: 'one decision question, optionally followed by evidence' },
      handler: async (invocation) => {
        const q = String(invocation.rawInput || '').trim()
        if (!q) return { kind: 'success', text: statusText(invocation.agent) }
        try {
          const target = strongStandaloneTarget()
          const result = await streamText(target, ADVISOR_SYSTEM, 'Decision question:\n' + q, invocation.signal)
          return { kind: 'success', text: 'Advisor (' + target.provider + '/' + target.model + '):\n' + result.text }
        } catch (e) {
          return { kind: 'error', text: 'advisor failed: ' + String(e && e.message || e) }
        }
      },
    }))

    safeRegister('/tier command', () => commands.register({
      name: 'tier',
      description: 'Control tiered model routing',
      input: { hint: 'status | strong | cheap | auto | delegated | off | plan | models | set <tier> <provider> <model> [effort] [--fallback <p> <m> <e> ...] | set strong follow-session | effort <medium|high|max> | subagent <inherit|cheap|strong> | review <focus>' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim()
        const parts = raw.split(/\s+/)
        const sub = (parts[0] || 'status').toLowerCase()
        const rest = parts.slice(1)
        const arg = rest.join(' ')
        try {
          if (sub === 'status') return { kind: 'success', text: statusText(invocation.agent) }
          if (sub === 'strong') { const r = await applyRoute('strong', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'cheap') { const r = await applyRoute('cheap', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'auto') { const r = await applyRoute('auto', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'delegated') { const r = await applyRoute('delegated', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'off') { const r = await applyRoute('off', false, invocation.agent); return { kind: 'success', text: r.message } }
          if (sub === 'models') { return { kind: 'success', text: 'Registered providers and models:\n' + await listModelsText() } }
          if (sub === 'set') {
            const tier = rest[0]
            if (tier !== 'strong' && tier !== 'cheap') return { kind: 'error', text: 'usage: /tier set <strong|cheap> <provider> <model> [effort] [--fallback <p> <m> <e> ...] | /tier set strong follow-session' }
            let parsed
            try {
              parsed = parseSetArgs(rest.slice(1))
            } catch (e) {
              return { kind: 'error', text: String(e && e.message || e) }
            }
            if (parsed.followSession && parsed.provider) {
              return { kind: 'error', text: 'follow-session cannot be combined with a provider/model; use /tier set strong follow-session' }
            }
            if (!parsed.followSession && (!parsed.provider || !parsed.model)) {
              return { kind: 'error', text: 'usage: /tier set <strong|cheap> <provider> <model> [effort] [--fallback <p> <m> <e> ...] | /tier set strong follow-session' }
            }
            const r = await applyConfigure({ tier: tier, provider: parsed.provider, model: parsed.model, reasoningEffort: parsed.effort, followSession: parsed.followSession, fallback: parsed.fallback, sessionOnly: false, persist: false }, invocation.agent)
            return { kind: r.ok ? 'success' : 'error', text: r.message }
          }
          if (sub === 'effort') {
            const effort = rest[0]
            if (EFFORT_LADDER.indexOf(effort) === -1) return { kind: 'error', text: 'usage: /tier effort <medium|high|max>' }
            const check = await validateEffortFor(state.cheap.provider, state.cheap.model, effort)
            if (!check.ok) return { kind: 'error', text: 'Rejected effort "' + effort + '" for ' + state.cheap.provider + '/' + state.cheap.model + ': the model declares only ' + check.available.join(', ') + '.' }
            cheapEfforts.set(invocation.agent, { effort: effort, until: 0 })
            diag.lastEffort = 'manual cheap effort set to ' + effort + ' for ' + agentIdentity(invocation.agent)
            return { kind: 'success', text: 'Cheap tier effort set to "' + effort + '" for this session (applies while the cheap tier executes).' }
          }
          if (sub === 'subagent') {
            const policy = rest[0]
            if (['inherit', 'cheap', 'strong'].indexOf(policy) === -1) return { kind: 'error', text: 'usage: /tier subagent <inherit|cheap|strong>' }
            state.subagentPolicy = policy
            const saved = await persistTierConfig()
            return { kind: 'success', text: 'Subagent policy set to "' + policy + '".' + saved }
          }
          if (sub === 'plan') {
            sessionModes.set(invocation.agent, 'auto')
            clearRoutingTransients(invocation.agent)
            const outcome = setPlanMode(invocation.agent, true)
            applyTarget(invocation.agent, effectiveTarget(invocation.agent, 'strong'))
            return { kind: 'success', text: 'Routing set to auto (strong plans, cheap executes). Strong header applied immediately. Plan mode: ' + outcome + '.' }
          }
          if (sub === 'review') {
            if (!arg) return { kind: 'error', text: 'usage: /tier review <focus to review>' }
            const target = strongStandaloneTarget()
            const result = await streamText(target, REVIEW_SYSTEM, 'Review focus:\n' + arg, invocation.signal)
            return { kind: 'success', text: 'Review (' + target.provider + '/' + target.model + '):\n' + result.text }
          }
          return { kind: 'error', text: 'Unknown subcommand "' + sub + '". Use: status | strong | cheap | auto | delegated | off | plan | models | set | effort | subagent | review' }
        } catch (e) {
          return { kind: 'error', text: 'tier command failed: ' + String(e && e.message || e) }
        }
      },
    }))
  }

  if (systemPrompt) {
    safeRegister('prompt section', () => systemPrompt.section({
      name: 'tier-routing',
      order: 120,
      text: function () {
        return [
          '## Tiered model routing',
          'This session uses tiered routing: strong = ' + tierLabel(state.strong) + (state.strong.followSession ? ' (follows your session model selection)' : '') + '; cheap = ' + tierLabel(state.cheap) + '. Fallback chains: strong -> ' + chainText(state.strong) + '; cheap -> ' + chainText(state.cheap) + '. Global routing default: ' + state.mode + ' (a per-session override may apply in this session); subagent policy: ' + state.subagentPolicy + '.',
          '- In auto mode, the session model follows plan state: plan mode runs on the strong tier, execution on the cheap tier (applied when a new message arrives or plan mode flips). In delegated mode, the main agent stays on the session-selected model and only subagents are tier-routed.',
          '- A deterministic guard denies high-impact tool calls (rm -rf, sudo, force push, credential/secret file edits, ...) while the cheap tier executes: call `tier_route` with tier "strong" first, then re-issue the action.',
          '- Repeated model-step errors automatically escalate the session to the strong tier for a few minutes (failure auto-escalation; inactive in off mode).',
          '- Each tier has a fallback chain: if the primary model is unavailable (quota, rate limit, unknown model, credential or 5xx errors), the next chain entry runs the same task, then the tier returns to its primary after ' + Math.round(state.fallbackTtlMs / 1000) + 's. The cheap tier starts at medium reasoning effort and raises itself (to high/max, bounded by what the model declares) when a task proves hard; you may call "tier_escalate_effort" or /tier effort <medium|high|max> to set it explicitly.',
          '- Delegate bounded implementation packets to `tier_worker` (cheap tier by default; use tier "strong" for hard analysis). You may pass outputSchema for structured results, toolFilter to restrict worker tools, maxDepth to cap delegation depth, persona to override the worker persona, and background to run via the jobs service.',
          '- Before committing to an approach, call `tier_advisor` when: requirements stay ambiguous after inspection; the work implicates architecture, security, authentication, data integrity, destructive migration, or compatibility and a decision is needed; several plausible root causes remain after the cheapest checks; two evidence-based attempts failed; or final validation exposes a high-cost unresolved risk. Provide ONE decision question plus the evidence already collected.',
          '- Call `tier_review` before declaring a high-risk task complete: pass the exact change set and validation results.',
          '- Use `tier_route` to switch tiers for a stretch of work; use `tier_configure` to change which provider/model backs each tier; use `tier_status` to inspect routing state.',
          '- Never claim a tier or model ran unless a tool result or step header identifies it.',
        ].join('\n')
      },
    }))
  }

  console.log('tier: active — mode=' + state.mode + ' strong=' + tierLabel(state.strong) + (state.strong.followSession ? ' (followSession)' : '') + ' cheap=' + tierLabel(state.cheap) + ' fallbackTtl=' + Math.round(state.fallbackTtlMs / 1000) + 's subagentPolicy=' + state.subagentPolicy + ' guard=on escalate=on persist=' + (settingsScope ? 'settings' : 'memory'))
}
