export type NodeStatus = 'create' | 'update' | 'delete' | 'replace' | 'noop'
export interface AttributeDiff { key: string; before: unknown; after: unknown }
export interface GraphNode {
  id: string           // terraform address, e.g. "module.net.aws_vpc.main"
  type: string         // "aws_vpc"
  name: string         // "main"
  provider: string     // "aws"
  group: string | null // group id
  attributes: Record<string, unknown>
  status: NodeStatus
  attributeDiff?: AttributeDiff[]
  dependsOn: string[]
  /** Which SourceProvider produced this node (e.g. 'terraform').
   *  Stamped by composeGraphs (or by reconcile() for ghost nodes, in the
   *  later wiring PR); absent on graphs from bare parseState/applyPlan. */
  origin?: string
}
export interface GraphEdge { id: string; source: string; target: string }
export interface GraphGroup {
  id: string; label: string
  kind: string  // 'module' + containment-rule kinds ('vpc', 'subnet', ...)
  parent: string | null
  origin?: string
}
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; groups: GraphGroup[] }
export interface Intent {
  add: { type: string; name?: string; wishes?: string; connect_to: string[] }[]
  modify: { address: string; wishes: string }[]
  remove: { address: string }[]
}
export type AgentStatus = 'idle' | 'writing' | 'planning'

/** Non-fatal per-source failure detail. Defined once, here, so every
 *  provider — including @stackcanvas/scan-aws's AwsLiveSource — imports the
 *  same type instead of each declaring its own (the old scanner-spec
 *  ScanError type is deleted; scan-aws now imports ProviderError from
 *  core directly). */
export interface ProviderError {
  service: string
  operation?: string
  code?: string
  message: string
}

// ---- scan state machine (server/UI; the scanner's own output types live in
// @stackcanvas/scan-aws). Defined once, here, per §2.3's contract that
// ScanMeta/ScanState/ScanStatus/ScanProgress/ProviderError all live in core
// types.ts rather than being redeclared per-consumer. ----

/** Reported zero or more times via SourceProvider.refresh(opts.onProgress)
 *  while a scan-shaped refresh runs (e.g. per-service-type). */
export interface ScanProgress { service: string; done: number; total: number }

/** Per-scan summary attached to a completed live-scan refresh. Structurally
 *  mirrors @stackcanvas/scan-aws's own ScanMeta value (core declares the
 *  shape, scan-aws satisfies it) so ScanStatus.lastScan can be typed here
 *  without core depending on scan-aws. */
export interface ScanMeta {
  accountId: string
  region: string
  profile: string
  scannedAt: string
  durationMs: number
  apiCalls: number
  errors: ProviderError[]
  coveredTypes: string[]
}

export type ScanState = 'unavailable' | 'idle' | 'running' | 'error'

export interface ScanStatus {
  state: ScanState
  profile: string | null
  progress: ScanProgress | null
  lastScan: ScanMeta | null
  error: string | null
}
