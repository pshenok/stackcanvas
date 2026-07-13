import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'
import {
  composeGraphs,
  type AgentStatus, type GraphModel, type Intent,
  type ProviderError, type ProviderSnapshot, type SourceProvider,
} from '@stackcanvas/core'
import { findPort } from './find-port.js'
import { IntentQueue } from './intent-queue.js'
import { nodesBucket, TelemetryClient } from './telemetry.js'
import { binaryKind, TerraformProvider, type TerraformShowRunner } from './providers/terraform.js'

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

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
}

// Server-side allowlist for POST /api/telemetry/event: deliberately narrower
// than the full TelemetryEventName union so a browser can never spoof
// install/canvas_opened/intent_sent/scan_run — those only ever originate
// from code that already holds the TelemetryClient. drift_opened is the one
// event with no server-side trigger (the drift lens is UI-only).
const BROWSER_TELEMETRY_EVENTS = new Set(['drift_opened'])

export interface CanvasServerOptions {
  dir: string
  uiDist?: string
  runTerraformShow?: TerraformShowRunner
  port?: number
  /** First port findPort probes when no fixed port is given (default 4680).
   *  Tests use distinct bases so parallel suites never contend. */
  portRangeStart?: number
  /** Explicit terraform/tofu binary; forwarded to TerraformProvider (used
   *  verbatim, skipping PATH detection — see resolveTfBinary). */
  tfBinary?: string
  /** Injectable for tests; defaults to a TelemetryClient reading/writing
   *  ~/.stackcanvas/config.json (or STACKCANVAS_CONFIG_DIR if set). */
  telemetry?: TelemetryClient
  /** Sugar only: start() calls addProvider() once per entry, in array order,
   *  after the built-in terraform provider is already live. Equivalent to
   *  omitting this and calling `canvasServer.addProvider(p)` yourself once
   *  start() resolves.
   *  @experimental — the SourceProvider contract may still shift as the
   *  scanner/reconcile series lands. */
  extraProviders?: SourceProvider[]
}

export class CanvasServer {
  readonly dir: string
  private uiDist?: string
  private fixedPort?: number
  private portRangeStart: number
  private graph: GraphModel = { nodes: [], edges: [], groups: [] }
  private stale: string | null = null
  private httpServer: ServerType | null = null
  private onGraphChange: Array<(g: GraphModel, stale: string | null) => void> = []
  private wss: WebSocketServer | null = null
  private intents = new IntentQueue()
  private agentStatus: AgentStatus = 'idle'
  private telemetry: TelemetryClient
  private tf: TerraformProvider
  private providers: SourceProvider[]
  private extraProviders: SourceProvider[]
  private snapshots = new Map<string, ProviderSnapshot>()
  private conflicts: { id: string; origin: string }[] = []

  constructor(opts: CanvasServerOptions) {
    this.dir = opts.dir
    this.uiDist = opts.uiDist
    this.fixedPort = opts.port
    this.portRangeStart = opts.portRangeStart ?? 4680
    this.telemetry = opts.telemetry ?? new TelemetryClient({ appVersion: '0.1.0' })
    this.tf = new TerraformProvider({ dir: opts.dir, runShow: opts.runTerraformShow, binary: opts.tfBinary })
    this.providers = [this.tf]
    this.extraProviders = opts.extraProviders ?? []
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

  /** Kept public, same signature as today. Targets the typed `tf` reference
   *  directly — plan concepts never leak onto the SourceProvider interface. */
  async loadPlan(path: string): Promise<void> {
    this.onSnapshot(await this.tf.loadPlan(path))
  }

  private recompose(): void {
    const snaps = this.providers
      .map(p => this.snapshots.get(p.origin))
      .filter((s): s is ProviderSnapshot => s !== undefined)
    const composed = composeGraphs(snaps)
    this.graph = composed.graph
    this.stale = composed.stale
    this.conflicts = composed.conflicts
    if (this.conflicts.length > 0)
      console.error(`stackcanvas: dropped id conflicts during compose: ${JSON.stringify(this.conflicts)}`)
    for (const fn of this.onGraphChange) fn(this.graph, this.stale)
  }

  private onSnapshot(s: ProviderSnapshot): void {
    this.snapshots.set(s.origin, s)
    this.recompose()
  }

  /** @experimental Registers (or replaces, if `p.origin` is already present)
   *  a SourceProvider: awaits init(), refreshes it up front when
   *  `refreshOnStart` is true (mirroring refreshGraph()'s own filter),
   *  subscribes to watch(), then recomposes so the change — a populated
   *  graph, or the still-empty last-good graph for a live provider that
   *  hasn't scanned yet — reaches WS subscribers immediately. */
  async addProvider(p: SourceProvider): Promise<void> {
    const existingIdx = this.providers.findIndex(x => x.origin === p.origin)
    if (existingIdx !== -1) {
      await this.providers[existingIdx].dispose()
      this.providers.splice(existingIdx, 1)
      this.snapshots.delete(p.origin)
    }
    await p.init()
    if (p.refreshOnStart) this.snapshots.set(p.origin, await p.refresh())
    this.providers.push(p)
    p.watch(s => this.onSnapshot(s))
    this.recompose()
  }

  /** @experimental Disposes and drops `origin` from composition; no-op if
   *  it isn't currently registered. */
  async removeProvider(origin: string): Promise<void> {
    const idx = this.providers.findIndex(p => p.origin === origin)
    if (idx === -1) return
    const [p] = this.providers.splice(idx, 1)
    await p.dispose()
    this.snapshots.delete(origin)
    this.recompose()
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg)
    for (const client of this.wss?.clients ?? [])
      if (client.readyState === WebSocket.OPEN) client.send(data)
  }

