window.__ModuleLoader__.load({ id: "dsh-tier-router", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-tier-router client — the WebUI settings card.
 *
 * One seat: the `settings.section` "Tier routing" page. It reads the
 * `tier-router` settings namespace through the host transport
 * (api.settings.describe) and writes it back (api.settings.update), so the
 * strong/cheap tiers, fallback chains, followSession and subagentPolicy are
 * viewable and hot-editable from the WebUI settings panel without touching a
 * slash command. `settings/document-updated` keeps the card live when another
 * surface (an agent session's /tier set, tier_configure) changes the same
 * namespace.
 *
 * Model inputs are dropdowns fed by the host model catalog
 * (api.llm.models / api.llm.providers): provider -> model -> effort cascade,
 * with the currently configured value kept as an extra option when it is not
 * in the catalog (custom routes). The fallback chains are edited as one row
 * per entry, pre-filled from the stored (or default) chain.
 *
 * The namespace is registered by the agent-plane plugin the first time a
 * session runs the `tiered` preset. Before that the card shows the built-in
 * defaults and explains how to activate.
 *
 * Hand-authored CJS bundle (no build step); the only external is `react`,
 * resolved by the host ModuleLoader. All colors come from the official theme
 * aliases (--dsw-*), so the card follows light/dark themes automatically.
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useCallback } = React

const NS = 'tier-routing-client'
const SETTINGS_NS = 'tier-router'

// ---- theme-driven style tokens --------------------------------------------

const T = {
  text: 'var(--dsw-alias-label-primary)',
  textSecondary: 'var(--dsw-alias-label-secondary)',
  textMuted: 'var(--dsw-alias-label-tertiary)',
  inputBg: 'var(--dsw-specific-input-major)',
  surface: 'var(--dsw-alias-bg-layer-1)',
  border: 'var(--dsw-alias-border-l1)',
  borderStrong: 'var(--dsw-alias-border-l2)',
  success: 'var(--dsw-alias-state-success-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  primaryBtn: 'var(--dsw-alias-button-primary-fill)',
  primaryBtnText: 'var(--dsw-alias-label-inverse, #ffffff)',
  ghostBtn: 'var(--dsw-alias-button-ghost-active-fill, transparent)',
  shadow: 'var(--dsw-shadow-lv1, none)',
}

const fieldStyle = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13,
  lineHeight: '20px', fontFamily: 'inherit',
  background: T.inputBg, color: T.text,
  border: '1px solid ' + T.borderStrong, borderRadius: 10,
  outline: 'none',
}

const labelStyle = {
  display: 'block', fontSize: 12, color: T.textSecondary, marginBottom: 4,
  fontWeight: 500,
}

const noteStyle = {
  fontSize: 12, color: T.textMuted, margin: '4px 0 0',
  lineHeight: '18px',
}

const cardStyle = {
  border: '1px solid ' + T.border, borderRadius: 12, padding: '14px 16px',
  background: T.surface, boxShadow: T.shadow,
}

const sectionTitleStyle = { margin: 0, fontSize: 18, fontWeight: 600, color: T.text }
const sectionSubStyle = { margin: '2px 0 0', fontSize: 13, color: T.textMuted }
const groupHeadStyle = {
  margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '.06em',
  textTransform: 'uppercase', color: T.textMuted,
}

// ---- locale ---------------------------------------------------------------

const zh = {
  nav: 'Tier 路由',
  subtitle: '首请求分层、同一步回退与子代理策略的 WebUI 设置',
  unregistered: '尚未激活：tier-router 命名空间由 tiered preset 会话注册。请先用 tiered preset 新建一个会话（新建会话 → 选择 tiered），保存即自动可用。',
  statusTitle: '当前生效配置',
  routingMode: '默认路由模式',
  routingModeHint: 'auto：主会话按计划状态切换；delegated：主会话固定使用模型选择器，只有子代理分层；strong/cheap：所有未覆盖会话固定档；off：关闭分层。',
  modeAuto: '自动',
  modeDelegated: '仅子代理',
  modeStrong: '强模型',
  modeCheap: '低成本',
  modeOff: '关闭',
  followSession: '跟随会话模型选择',
  followSessionHint: '主档使用 WebUI 模型选择器里的 provider/model/effort；下方显式主档仅在取消勾选时生效。',
  provider: 'Provider',
  model: 'Model',
  effort: 'Effort',
  fallback: '回退链',
  fallbackHint: '主模型不可用时按顺序尝试；移除全部条目即可关闭回退。',
  addFallback: '+ 添加回退',
  remove: '移除',
  subagentPolicy: '子代理策略',
  subagentHint: 'inherit：子代理与主 agent 同规则（auto 模式下随计划状态切换 strong/cheap）；cheap：子代理固定走 cheap 档，适合日常实现；strong：子代理固定走 strong 档，适合困难分析 / 架构 / 评审。',
  save: '保存到 settings',
  saving: '保存中…',
  saved: '已保存（热生效）',
  saveFail: '保存失败：',
  loadFail: '读取失败：',
  retry: '重试',
  refresh: '刷新',
  ttlNote: 'fallback/effort TTL 300s、升级阈值 2/60s/180s 为代码内常量，未开放 WebUI 修改',
  editNote: 'effort 选项来自模型声明的档位（如 deepseek 系列声明 off/high/max）；未声明时保留当前值。',
  strong: 'strong 档',
  cheap: 'cheap 档',
  active: '（已激活）',
  reset: '恢复默认',
  catalogFail: '模型目录加载失败，已退回自由输入：',
  addEmpty: '请先填写回退条目的 provider 和 model。',
  cmdRunning: '正在生成路由状态…',
  cmdFailed: '命令失败',
  customSuffix: '（未在目录中）',
}

const en = {
  nav: 'Tier routing',
  subtitle: 'First-request tiering, same-step fallback and subagent policy — WebUI settings',
  unregistered: 'Not active yet: the tier-router namespace is registered by the first session that runs the tiered preset (new session -> tiered). The card becomes editable once that happens.',
  statusTitle: 'Current configuration',
  routingMode: 'Default routing mode',
  routingModeHint: 'auto: main sessions follow plan state; delegated: main sessions stay on the model picker and only subagents are tiered; strong/cheap: pin unoverridden sessions; off: disable tiering.',
  modeAuto: 'Auto',
  modeDelegated: 'Subagents only',
  modeStrong: 'Strong',
  modeCheap: 'Cheap',
  modeOff: 'Off',
  followSession: 'Follow session model selection',
  followSessionHint: 'The primary uses the WebUI model picker; the explicit primary below applies only while unchecked.',
  provider: 'Provider',
  model: 'Model',
  effort: 'Effort',
  fallback: 'Fallback chain',
  fallbackHint: 'Tried in order when the primary is unavailable; remove every row to disable fallback.',
  addFallback: '+ Add fallback',
  remove: 'Remove',
  subagentPolicy: 'Subagent policy',
  subagentHint: 'inherit: subagents follow the same rules as the main agent (auto mode follows plan state); cheap: subagents always run on the cheap tier (routine implementation); strong: subagents always run on the strong tier (hard analysis / architecture / review).',
  save: 'Save to settings',
  saving: 'Saving…',
  saved: 'Saved (hot)',
  saveFail: 'Save failed: ',
  loadFail: 'Read failed: ',
  retry: 'Retry',
  refresh: 'Refresh',
  ttlNote: 'Fallback/effort TTL 300s and escalation 2/60s/180s are code constants, not exposed in the WebUI yet',
  editNote: 'Effort options come from each model\'s declared efforts (e.g. deepseek models declare off/high/max); undeclared values keep their current option.',
  strong: 'strong tier',
  cheap: 'cheap tier',
  active: '(active)',
  reset: 'Reset defaults',
  catalogFail: 'Model catalog failed to load, fell back to free text: ',
  addEmpty: 'Fill provider and model before adding a fallback row.',
  cmdRunning: 'Gathering routing state…',
  cmdFailed: 'Command failed',
  customSuffix: ' (not in catalog)',
}

const DEFAULTS = {
  mode: 'auto',
  strongProvider: 'deepseek-official',
  strongModel: 'deepseek-v4-pro',
  strongEffort: 'max',
  strongFollowSession: true,
  strongFallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }],
  cheapProvider: 'deepseek-official',
  cheapModel: 'deepseek-v4-flash',
  cheapEffort: 'medium',
  cheapFollowSession: false,
  cheapFallback: [],
  subagentPolicy: 'inherit',
}

