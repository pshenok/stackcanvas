import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CanvasServer, TelemetryClient } from '@stackcanvas/server'
import { createMcpServer } from './server.js'
import { VERSION } from './version.js'

const uiDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui-dist')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  // One TelemetryClient per process, shared across both entry points below.
  // Constructing it here (rather than letting CanvasServer default-construct
  // its own per-instance client) is what lets install/canvas_opened/
  // intent_sent reach the real collector with the real published version,
  // for both `stackcanvas serve` and the MCP stdio path — see docs/SPEC.md's
  // Telemetry chapter (M1-6 / issue #10). Consent gating inside
  // TelemetryClient is what actually keeps this silent by default.
  const telemetry = new TelemetryClient({ appVersion: VERSION })

  if (process.argv[2] === 'serve') {
    const dir = arg('dir') ?? process.cwd()
    const fixture = arg('fixture')
    const port = arg('port')
    const tfBin = arg('tf-bin')
    if (port !== undefined && Number.isNaN(Number(port))) {
      console.error('invalid --port')
      process.exit(1)
    }
    const server = new CanvasServer({
      dir,
      uiDist,
      port: port ? Number(port) : undefined,
      runTerraformShow: fixture ? async () => readFileSync(fixture, 'utf8') : undefined,
      tfBinary: tfBin,
      telemetry,
    })
    const { url } = await server.start()
    console.log(`stackcanvas serving ${dir} at ${url}`)
    return
  }
  const mcp = createMcpServer({
    makeCanvas: dir => new CanvasServer({ dir, uiDist, telemetry }),
  })
  await mcp.connect(new StdioServerTransport())
}

void main()