  /** Kept public name/signature — tests and callers rely on it. Refreshes
   *  only providers where `refreshOnStart` is true; a `refreshOnStart: false`
   *  provider (e.g. a future live-scan source) is skipped here — its
   *  snapshot is only ever surfaced via addProvider() or an explicit,
   *  provider-targeted `refresh({force: true})` — so this never triggers an
   *  implicit scan-like call. */
  async refreshGraph(): Promise<void> {
    const targets = this.providers.filter(p => p.refreshOnStart)
    const snaps = await Promise.all(targets.map(p => p.refresh()))
    for (const s of snaps) this.snapshots.set(s.origin, s)
    this.recompose()
  }

  protected buildApp(): Hono {
    const app = new Hono()
    // DNS-rebinding / CSRF guard: the server can't know its own port here (it
    // binds after buildApp() runs), so only the hostname portion of Host is
    // checked; any port is accepted. Scoped to POST — GETs are read-only and
    // not worth the complexity. Fails closed on a missing/malformed Host.
    app.use('/api/*', async (c, next) => {
      if (c.req.method !== 'POST') return next()
      const host = c.req.header('host') ?? ''
      const hostname = host.split(':')[0]
      if (hostname !== '127.0.0.1' && hostname !== 'localhost')
        return c.json({ error: 'forbidden origin' }, 403)
      const origin = c.req.header('origin')
      if (origin) {
        try {
          const originUrl = new URL(origin)
          if (
            originUrl.protocol !== 'http:' ||
            (originUrl.hostname !== '127.0.0.1' && originUrl.hostname !== 'localhost')
          ) return c.json({ error: 'forbidden origin' }, 403)
        } catch {
          return c.json({ error: 'forbidden origin' }, 403)
        }
      }
      return next()
    })
    app.get('/api/graph', c => c.json(this.graph))
    app.get('/api/meta', c => c.json({
      dir: this.dir,
      stale: this.stale,
      providers: this.providers.map(p => {
        const snap = this.snapshots.get(p.origin)
        const entry: {
          origin: string; label: string; stale: string | null
          scannedAt?: string; errors?: ProviderError[]
        } = { origin: p.origin, label: p.label, stale: snap?.stale ?? null }
        if (snap?.meta?.scannedAt !== undefined) entry.scannedAt = snap.meta.scannedAt
        if (snap?.meta?.errors !== undefined) entry.errors = snap.meta.errors
        return entry
      }),
      conflicts: this.conflicts,
    }))
    app.post('/api/intent', async c => {
      const parsed = intentSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid intent' }, 400)
      this.intents.push(parsed.data)
      // Post-validation/normalization, counted by action.kind — the Apply
      // click is the honest activation moment. adopt/investigate are always
      // 0 under this v1 wire shape; the intent-v2 pipeline relocates this
      // hook to count IntentV2.actions by kind instead.
      this.telemetry.emit({
        event: 'intent_sent',
        add: parsed.data.add.length,
        modify: parsed.data.modify.length,
        remove: parsed.data.remove.length,
        adopt: 0,
        investigate: 0,
      })
      return c.json({ queued: true }, 202)
    })
    app.get('/api/telemetry', c => c.json({ consent: this.telemetry.getConsent() }))
    app.post('/api/telemetry', async c => {
      const body = await c.req.json().catch(() => null) as { granted?: unknown } | null
      if (!body || typeof body.granted !== 'boolean') return c.json({ error: 'invalid body' }, 400)
      this.telemetry.setConsent(body.granted)
      return c.json({ consent: this.telemetry.getConsent() }, 200)
    })
    // The only path a browser-originated event (currently just
    // 'drift_opened') uses to reach the server-side TelemetryClient. Always
    // re-checks consent server-side — never trusts the browser's belief
    // about its own state — and the response never reveals consent (the UI
    // already has that from GET /api/telemetry).
    app.post('/api/telemetry/event', async c => {
      const body = await c.req.json().catch(() => null) as { name?: unknown } | null
      const name = body?.name
      if (typeof name !== 'string' || !BROWSER_TELEMETRY_EVENTS.has(name))
        return c.json({ error: 'unknown event' }, 400)
      if (this.telemetry.getConsent() === 'granted') {
        this.telemetry.emit({ event: 'drift_opened', nodes_bucket: nodesBucket(this.graph.nodes.length) })
      }
      return c.json({ ok: true }, 200)
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
    await this.tf.init()
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
    // The chokidar watcher itself (incl. the ready-await) already ran inside
    // tf.init() above; this just arms delivery of future debounced snapshots.
    this.tf.watch(s => this.onSnapshot(s))
    // One canvas_opened per successful start() — covers both `stackcanvas
    // serve` and the MCP open_canvas path (which calls start() once per new
    // canvas and never re-calls it for a reused one, since start() throws on
    // a second call). tf_bin reads TerraformProvider.binaryUsed (resolved by
    // tf.init()/refreshGraph() above); it degrades to 'unknown' whenever
    // binaryUsed is null — no binary detected, or runShow was injected.
    this.telemetry.emit({
      event: 'canvas_opened',
      nodes_bucket: nodesBucket(this.graph.nodes.length),
      tf_bin: binaryKind(this.tf.binaryUsed),
    })
    // Pure sugar over addProvider(): a refreshOnStart provider is refreshed
    // via addProvider's own conditional refresh, a refreshOnStart:false one
    // (e.g. a future live-scan source) registers with an empty graph and
    // waits for an explicit trigger — identical to calling addProvider()
    // directly once start() resolves.
    await Promise.all(this.extraProviders.map(p => this.addProvider(p)))
    return { port, url: `http://127.0.0.1:${port}` }
  }

  async stop(): Promise<void> {
    await Promise.all(this.providers.map(p => p.dispose()))
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
