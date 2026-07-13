#!/usr/bin/env node
// Bumps the stackcanvas release version in lockstep across every file that
// must agree on it, and refuses to run against a dirty git tree — a release
// commit should contain exactly the version bump, nothing else in flight.
// Source of truth for what must move together: docs/SPEC.md's Telemetry/CI/
// Release chapter, §5 ("npm release flow").
//
// Usage:
//   node scripts/bump-version.mjs <patch|minor|major|x.y.z>
//   node scripts/bump-version.mjs --help
//
// Files touched (all kept in lockstep):
//   - packages/mcp/package.json          "version"
//   - plugin/.claude-plugin/plugin.json  "version"
//   - packages/mcp/src/version.ts        export const VERSION = '...'
//   - plugin/.mcp.json                   mcpServers.stackcanvas.args pinned
//                                         to ["-y", "stackcanvas@<version>"]
//     (the release workflow ships whatever is pinned here — see
//     RELEASING.md; check-plugin.mjs accepts both the unpinned and the
//     pinned form, so this script owns the pin, not CI)
//   - packages/scan-aws/package.json     "version", once that package
//     exists — the two published packages version-lock (see RELEASING.md's
//     scan-aws extension path). No-op today; this file doesn't exist yet.
//
// Every write is a surgical regex replace of just the version text, so it
// never reformats the rest of a file (unlike JSON.stringify round-tripping,
// which would rewrite unrelated whitespace/array-layout choices).
//
// Prints the resulting version to stdout on success and exits 0. Exits 1
// with a clear message if:
//   - the git working tree has uncommitted changes (staged or unstaged)
//   - the bump spec is not one of patch|minor|major|x.y.z
//   - any target file is missing or doesn't match the expected shape

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const USAGE = `Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z>

Bumps the stackcanvas release version in lockstep across:
  packages/mcp/package.json
  plugin/.claude-plugin/plugin.json
  packages/mcp/src/version.ts
  plugin/.mcp.json                (pins the npx arg to stackcanvas@<version>)
  packages/scan-aws/package.json  (once that package exists)

Refuses to run if the git working tree has uncommitted changes (staged or
unstaged) — commit or stash first.

Examples:
  node scripts/bump-version.mjs patch     0.1.0 -> 0.1.1
  node scripts/bump-version.mjs minor     0.1.0 -> 0.2.0
  node scripts/bump-version.mjs major     0.1.0 -> 1.0.0
  node scripts/bump-version.mjs 0.2.0     explicit version
`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readJson(relPath) {
  const abs = path.join(root, relPath)
  if (!existsSync(abs)) fail(`bump-version: ${relPath} not found`)
  try {
    return JSON.parse(readFileSync(abs, 'utf8'))
  } catch (err) {
    fail(`bump-version: ${relPath} is not valid JSON (${err.message})`)
  }
}

// Replaces exactly one `"version": "x.y.z"` field's value in a JSON file's
// raw text, leaving every other byte (indentation, key order, comments-
// adjacent formatting) untouched.
function bumpJsonVersionField(relPath, nextVersion) {
  const abs = path.join(root, relPath)
  const src = readFileSync(abs, 'utf8')
  const re = /"version":\s*"[^"]*"/
  if (!re.test(src)) {
    fail(`bump-version: ${relPath} has no "version" field in the expected shape`)
  }
  writeFileSync(abs, src.replace(re, `"version": "${nextVersion}"`), 'utf8')
}

function assertCleanGitTree() {
  let status
  try {
    status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  } catch (err) {
    fail(`bump-version: failed to run "git status" (${err.message})`)
  }
  if (status.trim().length > 0) {
    fail(
      `bump-version: refusing to bump — git working tree is not clean:\n\n${status}\n` +
        `Commit or stash your changes first.`,
    )
  }
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/

function computeNextVersion(currentVersion, spec) {
  if (SEMVER_RE.test(spec)) return spec

  const m = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) fail(`bump-version: current version "${currentVersion}" is not valid semver (x.y.z)`)
  let [major, minor, patch] = m.slice(1).map(Number)

  switch (spec) {
    case 'patch':
      patch += 1
      break
    case 'minor':
      minor += 1
      patch = 0
      break
    case 'major':
      major += 1
      minor = 0
      patch = 0
      break
    default:
      fail(`bump-version: invalid version spec "${spec}" — expected patch|minor|major|x.y.z\n\n${USAGE}`)
  }
  return `${major}.${minor}.${patch}`
}

async function main() {
  const arg = process.argv[2]

  if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  }
  if (!arg) {
    console.error(USAGE)
    process.exit(1)
  }

  assertCleanGitTree()

  const mcpPackageJsonPath = 'packages/mcp/package.json'
  const pluginJsonPath = 'plugin/.claude-plugin/plugin.json'
  const versionTsPath = 'packages/mcp/src/version.ts'
  const mcpJsonPath = 'plugin/.mcp.json'
  const scanAwsPackageJsonPath = 'packages/scan-aws/package.json'

  const mcpPackageJson = readJson(mcpPackageJsonPath)
  const currentVersion = mcpPackageJson.version
  const nextVersion = computeNextVersion(currentVersion, arg)

  // 1. packages/mcp/package.json
  bumpJsonVersionField(mcpPackageJsonPath, nextVersion)

  // 2. plugin/.claude-plugin/plugin.json
  bumpJsonVersionField(pluginJsonPath, nextVersion)

  // 3. packages/mcp/src/version.ts — replace the exported literal only.
  const versionTsAbs = path.join(root, versionTsPath)
  const versionTsSrc = readFileSync(versionTsAbs, 'utf8')
  const versionTsRe = /export const VERSION = '[^']*'/
  if (!versionTsRe.test(versionTsSrc)) {
    fail(`bump-version: ${versionTsPath} does not contain "export const VERSION = '...'"`)
  }
  writeFileSync(versionTsAbs, versionTsSrc.replace(versionTsRe, `export const VERSION = '${nextVersion}'`), 'utf8')

  // 4. plugin/.mcp.json — pin the npx arg to stackcanvas@<version>. Accepts
  // both the unpinned "stackcanvas" and an already-pinned "stackcanvas@x.y.z"
  // as the starting shape (check-plugin.mjs allows either at rest).
  const mcpJsonAbs = path.join(root, mcpJsonPath)
  const mcpJsonSrc = readFileSync(mcpJsonAbs, 'utf8')
  const mcpJsonRe = /"args":\s*\[\s*"-y",\s*"stackcanvas(?:@[^"]*)?"\s*\]/
  if (!mcpJsonRe.test(mcpJsonSrc)) {
    fail(`bump-version: ${mcpJsonPath} args are not in the expected ["-y", "stackcanvas[@x.y.z]"] shape`)
  }
  writeFileSync(mcpJsonAbs, mcpJsonSrc.replace(mcpJsonRe, `"args": ["-y", "stackcanvas@${nextVersion}"]`), 'utf8')

  // 5. packages/scan-aws/package.json — version-locked once it exists.
  if (existsSync(path.join(root, scanAwsPackageJsonPath))) {
    bumpJsonVersionField(scanAwsPackageJsonPath, nextVersion)
  }

  console.log(nextVersion)
}

await main()
