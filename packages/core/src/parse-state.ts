import type { GraphGroup, GraphModel, GraphNode } from './types.js'

interface TfResource {
  address: string; mode: string; type: string; name: string
  provider_name?: string
  values?: Record<string, unknown>
  sensitive_values?: unknown
  depends_on?: string[]
}
interface TfModule { address?: string; resources?: TfResource[]; child_modules?: TfModule[] }

export function shortProvider(providerName: string | undefined): string {
  if (!providerName) return 'unknown'
  const last = providerName.split('/').pop() ?? providerName
  return last
}

function maskSensitive(
  values: Record<string, unknown>,
  sensitive: unknown,
): Record<string, unknown> {
  if (!sensitive || typeof sensitive !== 'object') return values
  const s = sensitive as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    if (s[k] === true) out[k] = '•••'
    else if (s[k] && typeof s[k] === 'object' && v && typeof v === 'object' && !Array.isArray(v))
      out[k] = maskSensitive(v as Record<string, unknown>, s[k])
    else out[k] = v
  }
  return out
}

function walkModule(
  mod: TfModule, parentGroup: string | null,
  nodes: GraphNode[], groups: GraphGroup[],
): void {
  let groupId = parentGroup
  if (mod.address) {
    groupId = mod.address
    groups.push({
      id: mod.address,
      label: mod.address.split('.').pop() ?? mod.address,
      kind: 'module',
      parent: parentGroup,
    })
  }
  for (const r of mod.resources ?? []) {
    if (r.mode !== 'managed') continue
    nodes.push({
      id: r.address,
      type: r.type,
      name: r.name,
      provider: shortProvider(r.provider_name),
      group: groupId,
      attributes: maskSensitive(r.values ?? {}, r.sensitive_values),
      status: 'noop',
      dependsOn: r.depends_on ?? [],
    })
  }
  for (const child of mod.child_modules ?? []) walkModule(child, groupId, nodes, groups)
}

export function parseState(showJson: unknown): GraphModel {
  const nodes: GraphNode[] = []
  const groups: GraphGroup[] = []
  const root = (showJson as { values?: { root_module?: TfModule } } | null)?.values?.root_module
  if (root) walkModule(root, null, nodes, groups)
  return { nodes, edges: [], groups }
}
