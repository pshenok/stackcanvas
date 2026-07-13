import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
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
 *  backcompat — no OpenTofu fallback.
 *  @deprecated in favor of `createShowRunner`, which is binary-detection-aware. */
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

export interface ResolveTfBinaryOptions {
  /** Test seam: overrides the real `execFile <bin> version` probe used for
   *  the 'terraform' / 'tofu' PATH-fallback candidates. */
  probe?: (bin: string) => Promise<boolean>
}

/** Real probe: a candidate passes if `execFile(bin, ['version'])` resolves. */
async function defaultProbe(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['version'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/** Probe order: explicit ?? $STACKCANVAS_TF_BIN ?? 'terraform' ?? 'tofu' ?? null.
 *  `explicit` and `STACKCANVAS_TF_BIN` are used verbatim — no probe — so a
 *  wrong value surfaces later as the runner's own ENOENT message, which
 *  names it. Only the 'terraform'/'tofu' PATH-fallback candidates are probed
 *  via `execFile(bin, ['version'])`; probe failures are silent, falling to
 *  the next candidate. This is the ONLY tf/tofu resolver in the codebase
 *  (supersedes the release-engineering section's `resolveTerraformBin`).
 *  Performs a fresh probe on every call — no internal caching — so a caller
 *  that re-invokes it after `binaryUsed` went stale (e.g. TerraformProvider's
 *  refresh()) picks up a binary installed since the last attempt without a
 *  restart. */
export async function resolveTfBinary(
  explicit?: string,
  opts: ResolveTfBinaryOptions = {},
): Promise<string | null> {
  if (explicit) return explicit
  const envBin = process.env.STACKCANVAS_TF_BIN
  if (envBin) return envBin
  const probe = opts.probe ?? defaultProbe
  if (await probe('terraform')) return 'terraform'
  if (await probe('tofu')) return 'tofu'
  return null
}

/** Binary-detection-aware runner: `getBinary()` is read at call time (not
 *  captured), so a `TerraformProvider` can swap in a freshly re-resolved
 *  binary between calls without recreating the runner. Error mapping and
 *  `maxBuffer` match `defaultRunner`'s today. */
export function createShowRunner(getBinary: () => string | null): TerraformShowRunner {
  return async (cwd, planPath) => {
    const bin = getBinary()
    if (bin === null)
      throw new Error('No terraform or tofu binary found in PATH. Install one or set STACKCANVAS_TF_BIN.')
    const args = ['show', '-json', ...(planPath ? [planPath] : [])]
    try {
      const { stdout } = await execFileAsync(bin, args, { cwd, maxBuffer: 256 * 1024 * 1024 })
      return stdout
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT')
        throw new Error(`${bin} binary not found in PATH. Install Terraform or add it to PATH.`)
      throw new Error(`${bin} show failed: ${(err as Error).message}`)
    }
  }
}

/** Maps a resolved binary (name or path, as stored in `binaryUsed`) to the
 *  telemetry `tf_bin` vocabulary by basename — `.exe` tolerated for Windows,
 *  anything else (including null/unresolved) is 'unknown'. */
export function binaryKind(binaryUsed: string | null): 'terraform' | 'tofu' | 'unknown' {
  if (!binaryUsed) return 'unknown'
  const name = basename(binaryUsed).toLowerCase().replace(/\.exe$/, '')
  if (name === 'terraform') return 'terraform'
  if (name === 'tofu') return 'tofu'
  return 'unknown'
}

export interface TerraformProviderOptions {
  dir: string
  /** Injectable for tests — same contract as CanvasServerOptions.runTerraformShow today.
   *  When provided, binary detection is skipped entirely: `binaryUsed` stays
   *  `null` and `label` carries no ` via <bin>` suffix. */
  runShow?: TerraformShowRunner
  /** Explicit binary name/path; skips detection (used verbatim — see resolveTfBinary). */
  binary?: string
  /** Watcher debounce, default 300 (today's value). */
  debounceMs?: number
}

export class TerraformProvider implements SourceProvider {
  readonly origin = 'terraform'
  readonly dir: string
  /** Always true — terraform state is local and cheap to read, so it keeps
   *  today's zero-config auto-refresh-on-start behavior. */
  readonly refreshOnStart = true
  /** Resolved by init() (and re-resolved by refresh() while still null); null
   *  = none found (or runShow injected, which skips detection entirely).
   *  Telemetry's `tf_bin` event property reads this via `binaryKind()`. */
  binaryUsed: string | null = null

  get label(): string {
    return this.binaryUsed ? `Terraform (${this.dir}) via ${this.binaryUsed}` : `Terraform (${this.dir})`
  }

  private run: TerraformShowRunner
  private readonly injectedRunShow: boolean
  private readonly explicitBinary: string | undefined
  private binaryResolveAttempted = false
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
    this.injectedRunShow = opts.runShow !== undefined
    this.explicitBinary = opts.binary
    this.run = opts.runShow ?? createShowRunner(() => this.binaryUsed)
    this.debounceMs = opts.debounceMs ?? 300
  }

  private snapshot(): ProviderSnapshot {
    return { origin: this.origin, graph: this.graph, stale: this.stale }
  }

  /** Re-resolves `binaryUsed` if binary detection hasn't been attempted yet
   *  and no runShow was injected (which bypasses detection entirely). Called
   *  from both init() (once, up front) and refresh() (only while still null,
   *  so installing terraform/tofu after a failed resolution recovers on the
   *  next refresh without a restart — resolveTfBinary itself has no cache,
   *  so a fresh probe is exactly what re-running it gives us). */
  private async resolveBinary(): Promise<void> {
    this.binaryResolveAttempted = true
    if (this.injectedRunShow) return
    this.binaryUsed = await resolveTfBinary(this.explicitBinary)
  }

  /** Validate config and detect tooling: resolves the terraform/tofu binary
   *  (skipped when runShow was injected) and (re)creates the chokidar
   *  watcher, awaiting its 'ready' event: inotify (Linux) delivers no events
   *  for writes that land before the watcher is ready, so callers that await
   *  init() before mutating the watched directory don't lose that first
   *  change — the same guarantee today's canvas-server.ts got by awaiting
   *  'ready' directly in start(). SourceProvider.watch() itself must stay
   *  synchronous per the interface, so this is the one place that can still
   *  block on it. Never throws for a missing binary — that surfaces as
   *  `stale` on refresh(), same as before this detection was added.
   *  Idempotent: binary resolution runs once; the watcher setup is a no-op
   *  once the watcher exists. */
  async init(): Promise<void> {
    if (!this.binaryResolveAttempted) await this.resolveBinary()
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
    // Re-probe recovery: a prior resolution that found nothing (binaryUsed
    // still null) is retried on every refresh, so installing terraform/tofu
    // later recovers without a restart. A once-resolved binaryUsed is not
    // re-probed here — a binary vanishing mid-session surfaces as `stale`
    // from the runner's own ENOENT message instead.
    if (this.binaryUsed === null && !this.injectedRunShow) await this.resolveBinary()
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
