import type { AgentStatus, GraphModel } from '@stackcanvas/core'
import { create } from 'zustand'

export interface StoreState {
  graph: GraphModel
  stale: string | null
  agentStatus: AgentStatus
  selected: string | null
  collapsed: Set<string>
  showPlan: boolean
  setGraph: (g: GraphModel, stale: string | null) => void
  setAgentStatus: (s: AgentStatus) => void
  select: (id: string | null) => void
  toggleGroup: (id: string) => void
  togglePlan: () => void
}

export const useStore = create<StoreState>(set => ({
  graph: { nodes: [], edges: [], groups: [] },
  stale: null,
  agentStatus: 'idle',
  selected: null,
  collapsed: new Set<string>(),
  showPlan: true,
  setGraph: (graph, stale) =>
    set(s => ({
      graph, stale,
      collapsed: graph.nodes.length > 150 && s.collapsed.size === 0
        ? new Set(graph.groups.map(g => g.id))
        : s.collapsed,
    })),
  setAgentStatus: agentStatus => set({ agentStatus }),
  select: selected => set({ selected }),
  toggleGroup: id => set(s => {
    const collapsed = new Set(s.collapsed)
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
    return { collapsed }
  }),
  togglePlan: () => set(s => ({ showPlan: !s.showPlan })),
}))
