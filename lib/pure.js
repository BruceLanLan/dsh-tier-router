// Dependency-free pure logic for dsh-tier-router.
//
// These functions contain no harness imports and no I/O, so they are
// unit-testable with plain `node --test` (see tests/pure.test.mjs). Keep the
// in-session dynamic plugin's inline copies in sync with this file.

/**
 * Command runners that can prefix `rm` and still execute it. Two groups:
 * `ARG_RUNNERS` legitimately carry their own arguments before the command
 * (`env -i rm -rf`, `timeout 5 rm -rf`, `xargs -0 rm -rf`), so they allow
 * any arguments before `rm`; `DIRECT_RUNNERS` take the command immediately
 * (`nohup rm -rf`), so allowing arguments there would false-positive on
 * harmless forms like `nohup echo rm -rf`.
 */
const ARG_RUNNERS = 'sudo|env|timeout|nice|xargs|doas|setarch|stdbuf|ionice'
const DIRECT_RUNNERS = 'command|exec|busybox|nohup|pkexec'

/**
 * Detect `rm` with BOTH recursive (`-r`/`-R`/`--recursive`) and force (`-f`/
 * `--force`) flags, allowing split flags like `rm -r -f` that a single-token
 * regex misses. Anchored to command position so prose like "echo rm -rf"
 * does not match. Runner arguments (`env -i rm -rf`) and a backslash escape
 * (`\rm -rf`) still execute rm.
 */
export function hasRecursiveForceRm(cmd) {
  if (typeof cmd !== 'string') return false
  // rm at command position: start of string, after a separator, or after a
  // known command runner (with optional runner arguments where the runner
  // can carry them).
  const sep = cmd.match(new RegExp(
    '(^|[;&|]\\s*' +
    '|\\b(' + ARG_RUNNERS + ')\\s+(?:\\S+\\s+)*' +
    '|\\b(' + DIRECT_RUNNERS + ')\\s+' +
    ')\\\\?rm(\\s+)',
    'i'
  ))
  if (!sep) return false
  const rest = cmd.slice(sep.index + sep[0].length)
  let flags = ''
  for (const token of rest.split(/\s+/)) {
    if (/^--?[a-zA-Z]/.test(token)) flags += token.replace(/^-+/, '')
    else break
  }
  flags = flags.toLowerCase()
  return flags.includes('r') && flags.includes('f')
}

