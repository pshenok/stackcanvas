import type { GraphEdge, GraphModel, GraphNode } from './types.js'

export function deriveEdges(nodes: GraphNode[]): GraphEdge[] {
  const byAddress = new Set(nodes.map(n => n.id))
  const byPhysicalId = new Map<string, string>()
  for (const n of nodes) {
    const pid = n.attributes['id']
    if (typeof pid === 'string' && pid.length > 0) byPhysicalId.set(pid, n.id)
  }
  const edges = new Map<string, GraphEdge>()
  const add = (source: string, target: string) => {
    if (source === target) return
    const id = `${source}->${target}`
    edges.set(id, { id, source, target })
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn) if (byAddress.has(dep)) add(dep, n.id)
    for (const [key, v] of Object.entries(n.attributes)) {
      if (key === 'id' || typeof v !== 'string') continue
      const target = byPhysicalId.get(v)
      if (target) add(target, n.id)
    }
  }
  return [...edges.values()]
}

export interface ContainmentRule {
  /** Resource type that acts as a visual container, e.g. 'aws_vpc'. */
  containerType: string
  /** Member attribute whose value equals the container's physical `id`, e.g. 'vpc_id'. */
  memberAttr: string
  /** Group kind; also the group-id prefix, e.g. 'vpc' -> 'vpc:<address>'. */
  kind: string
}

/**
 * Rule order matters: earlier rules' membership is assigned before later
 * containers are created, so nested kinds (subnet inside vpc) inherit the
 * right parent. Provider packs extend this table (PRs welcome) — the only
 * requirement is that members reference the container by its physical id.
 */
export const DEFAULT_CONTAINMENT_RULES: ContainmentRule[] = [
  { containerType: 'aws_vpc', memberAttr: 'vpc_id', kind: 'vpc' },
  { containerType: 'aws_subnet', memberAttr: 'subnet_id', kind: 'subnet' },
]

export function deriveContainment(
  g: GraphModel,
  rules: ContainmentRule[] = DEFAULT_CONTAINMENT_RULES,
): GraphModel {
  const groups = [...g.groups]
  const nodes = g.nodes.map(n => ({ ...n }))
  for (const rule of rules) {
    const groupByPhysicalId = new Map<string, string>()
    for (const n of nodes.filter(n => n.type === rule.containerType)) {
      const pid = n.attributes['id']
      if (typeof pid !== 'string') continue
      const gid = `${rule.kind}:${n.id}`
      groups.push({ id: gid, label: n.name, kind: rule.kind, parent: n.group })
      groupByPhysicalId.set(pid, gid)
      n.group = gid
    }
    for (const n of nodes) {
      if (n.type === rule.containerType) continue
      const ref = n.attributes[rule.memberAttr]
      if (typeof ref === 'string' && groupByPhysicalId.has(ref))
        n.group = groupByPhysicalId.get(ref)!
    }
  }
  return { ...g, nodes, groups }
}
