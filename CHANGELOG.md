# Changelog

All notable changes to dsh-tier-router are documented here.
## [0.5.0] - 2026-08-20

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
- **Preset description**: the tiered preset now describes fallback chains,
  task-intensity effort and the WebUI card (bilingual).

### Fixed
- Failure auto-escalation could never reach its threshold: `escalationActive`
  deleted in-progress counting records (`until === 0`) on routing lookups
  between two errors. Counting records now survive until the escalation
  actually expires.
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
  fallback; cheap = cctq/gpt-5.6-terra@medium with
  deepseek-official/deepseek-v4-flash@high fallback.
- Success recovery is conservative: no LLM success event is emitted by the
  rc.7 agent loop, so a fallback stays active until its TTL expires and the
  next inbox write keeps the fallback header while the TTL is valid.
- Model fields are dropdowns backed by the model catalog instead of free text
  (custom values are preserved).

## [0.4.7] - 2026-08-16

### Fixed
- Removed the `agent/request` waterfall listener: on DSH rc.6 an extra
  standing-scope waterfall listener makes model requests fail before reaching
  the adapter (the model-selection listener destructures the downstream result
