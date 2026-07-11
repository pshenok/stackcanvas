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

export function deriveContainment(g: GraphModel): GraphModel {
  const groups = [...g.groups]
  const nodes = g.nodes.map(n => ({ ...n }))
  const vpcGroupByPhysicalId = new Map<string, string>()
  const subnetGroupByPhysicalId = new Map<string, string>()

  for (const n of nodes.filter(n => n.type === 'aws_vpc')) {
    const pid = n.attributes['id']
    if (typeof pid !== 'string') continue
    const gid = `vpc:${n.id}`
    groups.push({ id: gid, label: n.name, kind: 'vpc', parent: n.group })
    vpcGroupByPhysicalId.set(pid, gid)
    n.group = gid
  }
  for (const n of nodes) {
    if (n.type === 'aws_vpc') continue
    const vpcRef = n.attributes['vpc_id']
    if (typeof vpcRef === 'string' && vpcGroupByPhysicalId.has(vpcRef))
      n.group = vpcGroupByPhysicalId.get(vpcRef)!
  }
  for (const n of nodes.filter(n => n.type === 'aws_subnet')) {
    const pid = n.attributes['id']
    if (typeof pid !== 'string') continue
    const gid = `subnet:${n.id}`
    groups.push({ id: gid, label: n.name, kind: 'subnet', parent: n.group })
    subnetGroupByPhysicalId.set(pid, gid)
    n.group = gid
  }
  for (const n of nodes) {
    if (n.type === 'aws_subnet') continue
    const subnetRef = n.attributes['subnet_id']
    if (typeof subnetRef === 'string' && subnetGroupByPhysicalId.has(subnetRef))
      n.group = subnetGroupByPhysicalId.get(subnetRef)!
  }
  return { ...g, nodes, groups }
}
