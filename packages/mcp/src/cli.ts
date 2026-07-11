import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CanvasServer } from '@stackcanvas/server'
import { createMcpServer } from './server.js'

const uiDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui-dist')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  if (process.argv[2] === 'serve') {
    const dir = arg('dir') ?? process.cwd()
    const fixture = arg('fixture')
    const port = arg('port')
    if (port !== undefined && Number.isNaN(Number(port))) {
      console.error('invalid --port')
      process.exit(1)
    }
    const server = new CanvasServer({
      dir,
      uiDist,
      port: port ? Number(port) : undefined,
      runTerraformShow: fixture ? async () => readFileSync(fixture, 'utf8') : undefined,
    })
    const { url } = await server.start()
    console.log(`stackcanvas serving ${dir} at ${url}`)
    return
  }
  const mcp = createMcpServer({
    makeCanvas: dir => new CanvasServer({ dir, uiDist }),
  })
  await mcp.connect(new StdioServerTransport())
}

void main()
