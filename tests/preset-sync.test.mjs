import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncTieredPreset } from '../lib/preset-sync.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tier-router-preset-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  const preset = join(source, 'tiered')
  mkdirSync(preset, { recursive: true })
  writeFileSync(join(preset, 'agent.cordis.yml'), '- id: tier-routing\n  name: dsh-tier-router\n')
  writeFileSync(join(preset, 'preset.yml'), 'name: Tiered routing\n')
  return { source, target, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test('syncTieredPreset installs the packaged preset into the discovery root', () => {
  const f = fixture()
  try {
    assert.equal(syncTieredPreset(f.source, f.target), 'synced')
    assert.equal(readFileSync(join(f.target, 'tiered', 'preset.yml'), 'utf8'), 'name: Tiered routing\n')
    assert.equal(syncTieredPreset(f.source, f.target), 'current')
  } finally { f.dispose() }
})

test('syncTieredPreset replaces stale owned files without touching sibling presets', () => {
  const f = fixture()
  try {
    syncTieredPreset(f.source, f.target)
    writeFileSync(join(f.target, 'tiered', 'stale.txt'), 'old\n')
    mkdirSync(join(f.target, 'custom'), { recursive: true })
    writeFileSync(join(f.target, 'custom', 'keep.txt'), 'mine\n')
    assert.equal(syncTieredPreset(f.source, f.target), 'synced')
    assert.equal(existsSync(join(f.target, 'tiered', 'stale.txt')), false)
    assert.equal(readFileSync(join(f.target, 'custom', 'keep.txt'), 'utf8'), 'mine\n')
  } finally { f.dispose() }
})

test('syncTieredPreset refuses a malformed bundled composition', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.source, 'tiered', 'agent.cordis.yml'), '- id: other\n  name: package\n')
    assert.throws(() => syncTieredPreset(f.source, f.target), /missing the dsh-tier-router row/)
  } finally { f.dispose() }
})
