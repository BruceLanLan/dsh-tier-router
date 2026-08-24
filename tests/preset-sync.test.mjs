import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

test('syncTieredPreset backs up a divergent user-owned preset instead of deleting it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tier-ps-'))
  try {
    const sourceRoot = join(root, 'package')
    const targetRoot = join(root, 'discovery')
    const sourceDir = join(sourceRoot, 'tiered')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'agent.cordis.yml'), '- id: tier-routing\n  name: dsh-tier-router\n')
    writeFileSync(join(sourceDir, 'preset.yml'), 'name: tiered\n')
    const targetDir = join(targetRoot, 'tiered')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'agent.cordis.yml'), '- id: tier-routing\n  name: dsh-tier-router\n  config: { custom: true }\n')
    writeFileSync(join(targetDir, 'preset.yml'), 'name: tiered\n')
    writeFileSync(join(targetDir, 'user-patch.txt'), 'mine\n')
    const outcome = syncTieredPreset(sourceRoot, targetRoot)
    assert.equal(outcome, 'synced')
    const backups = readdirSync(targetRoot).filter((n) => n.startsWith('tiered.backup-'))
    assert.equal(backups.length, 1, 'divergent user-owned preset is preserved as a backup')
    const backupDir = join(targetRoot, backups[0])
    assert.equal(readFileSync(join(backupDir, 'user-patch.txt'), 'utf8'), 'mine\n', 'user file survives in the backup')
    assert.equal(existsSync(join(targetDir, 'user-patch.txt')), false, 'stale user file is not in the synced tree')
    assert.equal(readFileSync(join(targetDir, 'agent.cordis.yml'), 'utf8').includes('custom'), false, 'synced tree matches the package')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncTieredPreset current install adopts the managed marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'tier-psm-'))
  try {
    const sourceRoot = join(root, 'package')
    const targetRoot = join(root, 'discovery')
    const sourceDir = join(sourceRoot, 'tiered')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'agent.cordis.yml'), '- id: tier-routing\n  name: dsh-tier-router\n')
    writeFileSync(join(sourceDir, 'preset.yml'), 'name: tiered\n')
    mkdirSync(join(targetRoot, 'tiered'), { recursive: true })
    writeFileSync(join(targetRoot, 'tiered', 'agent.cordis.yml'), '- id: tier-routing\n  name: dsh-tier-router\n')
    writeFileSync(join(targetRoot, 'tiered', 'preset.yml'), 'name: tiered\n')
    const outcome = syncTieredPreset(sourceRoot, targetRoot)
    assert.equal(outcome, 'current')
    assert.ok(existsSync(join(targetRoot, 'tiered', '.dsh-tier-router-managed')), 'matching target is adopted as managed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncTieredPreset replaces a divergent marked (package-managed) target in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'tier-psm2-'))
  try {
    const sourceRoot = join(root, 'package')
    const targetRoot = join(root, 'discovery')
    const sourceDir = join(sourceRoot, 'tiered')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'agent.cordis.yml'), '- id: tier-routing\n  name: dsh-tier-router\n')
    writeFileSync(join(sourceDir, 'preset.yml'), 'name: tiered\n')
    mkdirSync(join(targetRoot, 'tiered'), { recursive: true })
    writeFileSync(join(targetRoot, 'tiered', 'agent.cordis.yml'), '- id: tier-routing\n  name: dsh-tier-router\n  config: { custom: true }\n')
    writeFileSync(join(targetRoot, 'tiered', '.dsh-tier-router-managed'), 'managed\n')
    const outcome = syncTieredPreset(sourceRoot, targetRoot)
    assert.equal(outcome, 'synced')
    const backups = readdirSync(targetRoot).filter((n) => n.startsWith('tiered.backup-'))
    assert.equal(backups.length, 0, 'managed target is replaced without a backup')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
