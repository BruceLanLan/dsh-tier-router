# Changelog

All notable changes to dsh-tier-router are documented here.

## [0.4.7] - 2026-08-16

### Fixed
- Removed the `agent/request` waterfall listener: on DSH rc.6 an extra
  standing-scope waterfall listener makes model requests fail before reaching
  the adapter (the model-selection listener destructures the downstream result
  without guarding an undefined value). This could break every model step in a
  session composed with the plugin.
- `tier_worker` now supplies the complete route (`agentOptions` with provider,
  model, and reasoningEffort) at child creation instead of rewriting the
  waterfall — requests stay stable and the worker still runs on its chosen tier.

### Changed
- Built-in `subagent`/`subagent_fork` children inherit the parent's model route;
  `/tier subagent` now records the policy used to classify subagent execution
  for the high-impact guard rather than rewriting child model steps.
- Bilingual README updated to describe the current routing model accurately.

## [0.4.3] - 2026-08-16

### Fixed
- Plan state is now derived from the session log instead of the `planMode`
  service: that service lives inside the preset's plan-mode isolate realm,
  which is unreachable from a standing-scope row, so auto routing previously
  could not see plan mode and routed plan steps to the cheap tier.
- `/tier plan` falls back to appending the identical `plan/mode` session event
  when the planMode service is unreachable; state folds the same for every
  reader.

## [0.4.2] - 2026-08-16

### Changed (breaking install path)
- The plugin is agent-plane: it must be composed in the agent preset your
  sessions use, not as a host bundle row. Host-scope installs silently skipped
  every tool/command/prompt registration (those services are only reachable
  from the agent scope).
- `cordis.patch.yml` no longer ships a host insert; it is an install guide plus
  an empty top-level array (a comment-only patch file made dsh exit on boot).
- Ships a ready-made `agent-presets/tiered` preset (standard + tier-routing).
- Bilingual installation docs (README.md / README.zh.md).

## [0.4.1] - 2026-08-16

### Fixed
- Plan-mode flips respect an explicit per-session tier (cheap/strong sessions
  are immune to plan-state changes).
- Failure auto-escalation now escalates ALL subagent children, including
  built-in-subagent children without an explicit tier.
- Background `tier_worker` resolves its `done` promise to a proper
  `JobOutcome` (`{status, detail, output}`); the previous worker-result shape
  corrupted job records in the real runtime.
- Background `tier_worker` attaches a jobs controller so `jobs.start` accepts
  the owner.
- Runtime smoke suite (mocked ctx) covering the above contracts; CI installs
  the harness tool deps to run it.

## [0.4.0] - 2026-08-16

### Added
- Durable tier configuration in the `tier-router` settings namespace
  (survives restarts; `sessionOnly: true` keeps a change transient).
- Registration isolation: a single conflicting registration no longer kills
  the plugin.
- Background workers: `tier_worker` with `background: true` via the jobs
  service.
- `/tier route` and `/tier set` no longer persist the session default model by
  default (`persist: true` opts in).
- Expanded high-impact guard patterns (split `rm -r -f` flags, `sudo rm`,
  `find -delete`, `find -exec rm`, `shutil.rmtree`/`os.remove`, `python -c`,
  `git clean -f*`, force push, `.ssh/` and credential/secret paths, `pem`/`key`)
  with 20+ unit tests.
- CI workflow (`node --check` + `node --test` on push/PR).

## [0.3.0] - 2026-08-15

### Added
- Per-session routing modes: `/tier strong|cheap|auto|off` scope to the current
  session only (other sessions keep their own mode).
- Bilingual README (English primary, README.zh.md).

## [0.2.1] - 2026-08-15

### Added
- Initial release: strong/cheap tier routing, plan-mode-aware auto mode,
  `/advisor` + `tier_advisor`, `tier_review`, failure auto-escalation,
  high-impact guard, subagent tiering (`tier_worker`, subagent policy).
