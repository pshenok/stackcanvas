import type { GraphModel, ProviderError, ScanProgress } from './types.js'

/** Optional provider-specific snapshot metadata. Surfaced per-provider in
 *  /api/meta.providers[]; consumed by reconcile() (coveredTypes) and the
 *  scan banner (scannedAt/errors). TerraformProvider leaves it undefined. */
export interface ProviderSnapshotMeta {
  scannedAt?: string
  errors?: ProviderError[]
  coveredTypes?: string[]
}

/** One provider's current view of the world. `graph` is always the last
 *  successfully produced graph (initially empty); `stale` is the human-readable
 *  failure message of the most recent refresh, or null when it succeeded. */
export interface ProviderSnapshot {
  origin: string
  graph: GraphModel
  stale: string | null
  meta?: ProviderSnapshotMeta
}

export interface SourceProvider {
  /** Stable, unique among active providers; stamped as GraphNode.origin.
   *  TerraformProvider uses 'terraform'. */
  readonly origin: string
  /** Human label for UI/meta, e.g. 'Terraform (/abs/dir) via tofu'. */
  readonly label: string
  /** Whether CanvasServer.start() (and any other refresh-all path) should
   *  call refresh() on this provider automatically. TerraformProvider: true
   *  (today's zero-config behavior). Live providers (e.g. AwsLiveSource): false —
   *  refresh happens exclusively through the ScanStatus state machine
   *  (POST /api/scan or the MCP scan tool), never implicitly, so a fresh
   *  cache can render on registration without ever making an AWS call. */
  readonly refreshOnStart: boolean
  /** Validate config and detect tooling. MUST NOT throw for recoverable
   *  problems (missing binary, empty state) — those surface as `stale` on
   *  refresh. Throw only for fatal misconfiguration. Idempotent. */
  init(): Promise<void>
  /** Recompute the snapshot from the source. NEVER rejects: failures land in
   *  snapshot.stale and `graph` stays the last good one.
   *  `force: true` bypasses any provider-side cache (e.g. AwsLiveSource's
   *  scan cache); providers without a cache ignore it. Default false.
   *  `onProgress`, when supplied, may be called zero or more times with
   *  incremental `ScanProgress` while the refresh runs (e.g. per-service-type
   *  during a live scan); providers that can't report progress —
   *  TerraformProvider included — simply never call it. No downcasts: every
   *  SourceProvider accepts the same options shape, including the e2e
   *  fixture provider. */
  refresh(opts?: { force?: boolean; onProgress?: (p: ScanProgress) => void }): Promise<ProviderSnapshot>
  /** Start watching the source; call `push` with a fresh snapshot on every
   *  (debounced) change. Idempotent; `push` must never fire after dispose()
   *  has resolved. */
  watch(push: (s: ProviderSnapshot) => void): void
  /** Stop watchers and release resources. Idempotent, safe before watch(). */
  dispose(): Promise<void>
}
