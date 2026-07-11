import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import {
  applyPlan, parseState,
  type AgentStatus, type GraphModel, type Intent,
} from '@stackcanvas/core'
import { findPort } from './find-port.js'

const execFileAsync = promisify(execFile)

export type TerraformShowRunner = (cwd: string, planPath?: string) => Promise<string>

export const defaultRunner: TerraformShowRunner = async (cwd, planPath) => {
  const args = ['show', '-json', ...(planPath ? [planPath] : [])]
  try {
    const { stdout } = await execFileAsync('terraform', args, { cwd, maxBuffer: 256 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT')
      throw new Error('terraform binary not found in PATH. Install Terraform or add it to PATH.')
    throw new Error(`terraform show failed: ${(err as Error).message}`)
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
}

export interface CanvasServerOptions {
  dir: string
  uiDist?: string
  runTerraformShow?: TerraformShowRunner
  port?: number
}

export class CanvasServer {
  readonly dir: string
  private uiDist?: string
  private run: TerraformShowRunner
  private fixedPort?: number
  private graph: GraphModel = { nodes: [], edges: [], groups: [] }
  private planJson: unknown = null
  private stale: string | null = null
  private httpServer: ServerType | null = null
  private onGraphChange: Array<(g: GraphModel, stale: string | null) => void> = []

  constructor(opts: CanvasServerOptions) {
    this.dir = opts.dir
    this.uiDist = opts.uiDist
    this.run = opts.runTerraformShow ?? defaultRunner
    this.fixedPort = opts.port
  }

  getGraph(): GraphModel { return this.graph }
  getStale(): string | null { return this.stale }
  subscribe(fn: (g: GraphModel, stale: string | null) => void): void { this.onGraphChange.push(fn) }

  async refreshGraph(): Promise<void> {
    try {
      const stateJson = JSON.parse(await this.run(this.dir))
      let g = parseState(stateJson)
      if (this.planJson) g = applyPlan(g, this.planJson)
      this.graph = g
      this.stale = null
    } catch (err) {
      this.stale = (err as Error).message
    }
    for (const fn of this.onGraphChange) fn(this.graph, this.stale)
  }

  protected buildApp(): Hono {
    const app = new Hono()
    app.get('/api/graph', c => c.json(this.graph))
    app.get('/api/meta', c => c.json({ dir: this.dir, stale: this.stale }))
    if (this.uiDist) {
      const dist = resolve(this.uiDist)
      app.get('*', c => {
        const decoded = decodeURIComponent(c.req.path)
        const reqPath = decoded === '/' ? '/index.html' : decoded
        const file = resolve(dist, '.' + reqPath)
        const contained = file === dist || file.startsWith(dist + sep)
        if (contained && existsSync(file) && statSync(file).isFile()) {
          return c.body(readFileSync(file), 200, {
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          })
        }
        return c.body(readFileSync(join(dist, 'index.html')), 200, { 'content-type': 'text/html' })
      })
    }
    return app
  }

  async start(): Promise<{ port: number; url: string }> {
    if (this.httpServer) throw new Error('CanvasServer already started')
    if (!existsSync(this.dir)) throw new Error(`Directory not found: ${this.dir}`)
    await this.refreshGraph()
    const port = this.fixedPort ?? (await findPort(4680))
    const app = this.buildApp()
    this.httpServer = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
    return { port, url: `http://127.0.0.1:${port}` }
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => {
      if (!this.httpServer) return resolve()
      const srv = this.httpServer as unknown as { closeAllConnections?: () => void; close: (cb: () => void) => void }
      srv.closeAllConnections?.()
      srv.close(() => resolve())
    })
    this.httpServer = null
  }
}
