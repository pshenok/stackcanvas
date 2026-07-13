import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// DARK telemetry core (M1-4 / issue #8).
//
// Nothing in this file is wired into canvas-server.ts, cli.ts, or server.ts
// yet (that's PR#6), and there is no consent UI (PR#5). Nothing in this repo
// currently constructs a TelemetryClient outside of tests, so this PR ships
// with literally zero possibility of a network call.
//
// As a second, independent layer of defense, TelemetryClient's default
// transport (`fetchImpl`) is a local no-op, NOT the global `fetch` — even a
// premature/accidental `new TelemetryClient()` call in production code
// without an explicit `fetchImpl` cannot reach the network. The real
// collector endpoint and a network-capable default transport arrive with the
// collector itself (PR#6/#7).
// ---------------------------------------------------------------------------

export type TelemetryConsent = 'granted' | 'denied' | 'unset' | 'disabled_env'

export interface StackcanvasConfig {
  telemetry?: {
    consent: 'granted' | 'denied'
    anonId?: string
    decidedAt?: string
    installReportedAt?: string
  }
}

export type NodesBucket = '0' | '1-10' | '11-50' | '51-200' | '200+'

export function nodesBucket(n: number): NodesBucket {
  if (n <= 0) return '0'
  if (n <= 10) return '1-10'
  if (n <= 50) return '11-50'
  if (n <= 200) return '51-200'
  return '200+'
}

/** The ONLY payloads that can leave the machine. Adding a field = TELEMETRY.md + minor version. */
export type TelemetryEventName = 'install' | 'canvas_opened' | 'intent_sent' | 'scan_run' | 'drift_opened'

export type TelemetryProps =
  | { event: 'install' }
  | { event: 'canvas_opened'; nodes_bucket: NodesBucket; tf_bin: 'terraform' | 'tofu' | 'unknown' }
  | { event: 'intent_sent'; add: number; modify: number; remove: number; adopt: number; investigate: number } // each capped at 50
  | { event: 'scan_run'; provider: 'aws' | 'gcp' | 'azure' | 'other'; nodes_bucket: NodesBucket }
  | { event: 'drift_opened'; nodes_bucket: NodesBucket } // browser-originated — arrives via POST /api/telemetry/event, never emitted server-side directly

export interface TelemetryEnvelope {
  schema: 1
  anon_id: string
  day: string // 'YYYY-MM-DD' UTC — day precision is the finest time that leaves the machine
  app_version: string // stackcanvas package version
  platform: 'darwin' | 'linux' | 'win32' | 'other'
  node_major: number
  payload: TelemetryProps
}

export interface TelemetryClientOptions {
  configPath?: string // default: join(homedir(), '.stackcanvas', 'config.json')
  endpoint?: string // default: 'https://t.stackcanvas.dev/e'
  fetchImpl?: typeof fetch // injectable for tests; defaults to a network-free no-op (see file header)
  env?: NodeJS.ProcessEnv // injectable for tests
  appVersion: string
}

const DEFAULT_ENDPOINT = 'https://t.stackcanvas.dev/e'

// Intentionally NOT `globalThis.fetch` — see file header. Ignores its args.
const noopTransport: typeof fetch = async () => new Response(null, { status: 204 })

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function mapPlatform(p: NodeJS.Platform): TelemetryEnvelope['platform'] {
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p
  return 'other'
}

function nodeMajor(): number {
  return Number(process.versions.node.split('.')[0])
}

function capCount(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(50, Math.trunc(n)))
}

/** Clamps the only unbounded-input event (intent_sent counters) into [0, 50]. */
function capPayload(props: TelemetryProps): TelemetryProps {
  if (props.event !== 'intent_sent') return props
  return {
    event: 'intent_sent',
    add: capCount(props.add),
    modify: capCount(props.modify),
    remove: capCount(props.remove),
    adopt: capCount(props.adopt),
    investigate: capCount(props.investigate),
  }
}

export class TelemetryClient {
  private readonly configPath: string
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly env: NodeJS.ProcessEnv
  private readonly appVersion: string

