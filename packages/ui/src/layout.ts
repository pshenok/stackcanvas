import type { GraphModel } from '@stackcanvas/core'
import type { Edge, Node } from '@xyflow/react'
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'

const elk = new ELK()
const NODE_W = 190
const NODE_H = 52

export async function layoutGraph(
  model: GraphModel,
  collapsed: Set<string>,
  showPlan: boolean,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  // Effective group for a node: nearest non-collapsed ancestor chain is kept;
  // if any ancestor is collapsed, the node is hidden and its topmost collapsed
  // ancestor is rendered as a plain collapsed box.
  const groupById = new Map(model.groups.map(g => [g.id, g]))
  const isHidden = (group: string | null): string | null => {
    let cur = group
    let hiddenUnder: string | null = null
    while (cur) {
      if (collapsed.has(cur)) hiddenUnder = cur
      cur = groupById.get(cur)?.parent ?? null
    }
    return hiddenUnder
  }

  const visibleNodes = model.nodes.filter(n => !isHidden(n.group))
  const representedCollapsed = new Set(
    model.nodes.map(n => isHidden(n.group)).filter((x): x is string => x !== null),
  )

  const elkChildrenFor = (parent: string | null): ElkNode[] => [
    ...model.groups
      .filter(g => g.parent === parent && !isHidden(g.parent) && !collapsed.has(g.id))
      .map(g => ({
        id: g.id,
        layoutOptions: { 'elk.padding': '[top=36,left=12,bottom=12,right=12]' },
        children: elkChildrenFor(g.id),
      })),
    ...[...representedCollapsed]
      .filter(id => groupById.get(id)?.parent === parent)
      .map(id => ({ id, width: NODE_W, height: NODE_H })),
    ...visibleNodes
      .filter(n => n.group === parent)
      .map(n => ({ id: n.id, width: NODE_W, height: NODE_H })),
  ]

  const visibleIds = new Set([...visibleNodes.map(n => n.id), ...representedCollapsed])
  const nodeAnchor = (id: string): string | null => {
    if (visibleIds.has(id)) return id
    const n = model.nodes.find(x => x.id === id)
    return n ? isHidden(n.group) : null
  }
  const elkEdges = model.edges
    .map(e => ({ id: e.id, from: nodeAnchor(e.source), to: nodeAnchor(e.target) }))
    .filter(e => e.from && e.to && e.from !== e.to)
    .map(e => ({ id: e.id, sources: [e.from as string], targets: [e.to as string] }))

  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '24',
    },
    children: elkChildrenFor(null),
    edges: elkEdges,
  })

  const rfNodes: Node[] = []
  const nodesById = new Map(model.nodes.map(n => [n.id, n]))
  const walk = (elkNode: ElkNode, parentId?: string): void => {
    for (const child of elkNode.children ?? []) {
      const model2 = nodesById.get(child.id)
      const isGroup = groupById.has(child.id)
      rfNodes.push({
        id: child.id,
        type: isGroup && !collapsed.has(child.id) ? 'group' : 'resource',
        position: { x: child.x ?? 0, y: child.y ?? 0 },
        ...(parentId ? { parentId, extent: 'parent' as const } : {}),
        style: isGroup && !collapsed.has(child.id)
          ? { width: child.width, height: child.height }
          : undefined,
        data: isGroup
          ? { label: groupById.get(child.id)!.label, type: groupById.get(child.id)!.kind,
              provider: '', status: 'noop', collapsedGroup: collapsed.has(child.id) }
          : {
              label: model2?.name ?? child.id,
              type: model2?.type ?? '',
              provider: model2?.provider ?? '',
              status: showPlan ? model2?.status ?? 'noop' : 'noop',
            },
      })
      walk(child, child.id)
    }
  }
  walk(res)

  const rfEdges: Edge[] = elkEdges.map(e => ({
    id: e.id, source: e.sources[0], target: e.targets[0],
  }))
  return { nodes: rfNodes, edges: rfEdges }
}
