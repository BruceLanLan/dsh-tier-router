# Changelog

All notable changes to dsh-tier-router are documented here.

## [0.5.1] - 2026-09-03

Review round against the DSH 0.1.0-rc.8 host sources (event contracts also
checked against 0.1.2-rc.1, which declares the same agent events). Findings,
evidence and the roadmap live in `docs/REVIEW-2026-09-03.md` and
`docs/ROADMAP.md`.

### Fixed
- **`tier_worker` explicit tier was overridden by subagent policy routing.**
  The in-process subagent driver inserts the child's prompt (source `user`)
  synchronously inside `subagents.start()`, so `agent/inbox/inserted` fired for
  the child before the tool could record its explicit tier; under
  `auto` + plan inactive + `inherit`, a `tier: "strong"` worker was re-routed
  to the cheap model (and vice versa with a `strong` policy). The tool now
  announces the requested route before `start()` and the inbox handler adopts
  it, so the child keeps its tier and its header carries the tier's effort.
  Regression test: `tier_worker child keeps its explicit route and effort when
  the inbox listener runs first`.
- **Fallback chains ignored `TIMEOUT` and `NO_ADAPTER`.** Both are emitted by
  the rc.8 adapters (`dsh-llm-deepseek`: TIMEOUT; `dsh-llm-pi-ai`: TIMEOUT,
  NO_ADAPTER; llm core: NO_ADAPTER) but were missing from
  `FALLBACK_TRIGGER_CODES`, so a hung or unroutable primary never fell back.
- **Fallback now defers to downstream recovery.** The `agent/request-error`
  listener awaits `next()` first and changes route only when downstream
  (DSH's `dsh-llm-retry` backoff, which honors `providerRetryAfterMs`) returns
  no decision. Behavior no longer depends on listener registration order.
- **Guard: `rm -rf` inside shell wrappers.** `sh -c "rm -rf x"`,
  `bash -lc '…'`, `zsh -c …` and `eval "rm -rf x"` are now denied on the cheap
  tier; `sh -c "echo rm -rf"` and `sh script.sh` still pass.
- Docs: README opener was truncated mid-sentence in both languages; test count
  was stale (86 cases now); the 0.5.0 "Changed" entry misdescribed the cheap
  defaults (code default is `deepseek-official/deepseek-v4-flash@medium` with
  no fallback); added the in-memory per-session mode limitation.

## [0.5.0] - 2026-08-24

### Added
- **Delegated routing mode**: the main agent stays on the DSH Web model-picker
  selection while only subagents are tier-routed. The global/session `mode` now
  persists as `auto | delegated | strong | cheap | off` (missing or invalid
  legacy values fall back to `auto`), exposed through `/tier delegated`,
  `tier_route({ tier: "delegated" })`, and the WebUI settings card's segmented
  control (自动 | 仅子代理 | 强模型 | 低成本 | 关闭). `/tier auto` is now an
  explicit per-session override so it can override a globally persisted
  delegated mode. Delegated main agents skip inbox/plan header rewrites and
  their errors do not trigger tier escalation or fallback; the high-impact
  guard stays active. Child precedence: explicit `tier_worker` tier, session
  override, escalation, subagentPolicy, then inherit (plan active -> strong,
  otherwise cheap).
- **Per-tier fallback chains**: strong and cheap each support an ordered list of
  fallback models. A model-availability failure (UNKNOWN_MODEL, QUOTA,
  RATE_LIMIT, MISSING_CREDENTIAL, INVALID_CREDENTIAL, SERVER, TRANSPORT, or a
  status >= 500 provider error) advances the agent's chain and writes the next
  model into the session header for the same task. The tier returns to its
  primary model after a 5-minute TTL (`state.fallbackTtlMs`), and a fresh chain
  is used after an exhausted chain clears. Fallback is per agent (subagent
  children included) and independent of failure auto-escalation.
- **Task-intensity reasoning effort**: the cheap tier starts at medium and
  raises itself one step (medium -> high -> max, bounded by the model's
  declared efforts) on cheap-tier retry errors, high-impact guard denials, or
  the new `tier_escalate_effort` tool; `/tier effort <medium|high|max>` sets it
  manually per session. The strong tier follows the session model selection by
  default (`followSession: true`).
- **Effort validation against `llm.resolveModelInfo(provider, model)`**:
  `reasoning.efforts` is enforced when available (cctq accepts low/medium/high,
  deepseek accepts off/high/max) and falls back to a lenient check when model
  metadata is unavailable.
- **New configuration surface**: `/tier set <tier> <provider> <model> [effort]
  [--fallback <p> <m> <e> ...]`, `/tier set strong follow-session`, and
  extended `tier_configure` parameters (`followSession`, `fallback`).
  `tier_configure` and `/tier set` accept any effort string and reject
  undeclared efforts with the available list.
- **Legacy settings migration**: old tier configs missing `followSession` /
  `fallback` are normalized silently (followSession default per tier; fallback
  mirrors the configured primary).
- **WebUI settings card** (new client bundle, `client/client.js`): a
  `settings.section` "Tier routing" page showing the live configuration and
  editing strong/cheap providers, followSession, fallback chains (one row per
  entry, pre-filled from the stored/default chain), subagentPolicy, and the
  routing mode — saved through the `tier-router` settings namespace and hot
  synced via `settings/document-updated`.
- **Model-catalog dropdowns**: provider -> model -> effort cascading selects
  fed by the host model catalog (`api.llm.models`); effort options come from
  each model's declared reasoning efforts. Values outside the catalog (custom
  routes) are kept as marked options; catalog failure falls back to free text.