  constructor(opts: TelemetryClientOptions) {
    this.env = opts.env ?? process.env
    // STACKCANVAS_CONFIG_DIR overrides where ~/.stackcanvas normally lives —
    // used by CI/e2e to keep the consent config hermetic. An explicit
    // configPath always wins over both.
    const configDir = this.env.STACKCANVAS_CONFIG_DIR || join(homedir(), '.stackcanvas')
    this.configPath = opts.configPath ?? join(configDir, 'config.json')
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
    this.fetchImpl = opts.fetchImpl ?? noopTransport
    this.appVersion = opts.appVersion
  }

  /** Never throws: unreadable/corrupt config is treated as an empty config. */
  private readConfig(): StackcanvasConfig {
    try {
      const raw = readFileSync(this.configPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as StackcanvasConfig
      return {}
    } catch {
      return {}
    }
  }

  /** Atomic write (.tmp + rename); never throws — a write failure just means
   *  the banner/consent may re-prompt next launch, which is acceptable. */
  private writeConfig(cfg: StackcanvasConfig): void {
    try {
      const dir = dirname(this.configPath)
      mkdirSync(dir, { recursive: true })
      const tmp = `${this.configPath}.tmp`
      writeFileSync(tmp, JSON.stringify(cfg, null, 2))
      renameSync(tmp, this.configPath)
    } catch {
      // Telemetry can never break the product.
    }
  }

  /** env overrides > config > 'unset'. DO_NOT_TRACK=1 / STACKCANVAS_TELEMETRY=0
   *  always win, regardless of what's on disk. STACKCANVAS_TELEMETRY=1 is
   *  deliberately NOT handled here — it only un-hides the consent banner
   *  (PR#5 UI concern), it never grants consent by itself. */
  getConsent(): TelemetryConsent {
    if (this.env.DO_NOT_TRACK === '1' || this.env.STACKCANVAS_TELEMETRY === '0') return 'disabled_env'
    const consent = this.readConfig().telemetry?.consent
    if (consent === 'granted') return 'granted'
    if (consent === 'denied') return 'denied'
    return 'unset'
  }

  /** grant: mints a fresh anonId, emits 'install' exactly once ever (tracked
   *  via installReportedAt, which survives a later deny).
   *  deny: deletes anonId, leaves installReportedAt untouched. */
  setConsent(granted: boolean): void {
    const cfg = this.readConfig()
    const prevInstallReportedAt = cfg.telemetry?.installReportedAt
    const today = todayUtc()

    if (granted) {
      const shouldReportInstall = !prevInstallReportedAt
      const telemetry: NonNullable<StackcanvasConfig['telemetry']> = {
        consent: 'granted',
        anonId: randomUUID(),
        decidedAt: today,
        ...(shouldReportInstall ? { installReportedAt: today } : { installReportedAt: prevInstallReportedAt }),
      }
      this.writeConfig({ ...cfg, telemetry })
      if (shouldReportInstall) this.emit({ event: 'install' })
    } else {
      const telemetry: NonNullable<StackcanvasConfig['telemetry']> = {
        consent: 'denied',
        decidedAt: today,
        ...(prevInstallReportedAt ? { installReportedAt: prevInstallReportedAt } : {}),
      }
      this.writeConfig({ ...cfg, telemetry })
    }
  }

  /** No-op unless consent === 'granted'. Fire-and-forget: no retries, no
   *  queue, no logging (stdout is the MCP transport). Never throws. */
  emit(props: TelemetryProps): void {
    if (this.getConsent() !== 'granted') return
    const anonId = this.readConfig().telemetry?.anonId
    if (!anonId) return // consent says granted but anonId missing — never send an incomplete envelope

    const envelope: TelemetryEnvelope = {
      schema: 1,
      anon_id: anonId,
      day: todayUtc(),
      app_version: this.appVersion,
      platform: mapPlatform(process.platform),
      node_major: nodeMajor(),
      payload: capPayload(props),
    }

    try {
      const result = this.fetchImpl(this.endpoint, {
        method: 'POST',
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(3000),
      })
      void Promise.resolve(result).catch(() => {})
    } catch {
      // Telemetry can never break the product.
    }
  }
}