function cloneDefault() {
  return {
    ...DEFAULTS,
    strongFallback: DEFAULTS.strongFallback.map((f) => ({ ...f })),
    cheapFallback: DEFAULTS.cheapFallback.map((f) => ({ ...f })),
  }
}

function tierLabel(t) {
  return t.provider + '/' + t.model + ' (' + t.reasoningEffort + ')'
}

function chainText(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return '—'
  return chain.map((f) => f.provider + '/' + f.model + '@' + f.reasoningEffort).join(' -> ')
}

// ---- catalog-aware select helpers -----------------------------------------

/** Normalize the llm.models response into { providerId: { name, models: [{id, name, efforts: []}] } }. */
function catalogFromGroups(groups) {
  const out = {}
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || typeof g.id !== 'string') continue
    out[g.id] = {
      name: typeof g.name === 'string' ? g.name : g.id,
      models: (Array.isArray(g.models) ? g.models : []).map((m) => ({
        id: m && m.id,
        name: m && (typeof m.name === 'string' ? m.name : m.id),
        efforts: m && m.reasoning && Array.isArray(m.reasoning.efforts)
          ? m.reasoning.efforts.map((e) => (e && typeof e.id === 'string' ? e.id : null)).filter(Boolean)
          : [],
      })).filter((m) => typeof m.id === 'string'),
    }
  }
  return out
}

