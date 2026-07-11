import type { AttributeDiff, GraphModel, GraphNode, NodeStatus } from './types.js'
import { deriveEdges } from './derive.js'
import { maskSensitive, shortProvider } from './parse-state.js'

interface TfChange {
  address: string; type: string; name: string; provider_name?: string
  change?: {
    actions?: string[]; before?: unknown; after?: unknown
    before_sensitive?: unknown; after_sensitive?: unknown
  }
}

function maskChange(value: unknown, sensitive: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return maskSensitive(value as Record<string, unknown>, sensitive)
}

function statusOf(actions: string[]): NodeStatus {
  if (actions.includes('create') && actions.includes('delete')) return 'replace'
  if (actions.includes('create')) return 'create'
  if (actions.includes('delete')) return 'delete'
  if (actions.includes('update')) return 'update'
  return 'noop'
}

// Change detection runs on the raw (unmasked) before/after so a sensitive
// attribute that actually changed still surfaces as a diff row; the values
// placed on the row are always the masked ones, so raw secrets never leak
// into the diff output.
function diffAttrs(
  rawBefore: unknown, rawAfter: unknown,
  maskedBefore: unknown, maskedAfter: unknown,
): AttributeDiff[] {
  const rb = (rawBefore ?? {}) as Record<string, unknown>
  const ra = (rawAfter ?? {}) as Record<string, unknown>
  const mb = (maskedBefore ?? {}) as Record<string, unknown>
  const ma = (maskedAfter ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(rb), ...Object.keys(ra)])].sort()
  const out: AttributeDiff[] = []
  for (const k of keys) {
    if (JSON.stringify(rb[k]) !== JSON.stringify(ra[k]))
      out.push({ key: k, before: mb[k] ?? null, after: ma[k] ?? null })
  }
  return out
}

function moduleOf(address: string): string | null {
  const parts = address.split('.')
  if (parts[0] !== 'module') return null
  // "module.a.module.b.aws_x.y" -> take pairs while they are module.<name>
  const chain: string[] = []
  for (let i = 0; i + 1 < parts.length && parts[i] === 'module'; i += 2)
    chain.push(`module.${parts[i + 1]}`)
  return chain.length ? chain.join('.') : null
}

export function applyPlan(g: GraphModel, planJson: unknown): GraphModel {
  const changes = ((planJson as { resource_changes?: TfChange[] } | null)?.resource_changes) ?? []
  const nodes = new Map<string, GraphNode>(
    g.nodes.map(n => [n.id, { ...n, status: 'noop' as NodeStatus, attributeDiff: undefined }]),
  )
  const groups = [...g.groups]
  for (const c of changes) {
    const status = statusOf(c.change?.actions ?? [])
    if (status === 'noop') continue
    const before = maskChange(c.change?.before, c.change?.before_sensitive)
    const after = maskChange(c.change?.after, c.change?.after_sensitive)
    const existing = nodes.get(c.address)
    if (existing) {
      existing.status = status
      existing.attributeDiff = diffAttrs(c.change?.before, c.change?.after, before, after)
    } else if (status === 'create') {
      const group = moduleOf(c.address)
      if (group && !groups.some(x => x.id === group)) {
        const parentChain = group.split('.').slice(0, -2).join('.')
        groups.push({
          id: group,
          label: group.split('.').pop() ?? group,
          kind: 'module',
          parent: parentChain.startsWith('module.') ? parentChain : null,
        })
      }
      nodes.set(c.address, {
        id: c.address, type: c.type, name: c.name,
        provider: shortProvider(c.provider_name),
        group,
        attributes: (after ?? {}) as Record<string, unknown>,
        status: 'create',
        attributeDiff: diffAttrs(null, c.change?.after, null, after),
        dependsOn: [],
      })
    }
  }
  const merged = [...nodes.values()]
  return { nodes: merged, edges: deriveEdges(merged), groups }
}