/** Conservative high-impact command patterns (checked after the rm rule). */
export const HIGH_IMPACT_COMMAND = [
  /\bmkfs\.?[a-z]*\b/,
  /\bdd\s+(if|of)=/,
  /(^|[;&|]\s*)sudo\b/,
  /(^|[;&|]\s*)(shutdown|reboot|halt)\b/,
  /git\s+push\s+[^\n]*(-f\b|--force)/,
  /git\s+clean\s+(-[a-z]*f[a-z]*\b)/,
  /find\s+[^\n]*\s+-delete\b/,
  /find\s+[^\n]*-exec\s+[^\n]*\brm\b/,
  /\b(shutil\.rmtree|rmtree)\s*\(/,
  /\bos\.remove\s*\(/,
  /python[0-9.]*\s+-c\s+[^|;&\n]*(rmtree|os\.remove|shutil\.rmtree|rm\s+-rf)/,
  /curl\s+[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /wget\s+[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /\bchmod\s+[0-7]{3,4}\s+[^\n]*\.ssh\//,
  /\bchown\s/,
  /\bdiskutil\s+(eraseDisk|eraseVolume|zeroDisk|secureErase|unmountDisk)\b/,
]

/**
 * Conservative high-impact file-path patterns (credentials, keys, secrets).
 * `.env` matches unless the suffix is an example/sample/template name.
 */
export const HIGH_IMPACT_PATH = [
  /(^|\/)\.env(\.(?!example|sample|template)[^/]*)?$/i,
  /(^|\/)(credentials?|secrets?)(\.(json|ya?ml|toml|ini|env|key|pem|txt))?($|\/)/i,
  /(^|\/)\.ssh\//,
  /(^|\/)(id_(rsa|ed25519|ecdsa|dsa)|\.netrc)(\b|\/)/i,
  /\.(pem|key|p12|pfx|jks)$/i,
]

/**
 * Match a tool call against the high-impact patterns.
 * @param name - the tool name ('bash', 'write', 'edit', ...).
 * @param args - the parsed tool arguments.
 * @returns a human-readable match description, or null when the call is not high-impact.
 */
export function isHighImpact(name, args) {
  if (!args || typeof args !== 'object') return null
  if (name === 'bash' && typeof args.command === 'string') {
    if (hasRecursiveForceRm(args.command)) {
      return 'command pattern rm -r/-f matched (recursive force delete)'
    }
    for (const re of HIGH_IMPACT_COMMAND) {
      const m = String(args.command).match(re)
      if (m) return 'command pattern /' + re.source + '/ matched: "' + String(m[0]).trim().slice(0, 80) + '"'
    }
  }
  if ((name === 'write' || name === 'edit') && typeof args.file_path === 'string') {
    for (const re of HIGH_IMPACT_PATH) {
      if (re.test(String(args.file_path))) return 'file path pattern /' + re.source + '/ matched: "' + String(args.file_path).slice(0, 120) + '"'
    }
  }
  return null
}

/**
 * Resolve the effective tier for one step from a plain decision spec.
 * @param spec
 *   explicitTier:  per-agent explicit tier ('strong' | 'cheap'), e.g. from tier_worker.
 *   sessionMode:   per-session override ('auto' | 'strong' | 'cheap' |
 *                  'delegated' | 'off'); 'off' opts the session out of all
 *                  routing, while 'delegated' keeps the main agent on its
 *                  session default.
 *   escalated:     whether failure auto-escalation is active.
 *   isChild:       whether the agent is a subagent child.
 *   subagentPolicy: 'inherit' | 'cheap' | 'strong'.
 *   mode:          'auto' | 'strong' | 'cheap' | 'delegated' | 'off' (the global default).
 *   planActive:    whether plan mode is active for the agent.
 * @returns 'strong' | 'cheap' | null (null = no routing decision, e.g. mode off).
 */
export function resolveTierSpec(spec) {
  if (spec.explicitTier) return spec.explicitTier === 'strong' ? 'strong' : 'cheap'
  if (spec.sessionMode === 'off') return null
  if (spec.sessionMode === 'strong') return 'strong'
  if (spec.sessionMode === 'cheap') return 'cheap'
  const delegated = spec.sessionMode === 'delegated'
    || (spec.sessionMode === undefined && spec.mode === 'delegated')
  if (delegated && !spec.isChild) return null
  if (spec.escalated) return 'strong'
  if (spec.isChild && spec.subagentPolicy === 'strong') return 'strong'
  if (spec.isChild && spec.subagentPolicy === 'cheap') return 'cheap'
  if (delegated && spec.isChild) return spec.planActive ? 'strong' : 'cheap'
  if (spec.sessionMode === 'auto') return spec.planActive ? 'strong' : 'cheap'
  if (spec.mode === 'strong') return 'strong'
  if (spec.mode === 'cheap') return 'cheap'
  if (spec.mode === 'auto') return spec.planActive ? 'strong' : 'cheap'
  return null
}

// ---- fallback chains & task-intensity effort (tier-router-plus) -------------

/**
 * Error codes that mean "this model route is unusable right now" and justify
 * switching to the next model in the tier's fallback chain. Network/5xx
 * provider failures are normalized to these codes by the adapters; a raw
 * status >= 500 failure is classified the same way as a belt-and-suspenders.
 */
export const FALLBACK_TRIGGER_CODES = ['UNKNOWN_MODEL', 'QUOTA', 'RATE_LIMIT', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'SERVER', 'TRANSPORT']

/**
 * Error codes that must NOT switch models: they are not model-availability
 * problems (context size, a config-level effort mismatch, caller aborts, or a
 * degenerate empty response that DSH's own retry already handles).
 */
export const FALLBACK_IGNORE_CODES = ['CONTEXT_WINDOW_EXCEEDED', 'UNSUPPORTED_REASONING_EFFORT', 'ABORTED', 'EMPTY_RESPONSE']

/**
 * Classify one model-step failure for the fallback machinery.
 * @param failure - the failure shape { message, code, status, requestId, ... }.
 * @returns 'fallback' (switch to the next chain entry), 'ignore' (do not touch
 *   the chain; DSH retry / user action owns it), or 'escalate' (unknown shape -
 *   keep the original failure auto-escalation behavior).
 */
export function classifyFallback(failure) {
  if (!failure || typeof failure !== 'object') return 'escalate'
  if (typeof failure.code === 'string') {
    if (FALLBACK_TRIGGER_CODES.indexOf(failure.code) !== -1) return 'fallback'
    if (FALLBACK_IGNORE_CODES.indexOf(failure.code) !== -1) return 'ignore'
  }
  if (typeof failure.status === 'number' && failure.status >= 500) return 'fallback'
  return 'escalate'
}

/**
 * Validate a reasoning effort against the efforts a model actually declares
 * (resolveModelInfo().reasoning.efforts, each { id, name } or a plain id).
 * An empty/unknown declaration list is treated leniently: nothing is rejected
 * because the metadata could not be obtained.
 * @returns { ok, available } - available is the declared effort id list
 *   (empty when metadata was unavailable).
 */
export function validateReasoningEffort(effort, declaredEfforts) {
  if (typeof effort !== 'string' || effort.length === 0) return { ok: false, available: [] }
  const ids = (Array.isArray(declaredEfforts) ? declaredEfforts : []).map(function (e) {
    return e && typeof e === 'object' ? e.id : e
  }).filter(function (x) { return typeof x === 'string' && x.length > 0 })
  if (ids.length === 0) return { ok: true, available: [] }
  return { ok: ids.indexOf(effort) !== -1, available: ids }
}

/**
 * The cheap-tier effort ladder: the baseline is medium; task intensity can
 * raise it to high then max. Steps never go below medium.
 */
export const EFFORT_LADDER = ['medium', 'high', 'max']

/**
 * The next effort step above current, restricted to the model's declared
 * ids when they are known (lenient: unknown declarations allow the ladder).
 * @returns the next effort id, or null when already at the ceiling.
 */
export function nextEffortStep(current, declaredIds) {
  if (typeof current !== 'string') return null
  const idx = EFFORT_LADDER.indexOf(current)
  if (idx === -1 || idx >= EFFORT_LADDER.length - 1) return null
  const allowed = Array.isArray(declaredIds) && declaredIds.length > 0 ? declaredIds : EFFORT_LADDER
  for (let i = idx + 1; i < EFFORT_LADDER.length; i++) {
    if (allowed.indexOf(EFFORT_LADDER[i]) !== -1) return EFFORT_LADDER[i]
  }
  return null
}

/**
 * Whether a per-agent fallback record is currently on a chain entry.
 * index is the position in the chain (a fresh record uses -1 = main model);
 * until is the TTL expiry for staying on the fallback model.
 */
export function fallbackActive(rec, now) {
  return !!rec
    && typeof rec.index === 'number' && rec.index >= 0
    && typeof rec.until === 'number' && rec.until > now
}

/**
 * Advance a fallback record one step down the chain.
 * @returns the new record ({ index, until }), or null when the chain is
 *   exhausted (the last entry already failed - the caller clears state and
 *   lets the original error surface).
 */
export function advanceFallback(rec, chain, now, ttlMs) {
  const entries = Array.isArray(chain) ? chain : []
  const index = rec && typeof rec.index === 'number' ? rec.index : -1
  const next = index + 1
  if (next >= entries.length) return null
  return { index: next, until: now + (typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : 300000) }
}

/** Coerce one raw fallback entry into { provider, model, reasoningEffort }. */
export function normalizeFallbackEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.provider !== 'string' || entry.provider.length === 0) return null
  if (typeof entry.model !== 'string' || entry.model.length === 0) return null
  return {
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: typeof entry.reasoningEffort === 'string' && entry.reasoningEffort.length > 0 ? entry.reasoningEffort : 'medium',
  }
}

/**
 * Default tier shapes (tier-router-plus): strong follows the session model
 * selection, cheap starts at medium on deepseek-v4-flash; the strong tier
 * ships a deepseek-v4-pro fallback so a provider outage never strands a task.
 */
export const DEFAULT_TIER_CONFIG = {
  strong: {
    followSession: true,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    fallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }],
    label: 'strong',
  },
  cheap: {
    followSession: false,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'medium',
    fallback: [],
    label: 'cheap',
  },
}