function effortOptionsFor(model) {
  if (!model) return []
  return model.efforts || []
}

function selectOrText(t, label, value, options, onChange, disabled, optionLabel) {
  // options: array of { value, label } — a dropdown when non-empty and the
  // current value is representable; free text otherwise (custom routes).
  const style = { ...fieldStyle, cursor: disabled ? 'default' : 'pointer' }
  const dim = disabled ? { opacity: 0.55 } : {}
  const known = options.some((o) => o.value === value)
  if (options.length === 0) {
    return h('label', { style: { display: 'block' } },
      h('span', { style: labelStyle }, label),
      h('input', { value: value, disabled: disabled, onChange: (e) => onChange(e.target.value), style: { ...fieldStyle, ...dim } }))
  }
  const all = known ? options : [{ value: value, label: (optionLabel ? optionLabel(value) : value) + t('customSuffix') }, ...options]
  return h('label', { style: { display: 'block' } },
    h('span', { style: labelStyle }, label),
    h('select', {
      value: value, disabled: disabled,
      onChange: (e) => onChange(e.target.value),
      style: { ...style, ...dim },
    }, all.map((o) => h('option', { key: o.value, value: o.value }, o.label))))
}

// ---- the settings section page ---------------------------------------------

function TierSection({ t, api, remote }) {
  const [state, setState] = useState({ status: 'loading' })
  const [draft, setDraft] = useState(null)
  const [catalog, setCatalog] = useState({ groups: {}, loaded: false, fail: null })
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null)

  const loadCatalog = useCallback(async () => {
    try {
      const res = await api.llm.models({})
      if (res.result.ok) {
        const failures = Array.isArray(res.result.value.failures) ? res.result.value.failures : []
        const failureText = failures.length > 0 ? failures.map((f) => String((f && (f.message || f.provider)) || f)).join('; ') : null
        setCatalog({ groups: catalogFromGroups(res.result.value.groups), loaded: true, fail: failureText })
        return
      }
      setCatalog((c) => ({ ...c, fail: String((res.result.error && res.result.error.message) || 'catalog error') }))
    } catch (e) {
      setCatalog((c) => ({ ...c, fail: String((e && e.message) || e) }))
    }
  }, [api])

  const load = useCallback(async (quiet) => {
    if (quiet !== true) setState((s) => ({ ...s, status: 'loading' }))
    try {
      const res = await api.settings.describe({})
      if (!res.result.ok) {
        setState({ status: 'error', error: String((res.result.error && res.result.error.message) || 'read failed') })
        return
      }
      const view = res.result.value.namespaces.find((n) => n.ns === SETTINGS_NS)
      if (view === undefined) {
        setState({ status: 'unregistered' })
        setDraft(cloneDefault())
        return
      }
      setState({ status: 'ready', view: view })
      const value = JSON.parse(JSON.stringify(view.value))
      setDraft({ ...cloneDefault(), ...value })
    } catch (e) {
      setState({ status: 'error', error: String((e && e.message) || e) })
    }
  }, [api])

  useEffect(() => {
    void load()
    void loadCatalog()
  }, [load, loadCatalog])

  useEffect(() => {
    return remote.$on('settings/document-updated', (ns) => {
      if (ns === SETTINGS_NS) void load()
    })
  }, [remote, load])

  // The tier-router namespace is registered by the first tiered session, and
  // namespace registration does NOT emit settings/document-updated — so while
  // the card is unregistered it silently re-probes every 4s and flips to the
  // live form the moment a tiered session starts. Polling stops once active.
  useEffect(() => {
    if (state.status !== 'unregistered') return
    const id = setInterval(() => { void load(true) }, 4000)
    return () => clearInterval(id)
  }, [state.status, load])

  const patch = () => (draft === null ? {} : { ...draft })

  const save = async () => {
    if (draft === null) return
    if (state.status !== 'ready') {
      setNotice({ kind: 'error', text: t('unregistered') })
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const chains = [draft.strongFallback || [], draft.cheapFallback || []]
      if (chains.some((chain) => chain.some((entry) => !entry.provider || !entry.model || !entry.reasoningEffort))) {
        setNotice({ kind: 'error', text: t('addEmpty') })
        return
      }
      const res = await api.settings.update({ ns: SETTINGS_NS, patch: patch() })
      if (res.result.ok) setNotice({ kind: 'ok', text: t('saved') })
      else setNotice({ kind: 'error', text: t('saveFail') + String((res.result.error && res.result.error.message) || 'rejected') })
    } catch (e) {
      setNotice({ kind: 'error', text: t('saveFail') + String((e && e.message) || e) })
    }
    setSaving(false)
    void load()
  }

  const reset = () => {
    setDraft(cloneDefault())
    setNotice(null)
  }

  const setField = (path, value) => {
    setDraft((d) => (d === null ? d : { ...d, [path]: value }))
  }

  // ---- chain editing helpers ----------------------------------------------

  const setChainRow = (chainKey, index, field, value) => {
    setDraft((d) => {
      if (d === null) return d
      const chain = (d[chainKey] || []).map((f) => ({ ...f }))
      if (!chain[index]) chain[index] = { provider: '', model: '', reasoningEffort: '' }
      chain[index][field] = value
      return { ...d, [chainKey]: chain }
    })
  }

  const addChainRow = (chainKey) => {
    setDraft((d) => (d === null ? d : { ...d, [chainKey]: [...(d[chainKey] || []), { provider: '', model: '', reasoningEffort: '' }] }))
  }

  const removeChainRow = (chainKey, index) => {
    setDraft((d) => {
      if (d === null) return d
      const chain = (d[chainKey] || []).filter((_, i) => i !== index)
      return { ...d, [chainKey]: chain }
    })
  }

  const providerOptions = () => Object.keys(catalog.groups).map((id) => ({
    value: id, label: catalog.groups[id].name + ' (' + id + ')',
  }))
  const modelOptions = (provider) => {
    const g = catalog.groups[provider]
    if (!g) return []
    return g.models.map((m) => ({ value: m.id, label: m.name + (m.id === m.name ? '' : ' (' + m.id + ')') }))
  }
  const effortOptions = (provider, model) => {
    const g = catalog.groups[provider]
    const m = g && g.models.find((x) => x.id === model)
    return (m ? effortOptionsFor(m) : []).map((id) => ({ value: id, label: id }))
  }

  const setTierProvider = (tierKey, provider) => {
    const models = modelOptions(provider)
    const model = models.some((m) => m.value === draft[tierKey + 'Model']) ? draft[tierKey + 'Model'] : (models[0] ? models[0].value : '')
    const efforts = effortOptions(provider, model)
    const effort = efforts.some((e) => e.value === draft[tierKey + 'Effort']) ? draft[tierKey + 'Effort'] : (efforts[0] ? efforts[0].value : '')
    setDraft((d) => (d === null ? d : { ...d, [tierKey + 'Provider']: provider, [tierKey + 'Model']: model, [tierKey + 'Effort']: effort }))
  }

  // one provider/model/effort triplet
  const triple = (tKey, d, disabled) => h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 } },
    selectOrText(t, t('provider'), d.provider, providerOptions(), (v) => setTierProvider(tKey, v), disabled),
    selectOrText(t, t('model'), d.model, modelOptions(d.provider), (v) => setField(tKey + 'Model', v), disabled),
    selectOrText(t, t('effort'), d.effort, effortOptions(d.provider, d.model), (v) => setField(tKey + 'Effort', v), disabled))

  const chainEditor = (chainKey, disabled) => {
    const chain = draft[chainKey] || []
    return h('div', null,
      chain.map((entry, i) => h('div', {
        key: chainKey + '-' + i,
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 28px', gap: 8, alignItems: 'end', margin: '6px 0' },
      },
      selectOrText(t, '#' + (i + 1) + ' ' + t('provider'), entry.provider || '', providerOptions(), (v) => setChainRow(chainKey, i, 'provider', v), disabled),
      selectOrText(t, t('model'), entry.model || '', modelOptions(entry.provider), (v) => setChainRow(chainKey, i, 'model', v), disabled),
      selectOrText(t, t('effort'), entry.reasoningEffort || '', effortOptions(entry.provider, entry.model), (v) => setChainRow(chainKey, i, 'reasoningEffort', v), disabled),
      h('button', {
        onClick: () => removeChainRow(chainKey, i), disabled: disabled,
        title: t('remove'), 'aria-label': t('remove'),
        style: { padding: '7px 0', fontSize: 13, lineHeight: '20px', cursor: disabled ? 'default' : 'pointer', background: 'transparent', color: T.textMuted, border: 'none', borderRadius: 8 },
      }, '✕'))),
      h('button', {
        onClick: () => addChainRow(chainKey), disabled: disabled,
        style: {
          marginTop: 4, padding: '5px 12px', fontSize: 12, cursor: disabled ? 'default' : 'pointer',
          background: 'transparent', color: T.textSecondary, border: '1px dashed ' + T.borderStrong, borderRadius: 8,
        },
      }, t('addFallback')))
  }

  // ---- render --------------------------------------------------------------

  const inputStyle = { ...fieldStyle }
  const dim = { opacity: saving ? 0.55 : 1 }

  const statusLine = (label, text, chain) =>
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', padding: '3px 0' } },
      h('span', { style: { color: T.success, fontSize: 11 } }, '●'),
      h('b', { style: { fontSize: 13 } }, label),
      h('span', { style: { fontSize: 13 } }, text),
      chain ? h('span', { style: noteStyle }, '→ ' + chain) : null)

  const modeOptions = [
    ['auto', 'modeAuto'],
    ['delegated', 'modeDelegated'],
    ['strong', 'modeStrong'],
    ['cheap', 'modeCheap'],
    ['off', 'modeOff'],
  ]

  const actionsRow = h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2, paddingBottom: 2 } },
    h('button', {
      onClick: () => void save(), disabled: saving,
      style: {
        padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        background: T.primaryBtn, color: T.primaryBtnText, border: 'none', borderRadius: 10,
      },
    }, saving ? t('saving') : t('save')),
    h('button', { onClick: reset, disabled: saving, style: secondaryButtonStyle() }, t('reset')),
    h('button', { onClick: () => { void load(); void loadCatalog() }, disabled: saving, style: secondaryButtonStyle() }, t('refresh')))

  const form = () => {
    const d = draft
    const disabled = saving
    const fs = d.strongFollowSession
    const dimActive = disabled ? { opacity: 0.55 } : {}
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      // status
      h('div', { style: cardStyle },
        h('p', { style: groupHeadStyle }, t('statusTitle')),
        statusLine(t('routingMode'), d.mode),
        statusLine(t('strong'), tierLabel({ provider: d.strongProvider, model: d.strongModel, reasoningEffort: d.strongEffort }) + (fs ? ' ' + t('active') : ''), chainText(d.strongFallback)),
        statusLine(t('cheap'), tierLabel({ provider: d.cheapProvider, model: d.cheapModel, reasoningEffort: d.cheapEffort }), chainText(d.cheapFallback)),
        h('div', { style: { ...noteStyle, marginTop: 4 } }, 'subagentPolicy: ' + d.subagentPolicy)),
      // routing mode
      h('div', { style: cardStyle },
        h('label', { style: labelStyle }, t('routingMode')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 0, marginTop: 6 } },
          modeOptions.map(([value, labelKey], index) => h('button', {
            key: value,
            type: 'button',
            disabled: disabled,
            onClick: () => setField('mode', value),
            style: {
              padding: '7px 12px', fontSize: 12, cursor: disabled ? 'default' : 'pointer',
              color: d.mode === value ? T.primaryBtnText : T.textSecondary,
              background: d.mode === value ? T.primaryBtn : T.inputBg,
              border: '1px solid ' + (d.mode === value ? T.primaryBtn : T.borderStrong),
              borderRadius: index === 0 ? '8px 0 0 8px' : (index === modeOptions.length - 1 ? '0 8px 8px 0' : 0),
              marginLeft: index === 0 ? 0 : -1,
            },
          }, t(labelKey)))),
        h('div', { style: { ...noteStyle, marginTop: 8 } }, t('routingModeHint'))),
      // strong config
      h('div', { style: cardStyle },
        h('p', { style: groupHeadStyle }, t('strong')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 2px', cursor: disabled ? 'default' : 'pointer' } },
          h('input', {
            type: 'checkbox', checked: fs === true, disabled: disabled,
            onChange: (e) => setField('strongFollowSession', e.target.checked),
            style: { width: 15, height: 15, accentColor: T.primaryBtn, cursor: disabled ? 'default' : 'pointer' },
          }),
          h('span', { style: { fontSize: 13, color: T.text } }, t('followSession'))),
        h('div', { style: noteStyle }, t('followSessionHint')),
        h('div', { style: { marginTop: 10, ...dimActive } }, triple('strong', { provider: d.strongProvider, model: d.strongModel, effort: d.strongEffort }, disabled || fs)),
        h('label', { style: { ...labelStyle, marginTop: 12 } }, t('fallback')),
        chainEditor('strongFallback', disabled)),
      // cheap config
      h('div', { style: cardStyle },
        h('p', { style: groupHeadStyle }, t('cheap')),
        h('div', { style: { marginTop: 10, ...dimActive } }, triple('cheap', { provider: d.cheapProvider, model: d.cheapModel, effort: d.cheapEffort }, disabled)),
        h('label', { style: { ...labelStyle, marginTop: 12 } }, t('fallback')),
        chainEditor('cheapFallback', disabled)),
      // subagent policy
      h('div', { style: cardStyle },
        h('label', { style: labelStyle }, t('subagentPolicy')),
        h('select', {
          value: d.subagentPolicy, disabled: disabled,
          onChange: (e) => setField('subagentPolicy', e.target.value),
          style: { ...inputStyle, ...dimActive, cursor: disabled ? 'default' : 'pointer' },
        },
        h('option', { value: 'inherit' }, 'inherit'),
        h('option', { value: 'cheap' }, 'cheap'),
        h('option', { value: 'strong' }, 'strong')),
        h('div', { style: { ...noteStyle, marginTop: 8, lineHeight: '20px' } }, t('subagentHint'))),
      actionsRow,
      notice === null ? null : h('p', { style: { margin: 0, fontSize: 13, color: notice.kind === 'ok' ? T.success : T.error } }, notice.text),
      h('p', { style: noteStyle }, t('editNote')),
      h('p', { style: noteStyle }, t('ttlNote')))
  }

  let body
  if (state.status === 'loading') {
    body = h('div', { style: { color: T.textMuted } }, '…')
  } else if (state.status === 'error') {
    body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' } },
      h('p', { style: { margin: 0, color: T.error } }, t('loadFail') + state.error),
      h('button', { onClick: () => void load(), style: secondaryButtonStyle() }, t('retry')))
  } else if (draft === null) {
    body = h('div', { style: { color: T.textMuted } }, '…')
  } else {
    body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      state.status === 'unregistered'
        ? h('p', { style: { margin: 0, padding: '10px 12px', borderRadius: 10, background: T.surface, border: '1px solid ' + T.borderStrong, color: T.warn, fontSize: 13, lineHeight: '20px' } }, t('unregistered'))
        : null,
      catalog.fail ? h('p', { style: { margin: 0, color: T.textMuted, fontSize: 12 } }, t('catalogFail') + catalog.fail) : null,
      form())
  }

  return h('div', { style: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12, padding: '2px' } },
    h('h2', { style: sectionTitleStyle }, t('nav')),
    h('p', { style: sectionSubStyle }, t('subtitle')),
    body)
}

