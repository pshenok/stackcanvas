#!/usr/bin/env node
// scripts/mcp-smoke.mjs — keyless MCP smoke test (docs/SPEC.md §3.2 PR#9 /
// M1-9, issue #13).
//
// Spawns the built `stackcanvas` MCP server (packages/mcp/dist/cli.js) over
// real stdio, performs the actual MCP `initialize` handshake via the SDK's
// Client + StdioClientTransport, then exercises all four tools end-to-end:
//
//   1. tools/list  — asserts exactly the 4 expected tools, each with a
//      non-empty description.
//   2. open_canvas — against a throwaway temp dir containing only a
//      `main.tf` (no real Terraform config, no `terraform` binary
//      required). The canvas may report a stale/terraform-missing state —
//      that's fine and expected; we only assert the tool returns a URL.
//   3. GET <url>/api/graph — asserts HTTP 200.
//   4. get_graph_summary — asserts non-empty text.
//
// No ANTHROPIC_API_KEY needed: this only checks the MCP transport/protocol
// layer (SDK compat, tool registration, wiring), not an LLM. That's what
// makes it safe to run on every PR (see .github/workflows/claude-smoke.yml's
// `mcp-smoke` job) — the keyed `claude-keyed` job in the same workflow is
// the separate, weekly, LLM-in-the-loop canary.
//
// Usage: node scripts/mcp-smoke.mjs
//   - If packages/mcp/dist/cli.js is missing, this builds it first via
//     `pnpm build:pkg`. If it's already present (e.g. CI already ran
//     `build:pkg`), the existing dist is used as-is.
//   - STACKCANVAS_CONFIG_DIR is pointed at a fresh temp dir so telemetry
//     consent is always 'unset' here and TelemetryClient.emit() is a
//     provable no-op — no real ~/.stackcanvas is ever touched, and
//     DO_NOT_TRACK=1 is set as a second, redundant guarantee.
//   - The whole script is bounded by a 120s timeout; the child is always
//     killed on the way out (success, failure, or timeout).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const mcpPkgDir = join(root, 'packages', 'mcp')
const cliPath = join(mcpPkgDir, 'dist', 'cli.js')

const TIMEOUT_MS = 120_000
const EXPECTED_TOOLS = ['await_canvas_intent', 'get_graph_summary', 'load_plan', 'open_canvas']

function log(msg) {
  console.error(`[mcp-smoke] ${msg}`)
}

function ensureBuilt() {
  if (existsSync(cliPath)) {
    log(`using existing build: ${cliPath}`)
    return
  }
  log('packages/mcp/dist/cli.js not found — building via `pnpm build:pkg`...')
  const result = spawnSync('npx', ['pnpm@9', 'build:pkg'], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`pnpm build:pkg failed (exit ${result.status})`)
  if (!existsSync(cliPath)) throw new Error(`build:pkg finished but ${cliPath} is still missing`)
}

