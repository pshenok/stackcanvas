import type { GraphModel } from './types.js'

export function summarizeGraph(g: GraphModel): string {
  const byType = new Map<string, number>()
  for (const n of g.nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1)
  const typeLines = [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, c]) => `  ${t}: ${c}`)
  const changes = g.nodes
    .filter(n => n.status !== 'noop')
    .map(n => `  ${n.status}: ${n.id}`)
    .sort()
  return [
    `${g.nodes.length} resources, ${g.edges.length} edges, ${g.groups.length} groups.`,
    'By type:',
    ...typeLines,
    changes.length ? 'Pending plan changes:' : 'No pending plan changes.',
    ...changes,
  ].join('\n')
}