// ---- command result card: tier 命令专属渲染（默认展开完整状态） -------------
// The generic command card collapses long output to a one-line summary; a
// /tier status result is exactly the multi-line text users want to see, so
// this keyed slot entry renders the full status immediately.

function TierCommandView({ node, t }) {
  const outcome = node && node.outcome
  const text = outcome && typeof outcome.text === 'string' ? outcome.text : null
  const running = outcome === null || outcome === undefined
  const failed = outcome !== null && outcome !== undefined && outcome.kind === 'error'
  const dotColor = failed ? T.error : (running ? T.textMuted : T.success)
  const dot = failed ? '✕' : (running ? '…' : '✓')
  return h('div', {
    style: {
      border: '1px solid ' + T.border, borderRadius: 12, padding: '10px 14px',
      background: T.surface, boxShadow: T.shadow, margin: '2px 0',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: text === null ? 0 : 8 } },
      h('span', { style: { color: dotColor, fontSize: 13, width: 14 } }, dot),
      h('b', { style: { fontSize: 13 } }, '/tier'),
      failed ? h('span', { style: { fontSize: 12, color: T.error } }, t('cmdFailed')) : null),
    text === null
      ? h('span', { style: { fontSize: 12, color: T.textMuted } }, t('cmdRunning'))
      : h('pre', {
        style: {
          margin: 0, padding: '12px 14px', overflow: 'auto', maxHeight: 420,
          border: '1px solid ' + T.border, borderRadius: 10,
          background: 'var(--dsw-alias-markdown-code-block)',
          color: T.text, fontFamily: 'var(--ds-font-family-code, monospace)',
          fontSize: 12, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
      }, text))
}

function secondaryButtonStyle() {
  return {
    padding: '7px 14px', fontSize: 13, cursor: 'pointer',
    background: T.ghostBtn, color: T.text,
    border: '1px solid ' + T.borderStrong, borderRadius: 10,
  }
}

exports.name = 'dsh-tier-router'
exports.inject = ['slots', 'locale', 'connection', 'remote']
exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tier-router: client dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'tier-routing',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: () => {
      const { api } = ctx.get('connection')
      const remote = ctx.get('remote')
      return { t, api, remote }
    },
  }, TierSection))

  // /tier command results: a keyed commandview entry that renders the full
  // status text expanded instead of the generic one-line collapsed card.
  ctx.inject(['slots', 'locale'], (scope) => {
    return scope.slots.register({
      name: 'conversation.chat.commandview',
      id: 'tier',
      order: 0,
      key: 'tier',
      inject: () => ({ t }),
    }, TierCommandView)
  })
}

return module.exports;
}});