// The MCP SDK is a dependency of packages/mcp (`@stackcanvas/mcp`'s
// package.json), not of the repo root — this script lives in scripts/,
// outside that package's node_modules resolution scope, so a bare
// `import '@modelcontextprotocol/sdk/...'` from here would fail. Anchoring
// a require() at packages/mcp/package.json resolves it correctly (pnpm
// hoists/symlinks it into packages/mcp/node_modules), without a NODE_PATH
// hack or a second package.json for this script.
async function loadSdk() {
  const require = createRequire(pathToFileURL(join(mcpPkgDir, 'package.json')).href)
  const clientIndexPath = require.resolve('@modelcontextprotocol/sdk/client/index.js')
  const stdioPath = require.resolve('@modelcontextprotocol/sdk/client/stdio.js')
  const { Client } = await import(pathToFileURL(clientIndexPath).href)
  const { StdioClientTransport } = await import(pathToFileURL(stdioPath).href)
  return { Client, StdioClientTransport }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function textOf(result) {
  return (result.content ?? []).map(c => c.text ?? '').join('\n')
}

async function main() {
  ensureBuilt()
  const { Client, StdioClientTransport } = await loadSdk()

  const configDir = mkdtempSync(join(tmpdir(), 'stackcanvas-smoke-config-'))
  // Not a real Terraform config — just needs a *.tf file to pass
  // looksLikeTerraformRoot() in packages/mcp/src/server.ts. No `terraform`
  // binary is required on PATH: if absent, refreshGraph() swallows the
  // failure into the graph's `stale` field and open_canvas still returns a
  // URL, which is the documented, acceptable outcome for this smoke.
  const fixtureDir = mkdtempSync(join(tmpdir(), 'stackcanvas-smoke-fixture-'))
  writeFileSync(join(fixtureDir, 'main.tf'), '# mcp-smoke fixture — never applied\n')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    env: { ...process.env, STACKCANVAS_CONFIG_DIR: configDir, DO_NOT_TRACK: '1' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' })
  const stderrChunks = []
  transport.stderr?.on('data', chunk => stderrChunks.push(chunk))

  try {
    log(`spawning: ${process.execPath} ${cliPath}`)
    await client.connect(transport) // performs the MCP `initialize` handshake

    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    const expected = [...EXPECTED_TOOLS].sort()
    if (names.length !== expected.length || !names.every((n, i) => n === expected[i]))
      throw new Error(`tools/list mismatch: expected [${expected.join(', ')}], got [${names.join(', ')}]`)
    for (const tool of tools)
      if (!tool.description?.trim()) throw new Error(`tool "${tool.name}" has an empty description`)
    log(`tools/list OK: ${names.join(', ')}`)

    const openResult = await client.callTool({ name: 'open_canvas', arguments: { dir: fixtureDir } })
    if (openResult.isError) throw new Error(`open_canvas returned an error: ${textOf(openResult)}`)
    const urlMatch = textOf(openResult).match(/https?:\/\/127\.0\.0\.1:\d+/)
    if (!urlMatch) throw new Error(`open_canvas did not return a URL. Got: ${textOf(openResult)}`)
    const url = urlMatch[0]
    log(`open_canvas OK: ${url}`)

    const graphRes = await fetch(`${url}/api/graph`)
    if (graphRes.status !== 200) throw new Error(`GET ${url}/api/graph returned ${graphRes.status}`)
    await graphRes.json() // confirms the body is well-formed JSON
    log('GET /api/graph OK (200)')

    const summaryResult = await client.callTool({ name: 'get_graph_summary', arguments: {} })
    if (summaryResult.isError) throw new Error(`get_graph_summary returned an error: ${textOf(summaryResult)}`)
    const summaryText = textOf(summaryResult)
    if (!summaryText.trim()) throw new Error('get_graph_summary returned empty text')
    log(`get_graph_summary OK: ${summaryText.slice(0, 120)}${summaryText.length > 120 ? '…' : ''}`)

    log('all checks passed')
  } finally {
    // client.close() -> transport.close() already ends stdin then
    // SIGTERM/SIGKILLs the child if it doesn't exit on its own (see the SDK's
    // StdioClientTransport.close()). The direct kill below is a fallback for
    // the case where construction/connect() failed before that path ran.
    await client.close().catch(() => {})
    if (transport.pid) {
      try { process.kill(transport.pid, 'SIGKILL') } catch { /* already dead */ }
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(fixtureDir, { recursive: true, force: true })
    if (stderrChunks.length && process.env.MCP_SMOKE_VERBOSE)
      log(`child stderr:\n${Buffer.concat(stderrChunks).toString('utf8')}`)
  }
}

withTimeout(main(), TIMEOUT_MS, 'mcp-smoke')
  .then(() => { log('PASS'); process.exit(0) })
  .catch((err) => { console.error(`[mcp-smoke] FAIL: ${err.message}`); process.exit(1) })
