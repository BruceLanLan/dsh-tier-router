// Host-side preset discovery support for dsh-tier-router.
//
// A profile bundle is loaded before any agent exists. It synchronizes only this
// package-owned preset into DSH's user discovery root; the preset itself still
// owns all agent-plane routing tools and listeners.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

const PRESET_ID = 'tiered'

function dshHome(env = process.env, home = homedir()) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (!raw) return join(home, '.dsh')
  const expanded = raw === '~' ? home : (raw.startsWith('~/') || raw.startsWith('~\\') ? join(home, raw.slice(2)) : raw)
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
}

function filesUnder(root) {
  const files = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push(path)
      else throw new Error('unsupported preset entry: ' + path)
    }
  }
  visit(root)
  return files
}

function validateSource(sourceDir) {
  const composition = join(sourceDir, 'agent.cordis.yml')
  const metadata = join(sourceDir, 'preset.yml')
  if (!existsSync(composition) || !existsSync(metadata)) throw new Error('bundled tiered preset is missing agent.cordis.yml or preset.yml')
  const text = readFileSync(composition, 'utf8')
  if (!text.includes('- id: tier-routing') || !text.includes('name: dsh-tier-router')) {
    throw new Error('bundled tiered preset is missing the dsh-tier-router row')
  }
}

function copyTree(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry)
    const target = join(targetDir, entry)
    const stat = statSync(source)
    if (stat.isDirectory()) copyTree(source, target)
    else if (stat.isFile()) copyFileSync(source, target)
    else throw new Error('unsupported preset entry: ' + source)
  }
}

function sameTree(sourceDir, targetDir) {
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) return false
  const source = filesUnder(sourceDir).map((file) => relative(sourceDir, file)).filter((file) => file !== MANAGED_MARKER).sort()
  const target = filesUnder(targetDir).map((file) => relative(targetDir, file)).filter((file) => file !== MANAGED_MARKER).sort()
  if (source.length !== target.length || source.some((file, index) => file !== target[index])) return false
  return source.every((file) => readFileSync(join(sourceDir, file)).equals(readFileSync(join(targetDir, file))))
}

/** Marker file proving a target preset directory is package-managed. */
const MANAGED_MARKER = '.dsh-tier-router-managed'

function markerPath(targetDir) {
  return join(targetDir, MANAGED_MARKER)
}

function writeMarker(targetDir) {
  try { writeFileSync(markerPath(targetDir), 'managed by dsh-tier-router\n') } catch (e) {}
}

function hasMarker(targetDir) {
  try { return existsSync(markerPath(targetDir)) } catch (e) { return false }
}

/**
 * Synchronize the package-owned tiered preset into DSH's user discovery root.
 * The operation is idempotent and never touches any other preset directory.
 *
 * Ownership model: a target directory carrying the managed marker belongs to
 * the package and may be replaced in place. A divergent target WITHOUT the
 * marker is treated as user-owned: it is moved to `tiered.backup-<timestamp>`
 * (never silently deleted) before the package copy lands, so a customized
 * preset survives the sync and a human can merge or restore it.
 */
export function syncTieredPreset(sourceRoot, targetRoot) {
  const sourceDir = join(sourceRoot, PRESET_ID)
  const targetDir = join(targetRoot, PRESET_ID)
  validateSource(sourceDir)
  mkdirSync(targetRoot, { recursive: true })
  if (sameTree(sourceDir, targetDir)) {
    writeMarker(targetDir)
    return 'current'
  }
  if (existsSync(targetDir) && !hasMarker(targetDir)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(targetRoot, PRESET_ID + '.backup-' + stamp)
    mkdirSync(targetRoot, { recursive: true })
    rmSync(backupDir, { recursive: true, force: true })
    copyTree(targetDir, backupDir)
    rmSync(targetDir, { recursive: true, force: true })
  }
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
  copyTree(sourceDir, targetDir)
  writeMarker(targetDir)
  if (!sameTree(sourceDir, targetDir)) throw new Error('tiered preset verification failed after sync')
  return 'synced'
}

export function syncInstalledTieredPreset(sourceRoot, env = process.env, home = homedir()) {
  return syncTieredPreset(sourceRoot, join(dshHome(env, home), '.agent-presets'))
}
