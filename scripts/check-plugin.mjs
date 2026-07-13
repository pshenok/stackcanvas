#!/usr/bin/env node
// Validates the Claude Code plugin manifests are internally consistent and
// marketplace-ready. Run via `node scripts/check-plugin.mjs`.
//
// Checks:
//  1. plugin/.claude-plugin/plugin.json has required fields (name, description,
//     version, author).
//  2. plugin/.mcp.json's stackcanvas server runs via `npx -y stackcanvas` or
//     `npx -y stackcanvas@<semver>` (the release workflow pins the version at
//     tag time — both forms must stay valid).
//  3. plugin.json's version matches packages/mcp/package.json's version.
//  4. plugin/skills/stackcanvas/SKILL.md exists and has frontmatter with a
//     non-empty `name` and `description`.
//  5. packages/mcp/src/version.ts's exported VERSION matches
//     packages/mcp/package.json's version (the runtime constant used for the
//     MCP protocol version and telemetry's app_version — see version.ts's
//     own header comment).
//  6. packages/scan-aws/package.json's version matches packages/mcp's,
//     once that package exists (the two published packages version-lock;
//     see RELEASING.md's scan-aws extension path). No-op today.
//
// Exits 1 with a clear, diff-style message on any failure.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const errors = []

function readJson(relPath) {
  const abs = path.join(root, relPath)
  if (!existsSync(abs)) {
    errors.push(`${relPath}: file not found`)
    return null
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'))
  } catch (err) {
    errors.push(`${relPath}: invalid JSON (${err.message})`)
    return null
  }
}

// --- 1. plugin.json required fields -----------------------------------
const pluginJsonPath = 'plugin/.claude-plugin/plugin.json'
const pluginJson = readJson(pluginJsonPath)

const REQUIRED_PLUGIN_FIELDS = ['name', 'description', 'version', 'author']
if (pluginJson) {
  for (const field of REQUIRED_PLUGIN_FIELDS) {
    const value = pluginJson[field]
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (field === 'author' && (typeof value !== 'object' || !value.name))
    if (missing) {
      errors.push(`${pluginJsonPath}: missing required field "${field}"`)
    }
  }
}

// --- 2. plugin/.mcp.json command shape ---------------------------------
const mcpJsonPath = 'plugin/.mcp.json'
const mcpJson = readJson(mcpJsonPath)

// Accepts "stackcanvas" or "stackcanvas@<semver>" (the release workflow
// rewrites the unpinned form to the pinned one at tag time).
const PACKAGE_SPEC_RE = /^stackcanvas(@\d+\.\d+\.\d+.*)?$/

if (mcpJson) {
  const server = mcpJson.mcpServers?.stackcanvas
  if (!server) {
    errors.push(`${mcpJsonPath}: missing mcpServers.stackcanvas entry`)
  } else {
    if (server.command !== 'npx') {
      errors.push(
        `${mcpJsonPath}: mcpServers.stackcanvas.command must be "npx", got ${JSON.stringify(server.command)}`,
      )
    }
    const args = server.args
    const packageSpec = Array.isArray(args) ? args[1] : undefined
    const argsOk =
      Array.isArray(args) &&
      args.length === 2 &&
      args[0] === '-y' &&
      typeof packageSpec === 'string' &&
      PACKAGE_SPEC_RE.test(packageSpec)
    if (!argsOk) {
      errors.push(
        `${mcpJsonPath}: mcpServers.stackcanvas.args must be ["-y", "stackcanvas"] or ["-y", "stackcanvas@<semver>"], got ${JSON.stringify(args)}`,
      )
    }
  }
}

// --- 3. version sync -----------------------------------------------------
const mcpPackageJsonPath = 'packages/mcp/package.json'
const mcpPackageJson = readJson(mcpPackageJsonPath)

if (pluginJson && mcpPackageJson) {
  if (pluginJson.version !== mcpPackageJson.version) {
    errors.push(
      `version mismatch:\n` +
        `  - ${pluginJsonPath}: ${JSON.stringify(pluginJson.version)}\n` +
        `  + ${mcpPackageJsonPath}: ${JSON.stringify(mcpPackageJson.version)}`,
    )
  }
}

// --- 4. SKILL.md frontmatter --------------------------------------------
const skillPath = 'plugin/skills/stackcanvas/SKILL.md'
const skillAbsPath = path.join(root, skillPath)

if (!existsSync(skillAbsPath)) {
  errors.push(`${skillPath}: file not found`)
} else {
  const content = readFileSync(skillAbsPath, 'utf8')
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) {
    errors.push(`${skillPath}: missing YAML frontmatter (--- ... ---)`)
  } else {
    const frontmatter = {}
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
      if (kv) frontmatter[kv[1]] = kv[2].trim()
    }
    for (const field of ['name', 'description']) {
      if (!frontmatter[field]) {
        errors.push(`${skillPath}: frontmatter missing required field "${field}"`)
      }
    }
  }
}

// --- 5. version.ts sync ---------------------------------------------------
const versionTsPath = 'packages/mcp/src/version.ts'
const versionTsAbsPath = path.join(root, versionTsPath)

if (!existsSync(versionTsAbsPath)) {
  errors.push(`${versionTsPath}: file not found`)
} else {
  const versionTsSrc = readFileSync(versionTsAbsPath, 'utf8')
  const match = versionTsSrc.match(/export const VERSION = '([^']*)'/)
  if (!match) {
    errors.push(`${versionTsPath}: missing "export const VERSION = '...'" export`)
  } else if (mcpPackageJson && match[1] !== mcpPackageJson.version) {
    errors.push(
      `version mismatch:\n` +
        `  - ${versionTsPath}: ${JSON.stringify(match[1])}\n` +
        `  + ${mcpPackageJsonPath}: ${JSON.stringify(mcpPackageJson.version)}`,
    )
  }
}

// --- 6. scan-aws version lock (once that package exists) -----------------
const scanAwsPackageJsonPath = 'packages/scan-aws/package.json'
if (existsSync(path.join(root, scanAwsPackageJsonPath))) {
  const scanAwsPackageJson = readJson(scanAwsPackageJsonPath)
  if (scanAwsPackageJson && mcpPackageJson && scanAwsPackageJson.version !== mcpPackageJson.version) {
    errors.push(
      `version mismatch:\n` +
        `  - ${scanAwsPackageJsonPath}: ${JSON.stringify(scanAwsPackageJson.version)}\n` +
        `  + ${mcpPackageJsonPath}: ${JSON.stringify(mcpPackageJson.version)}`,
    )
  }
}

// --- report ---------------------------------------------------------------
if (errors.length > 0) {
  console.error(`check-plugin: ${errors.length} problem(s) found:\n`)
  for (const err of errors) {
    console.error(`  ✘ ${err}`)
  }
  console.error('')
  process.exit(1)
}

console.log('check-plugin: all checks passed')
