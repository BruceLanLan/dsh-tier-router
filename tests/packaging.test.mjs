// Packaging regression tests: protect other users from install-breaking
// mistakes (e.g. a comment-only cordis.patch.yml that makes every dsh boot
// exit immediately, or a missing shipped preset).
// Run with: node --test tests/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('cordis.patch.yml is a top-level YAML array (never comment-only)', () => {
  const text = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const first = text.split('\n').find((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  assert.ok(first !== undefined, 'patch file has a non-comment line')
  assert.ok(first.trim() === '[]' || first.trim().startsWith('- '), 'first entry is an array marker: ' + first)
})

test('cordis.patch.yml documents the preset install path', () => {
  const text = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(text.includes('agent preset'), 'mentions the agent preset install path')
  const code = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.ok(!code.includes('- id: tier-routing'), 'ships no host insert row by design')
})

test('shipped agent-presets/tiered preset contains the tier-routing row', () => {
  const dir = join(ROOT, 'agent-presets', 'tiered')
  assert.ok(existsSync(join(dir, 'agent.cordis.yml')), 'agent.cordis.yml exists')
  assert.ok(existsSync(join(dir, 'preset.yml')), 'preset.yml exists')
  const comp = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
  assert.ok(comp.includes('- id: tier-routing'), 'tier-routing row present')
  assert.ok(comp.includes('name: dsh-tier-router'), 'tier-routing row names the package')
  const meta = readFileSync(join(dir, 'preset.yml'), 'utf8')
  assert.ok(meta.includes('name:'), 'preset.yml has a name')
  assert.ok(meta.includes('description:'), 'preset.yml has a description')
})

test('package.json ships lib, patch, and the preset in files', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.ok(pkg.files.includes('agent-presets'))
  assert.ok(pkg.type === 'module')
})
