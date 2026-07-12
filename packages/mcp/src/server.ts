import { existsSync, readdirSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { summarizeGraph } from '@stackcanvas/core'
import { CanvasServer } from '@stackcanvas/server'
import { z } from 'zod'
import { openBrowser as defaultOpenBrowser } from './open-browser.js'

function looksLikeTerraformRoot(dir: string): boolean {
  if (!existsSync(dir)) return false
  const entries = readdirSync(dir)
  return entries.some(f => f.endsWith('.tf') || f.endsWith('.tfstate'))
}

const ok = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }] })
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true })

export interface McpDeps {
  makeCanvas?: (dir: string) => CanvasServer
  openBrowser?: (url: string) => void
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const makeCanvas = deps.makeCanvas ?? ((dir: string) => new CanvasServer({ dir }))
  const open = deps.openBrowser ?? defaultOpenBrowser
  let canvas: CanvasServer | null = null
  let url: string | null = null

  const mcp = new McpServer({ name: 'stackcanvas', version: '0.1.0' })

  mcp.registerTool('open_canvas', {
    description:
      'Start (or reuse) the stackcanvas live infrastructure canvas for a Terraform root directory. '
      + 'Opens the UI in the browser and returns its URL.',
    inputSchema: { dir: z.string().describe('Absolute path to the Terraform root directory') },
  }, async ({ dir }) => {
    if (!looksLikeTerraformRoot(dir))
      return fail(`${dir} does not look like a Terraform root (no .tf or .tfstate files). `
        + 'Pass the directory that contains the Terraform configuration.')
    if (canvas && canvas.dir !== dir) { await canvas.stop(); canvas = null }
    if (!canvas) {
      const next = makeCanvas(dir)
      try {
        const started = await next.start()
        url = started.url
      } catch (err) {
        await next.stop().catch(() => {})
        return fail(`Failed to start canvas: ${(err as Error).message}`)
      }
      canvas = next
      canvas.setAgentStatus('idle')
      open(url)
    }
    return ok(`Canvas running at ${url}. The graph live-updates as tfstate changes. `
      + 'Run `terraform plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json` '
      + 'to show the plan diff, then call await_canvas_intent to receive user edits.')
  })

  mcp.registerTool('load_plan', {
    description: 'Register a Terraform plan for diff highlighting on the canvas. '
      + 'Accepts a JSON plan (terraform show -json output) or a binary plan file.',
    inputSchema: { path: z.string().describe('Path to plan file (.json preferred)') },
  }, async ({ path }) => {
    if (!canvas) return fail('No canvas open. Call open_canvas first.')
    canvas.setAgentStatus('planning')
    try {
      await canvas.loadPlan(path)
      return ok('Plan loaded; canvas now highlights pending changes.')
    } catch (err) {
      return fail(`Failed to load plan: ${(err as Error).message}`)
    } finally {
      canvas.setAgentStatus('idle')
    }
  })

  mcp.registerTool('get_graph_summary', {
    description: 'Get a compact text summary of the current infrastructure graph.',
    inputSchema: {},
  }, async () => {
    if (!canvas) return fail('No canvas open. Call open_canvas first.')
    return ok(summarizeGraph(canvas.getGraph()))
  })

  mcp.registerTool('await_canvas_intent', {
    description: 'Block until the user clicks Apply on the canvas, then return their requested '
      + 'changes as intent JSON: {intent: {add, modify, remove} | null}. null = timeout, call again '
      + 'in a loop to keep waiting. After receiving an intent, write the Terraform code for it.',
    inputSchema: {
      timeoutSeconds: z.number().positive().max(3600).default(45)
        .describe('How long to wait before returning {intent: null}. Default 45s: MCP clients '
          + 'commonly abort requests after 60s, so keep this under your client\'s request timeout '
          + 'and call the tool in a loop instead of passing large values.'),
    },
  }, async ({ timeoutSeconds }) => {
    if (!canvas) return fail('No canvas open. Call open_canvas first.')
    canvas.setAgentStatus('idle')
    const intent = await canvas.awaitIntent(timeoutSeconds * 1000)
    if (intent) canvas.setAgentStatus('writing')
    return ok(JSON.stringify({ intent }))
  })

  return mcp
}