/**
 * Normalize a raw tier config (from settings or defaults) into the full
 * v0.5.0 shape. Legacy configs missing followSession/fallback are migrated
 * silently: followSession gets the tier default, fallback mirrors the
 * configured primary (old installs keep routing exactly where they did).
 */
export function migrateTierConfig(tierName, raw) {
  const name = tierName === 'strong' ? 'strong' : 'cheap'
  const defaults = DEFAULT_TIER_CONFIG[name]
  if (!raw || typeof raw !== 'object') {
    return { ...defaults, fallback: defaults.fallback.map(function (e) { return { ...e } }) }
  }
  const primary = {
    provider: typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : defaults.provider,
    model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : defaults.model,
    reasoningEffort: typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.length > 0 ? raw.reasoningEffort : defaults.reasoningEffort,
  }
  let fallback
  if (Array.isArray(raw.fallback)) {
    fallback = raw.fallback.map(normalizeFallbackEntry).filter(Boolean)
  } else {
    // Legacy configs predate fallback and must retain their primary-only behavior.
    fallback = [{ ...primary }]
  }
  return {
    followSession: typeof raw.followSession === 'boolean' ? raw.followSession : defaults.followSession,
    provider: primary.provider,
    model: primary.model,
    reasoningEffort: primary.reasoningEffort,
    fallback: fallback,
    label: name,
  }
}
