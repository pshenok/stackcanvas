import type { GraphEdge, GraphGroup, GraphModel, GraphNode } from './types.js'
import type { ProviderSnapshot } from './provider.js'

export interface ComposedGraph {
  graph: GraphModel
  stale: string | null
  /** Node/group ids dropped because an earlier provider already claimed the id. */
  conflicts: { id: string; origin: string }[]
}

// Deterministic, first-wins-by-registration-order compositor. CanvasServer
// passes providers' snapshots in registration order, so "first" here means
// "earlier in that array" — not "most recently refreshed". This is the
// accidental-id-collision policy; deliberate tfstate/live overlap is handled
// separately by reconcile() (drift-reconcile spec section), not here.
export function composeGraphs(snapshots: ProviderSnapshot[]): ComposedGraph {
  const nodes = new Map<string, GraphNode>()
  const groups = new Map<string, GraphGroup>()
  const conflicts: { id: string; origin: string }[] = []

  for (const snap of snapshots) {
    for (const n of snap.graph.nodes) {
      if (nodes.has(n.id)) {
        conflicts.push({ id: n.id, origin: snap.origin })
        continue
      }
      nodes.set(n.id, { ...n, origin: snap.origin })
    }
    for (const g of snap.graph.groups) {
      if (groups.has(g.id)) {
        conflicts.push({ id: g.id, origin: snap.origin })
        continue
      }
      groups.set(g.id, { ...g, origin: snap.origin })
    }
  }

  // Edges: concat all snapshots' edges, dedupe by id (first wins), then drop
  // any edge whose source/target didn't survive into the composed node map
  // (e.g. because it lost a node-id collision above).
  const edgesById = new Map<string, GraphEdge>()
  for (const snap of snapshots) {
    for (const e of snap.graph.edges) {
      if (!edgesById.has(e.id)) edgesById.set(e.id, e)
    }
  }
  const edges = [...edgesById.values()].filter(e => nodes.has(e.source) && nodes.has(e.target))

  // stale: single snapshot passes its stale through verbatim (preserves
  // today's exact /api/meta and WS strings for the current single-provider
  // deployment); multiple snapshots join their non-null stale messages as
  // "origin: message" pairs.
  let stale: string | null
  if (snapshots.length === 1) {
    stale = snapshots[0].stale
  } else {
    const parts = snapshots
      .filter((s): s is ProviderSnapshot & { stale: string } => s.stale !== null)
      .map(s => `${s.origin}: ${s.stale}`)
    stale = parts.length > 0 ? parts.join('; ') : null
  }

  return {
    graph: { nodes: [...nodes.values()], edges, groups: [...groups.values()] },
    stale,
    conflicts,
  }
}
