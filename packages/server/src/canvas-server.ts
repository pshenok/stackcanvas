import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  applyPlan, parseState,
  type AgentStatus, type GraphModel, type Intent,
} from '@stackcanvas/core'
import { findPort } from './find-port.js'
import { IntentQueue } from './intent-queue.js'

const execFileAsync = promisify(execFile)

const intentSchema = z.object({
  add: z.array(z.object({
    type: z.string().min(1),
    name: z.string().optional(),
    wishes: z.string().optional(),
    connect_to: z.array(z.string()),
  })),
  modify: z.array(z.object({ address: z.string().min(1), wishes: z.string() })),
  remove: z.array(z.object({ address: z.string().min(1) })),
})

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
  /** First port findPort probes when no fixed port is given (default 4680).
   *  Tests use distinct bases so parallel suites never contend. */
  portRangeStart?: number
}

export class CanvasServer {
  readonly dir: string
  private uiDist?: string
  private run: TerraformShowRunner
  private fixedPort?: number
  private portRangeStart: number
  private graph: GraphModel = { nodes: [], edges: [], groups: [] }
  private planJson: unknown = null
  private stale: string | null = null
  private httpServer: ServerType | null = null
  private onGraphChange: Array<(g: GraphModel, stale: string | null) => void> = []
  private wss: WebSocketServer | null = null
  private watcher: FSWatcher | null = null
  private planPath: string | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private intents = new IntentQueue()
  private agentStatus: AgentStatus = 'idle'

  constructor(opts: CanvasServerOptions) {
    this.dir = opts.dir
    this.uiDist = opts.uiDist
    this.run = opts.runTerraformShow ?? defaultRunner
    this.fixedPort = opts.port
    this.portRangeStart = opts.portRangeStart ?? 4680
    this.subscribe((graph, stale) => this.broadcast({ type: 'graph', graph, stale }))
  }

  getGraph(): GraphModel { return this.graph }
  getStale(): string | null { return this.stale }
  subscribe(fn: (g: GraphModel, stale: string | null) => void): void { this.onGraphChange.push(fn) }

  awaitIntent(timeoutMs: number): Promise<Intent | null> { return this.intents.take(timeoutMs) }

  setAgentStatus(s: AgentStatus): void {
    this.agentStatus = s
    this.broadcast({ type: 'agent_status', status: s })
  }

  async loadPlan(path: string): Promise<void> {
    if (path.endsWith('.json')) this.planJson = JSON.parse(readFileSync(path, 'utf8'))
    else this.planJson = JSON.parse(await this.run(this.dir, path))
    this.planPath = path
    await this.refreshGraph()
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      void (async () => {
        try {
          const autoPlan = join(this.dir, '.stackcanvas', 'plan.json')
          if (this.planPath === null && existsSync(autoPlan)) await this.loadPlan(autoPlan)
          else if (this.planPath?.endsWith('.json') && existsSync(this.planPath))
            this.planJson = JSON.parse(readFileSync(this.planPath, 'utf8'))
          await this.refreshGraph()
        } catch (err) {
          this.stale = (err as Error).message
          for (const fn of this.onGraphChange) fn(this.graph, this.stale)
        }
      })()
    }, 300)
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg)
    for (const client of this.wss?.clients ?? [])
      if (client.readyState === WebSocket.OPEN) client.send(data)
  }

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
    app.post('/api/intent', async c => {
      const parsed = intentSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid intent' }, 400)
      this.intents.push(parsed.data)
      return c.json({ queued: true }, 202)
    })
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

  private bindServer(port: number, app: Hono): Promise<ServerType> {
    return new Promise((resolve, reject) => {
      const srv = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
      const onError = (err: Error): void => {
        srv.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        srv.removeListener('error', onError)
        resolve(srv)
      }
      srv.once('error', onError)
      srv.once('listening', onListening)
    })
  }

  async start(): Promise<{ port: number; url: string }> {
    if (this.httpServer) throw new Error('CanvasServer already started')
    if (!existsSync(this.dir)) throw new Error(`Directory not found: ${this.dir}`)
    await this.refreshGraph()
    const explicitPort = this.fixedPort !== undefined
    let port = this.fixedPort ?? (await findPort(this.portRangeStart))
    const app = this.buildApp()
    const maxAttempts = 10
    let httpServer: ServerType | undefined
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        httpServer = await this.bindServer(port, app)
        break
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'EADDRINUSE' && !explicitPort && attempt < maxAttempts - 1) {
          port++
          continue
        }
        throw err
      }
    }
    this.httpServer = httpServer!
    this.wss = new WebSocketServer({ noServer: true })
    this.httpServer.on('upgrade', (req, socket, head) => {
      if (req.url === '/ws') {
        this.wss!.handleUpgrade(req, socket, head, ws => {
          ws.send(JSON.stringify({ type: 'graph', graph: this.graph, stale: this.stale }))
          ws.send(JSON.stringify({ type: 'agent_status', status: this.agentStatus }))
        })
      } else socket.destroy()
    })
    // chokidar v4 dropped glob support, so watch `dir` recursively and filter
    // in `ignored` instead of passing glob patterns (which silently match nothing).
    const planPath = join(this.dir, '.stackcanvas', 'plan.json')
    this.watcher = chokidar.watch(this.dir, {
      ignoreInitial: true,
      ignored: (path, stats) => {
        if (path.includes(`${sep}.terraform${sep}`) || path.endsWith(`${sep}.terraform`)) return true
        if (stats && !stats.isDirectory() && !path.endsWith('.tfstate') && path !== planPath) return true
        return false
      },
    })
    this.watcher.on('all', () => this.scheduleRefresh())
    return { port, url: `http://127.0.0.1:${port}` }
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    await this.watcher?.close()
    this.watcher = null
    for (const c of this.wss?.clients ?? []) c.terminate()
    this.wss?.close()
    this.wss = null
    await new Promise<void>(resolve => {
      if (!this.httpServer) return resolve()
      const srv = this.httpServer as unknown as { closeAllConnections?: () => void; close: (cb: () => void) => void }
      srv.closeAllConnections?.()
      srv.close(() => resolve())
    })
    this.httpServer = null
  }
}
