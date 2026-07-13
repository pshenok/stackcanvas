import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  applyPlan, parseState,
  type GraphModel, type ProviderSnapshot, type ScanProgress, type SourceProvider,
} from '@stackcanvas/core'

const execFileAsync = promisify(execFile)

/** Unchanged signature — moved here from canvas-server.ts, re-exported from index. */
export type TerraformShowRunner = (cwd: string, planPath?: string) => Promise<string>

/** Kept exported with today's exact behavior (hardcoded 'terraform') for
 *  backcompat. OpenTofu-aware binary resolution (resolveTfBinary /
 *  createShowRunner / TerraformProvider.binaryUsed) is a later increment of
 *  this same spec chapter — not part of this PR, which only extracts today's
 *  terraform-only path verbatim. */
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

export interface TerraformProviderOptions {
  dir: string
  /** Injectable for tests — same contract as CanvasServerOptions.runTerraformShow today. */
  runShow?: TerraformShowRunner
  /** Watcher debounce, default 300 (today's value). */
  debounceMs?: number
}

export class TerraformProvider implements SourceProvider {
  readonly origin = 'terraform'
  readonly dir: string
  /** Always true — terraform state is local and cheap to read, so it keeps
   *  today's zero-config auto-refresh-on-start behavior. */
  readonly refreshOnStart = true
  readonly label: string

  private run: TerraformShowRunner
  private graph: GraphModel = { nodes: [], edges: [], groups: [] }
  private stale: string | null = null
  private planJson: unknown = null
  private planPath: string | null = null
  private watcher: FSWatcher | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private disposed = false
  private pushFn: ((s: ProviderSnapshot) => void) | null = null
  private readonly debounceMs: number

  constructor(opts: TerraformProviderOptions) {
    this.dir = opts.dir
    this.run = opts.runShow ?? defaultRunner
    this.debounceMs = opts.debounceMs ?? 300
    // Binary-suffixed label ("... via tofu") lands with the OpenTofu PR that
    // introduces `binaryUsed`; today's label matches the constant text the
    // rest of the codebase never asserted on before this PR either.
    this.label = `Terraform (${this.dir})`
  }

  private snapshot(): ProviderSnapshot {
    return { origin: this.origin, graph: this.graph, stale: this.stale }
  }

  /** Validate config and detect tooling (no-op today — binary detection is a
   *  later increment). Also (re)creates the chokidar watcher and awaits its
   *  'ready' event: inotify (Linux) delivers no events for writes that land
   *  before the watcher is ready, so callers that await init() before
   *  mutating the watched directory don't lose that first change — the same
   *  guarantee today's canvas-server.ts got by awaiting 'ready' directly in
   *  start(). SourceProvider.watch() itself must stay synchronous per the
   *  interface, so this is the one place that can still block on it.
   *  Idempotent: a no-op once the watcher exists. */
  async init(): Promise<void> {
    if (this.watcher) return
    const planPath = join(this.dir, '.stackcanvas', 'plan.json')
    // chokidar v4 dropped glob support, so watch `dir` recursively and filter
    // in `ignored` instead of passing glob patterns (which silently match nothing).
    const watcher = chokidar.watch(this.dir, {
      ignoreInitial: true,
      ignored: (path, stats) => {
        if (path.includes(`${sep}.terraform${sep}`) || path.endsWith(`${sep}.terraform`)) return true
        if (stats && !stats.isDirectory() && !path.endsWith('.tfstate') && path !== planPath) return true
        return false
      },
    })
    watcher.on('all', () => this.scheduleRefresh())
    watcher.on('error', (err: unknown) => {
      this.stale = (err as Error).message
      if (!this.disposed) this.pushFn?.(this.snapshot())
    })
    await new Promise<void>(res => watcher.once('ready', () => res()))
    this.watcher = watcher
    this.disposed = false
  }

  /** `force` ignored (no cache to bypass); `onProgress`, if passed, is never
   *  invoked — a terraform `show` read has no meaningful sub-steps to report. */
  async refresh(
    _opts?: { force?: boolean; onProgress?: (p: ScanProgress) => void },
  ): Promise<ProviderSnapshot> {
    try {
      const stateJson = JSON.parse(await this.run(this.dir))
      let g = parseState(stateJson)
      if (this.planJson) g = applyPlan(g, this.planJson)
      this.graph = g
      this.stale = null
    } catch (err) {
      this.stale = (err as Error).message
    }
    return this.snapshot()
  }

  /** Arms the delivery callback for (debounced) watcher-driven snapshots.
   *  Watching itself starts in init() (see above); this just registers where
   *  pushes land, so it's trivially idempotent and safe to call repeatedly. */
  watch(push: (s: ProviderSnapshot) => void): void {
    this.pushFn = push
  }

  /** Terraform-specific — deliberately NOT on SourceProvider. Same body as
   *  today's CanvasServer.loadPlan: .json → readFileSync+JSON.parse, else
   *  run(dir, path). THROWS on failure (MCP load_plan relies on it), then
   *  returns the refreshed snapshot. */
  async loadPlan(path: string): Promise<ProviderSnapshot> {
    if (path.endsWith('.json')) this.planJson = JSON.parse(readFileSync(path, 'utf8'))
    else this.planJson = JSON.parse(await this.run(this.dir, path))
    this.planPath = path
    return this.refresh()
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
          const snap = await this.refresh()
          if (!this.disposed) this.pushFn?.(snap)
        } catch (err) {
          this.stale = (err as Error).message
          if (!this.disposed) this.pushFn?.(this.snapshot())
        }
      })()
    }, this.debounceMs)
  }

  async dispose(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.disposed = true
    await this.watcher?.close()
    this.watcher = null
  }
}
