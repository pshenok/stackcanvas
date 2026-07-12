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
}
export interface GraphEdge { id: string; source: string; target: string }
export interface GraphGroup {
  id: string; label: string
  kind: string  // 'module' + containment-rule kinds ('vpc', 'subnet', ...)
  parent: string | null
}
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; groups: GraphGroup[] }
export interface Intent {
  add: { type: string; name?: string; wishes?: string; connect_to: string[] }[]
  modify: { address: string; wishes: string }[]
  remove: { address: string }[]
}
export type AgentStatus = 'idle' | 'writing' | 'planning'