- **Auto-activation polling**: the card silently re-probes every 4s while the
  namespace is unregistered (namespace registration emits no
  `settings/document-updated`), flipping to the live form the moment a tiered
  session registers it; polling stops once active.
- **`/tier` command result card**: a keyed `conversation.chat.commandview`
  entry renders `/tier` output fully expanded (the generic command card
  collapses multi-line output to a one-line summary), with success/running/
  failure states.
- **Automatic tiered preset discovery**: the profile bundle now mounts a
  host-only synchronizer. After `dsh plugin --profile web add dsh-tier-router`,
  DSH startup validates and synchronizes the packaged `tiered` preset into the
  user discovery root (`~/.dsh/.agent-presets` or `DSH_HOME/.agent-presets`).
  The host row never mounts routing tools; selecting `tiered` still mounts the
  agent-plane `tier-routing` row.
- **Preset description**: the tiered preset now describes fallback chains,
  task-intensity effort and the WebUI card (bilingual).

### Fixed
- **Initial and resumed routing**: synchronize the selected route into mutable
  AgentOptions before the loop builds a request, so the first request no longer
  discards a header written at inbox insertion.
- **Ordinary subagent routing**: `subagent` and `subagent_fork` now apply the
  configured child policy before their first request rather than only reporting
  that policy in diagnostics and the guard.
- **Fallback recovery**: availability failures now change route at
  `agent/request-error` and retry the same step. Fallback records carry their
  tier identity, so plan transitions cannot select a fallback from another tier;
  an explicit empty fallback array now disables fallback.
- **Escalation and headers**: child escalation obeys its TTL without overwriting
  a worker's explicit tier; route writes preserve unrelated request-header
  fields; delegated/off restore the session's captured route rather than the
  mutable global default.
- **WebUI integration**: the `/tier` command renderer now registers its required
  slot key, catalog failure permits free-form custom routes, and partial catalog
  failures are visible.
- `/tier status` printed a duplicate cheap-tier line (leftover from the
  fallback/effort status rewrite).
- Client bundle factory was missing `return module.exports`, breaking the
  browser harness boot ("invalid plugin ... received undefined").
- Fallback-chain editing crashed the settings panel white: `selectOrText` was
  called with a string where the locale function was expected, throwing
  `t is not a function` once the model catalog loaded.
- Settings card inputs were invisible on light themes: hard-coded dark
  fallback colors were replaced with the official `--dsw-*` theme aliases so
  the card follows light/dark themes automatically.

### Changed
- Defaults: strong = followSession with deepseek-official/deepseek-v4-pro@max
  as the explicit primary and a same-route fallback entry; cheap =
  deepseek-official/deepseek-v4-flash@medium with no fallback (corrected in
  0.5.1: this entry previously described a local test configuration).
- Success recovery is conservative: no LLM success event is emitted by the
  rc.7 agent loop, so a fallback stays active until its TTL expires and the
  next inbox write keeps the fallback header while the TTL is valid.
- Model fields are dropdowns backed by the model catalog instead of free text
  (custom values are preserved).

## [0.4.8] - 2026-08-16

### Fixed
- The inbox/plan/escalation listeners no longer rewrite headers of sessions
  the router does not manage: blank sessions are left to the host model picker,
  and a header for any manually selected provider/model is never overridden.
- Automatic routing now continues only after the plugin itself has established
  a tier header, or after an explicit `/tier strong|cheap|auto` opt-in; `off`
  still disables everything.
- This fixes the model-config mismatch that produced undefined
  provider/asyncIterator failures on new sessions when a manually selected
  model was being overwritten by tier routing.

### Added
- Regression tests: blank sessions and non-tier (manually selected) headers
  must not be rewritten by inbox routing.

## [0.4.7] - 2026-08-16

### Fixed
- Removed the `agent/request` waterfall listener: on DSH rc.6 an extra
  standing-scope waterfall listener makes model requests fail before reaching
  the adapter (the model-selection listener destructures the downstream result
