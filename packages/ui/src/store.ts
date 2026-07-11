import type { AgentStatus, GraphModel } from '@stackcanvas/core'
import { create } from 'zustand'

export interface DraftNode { id: string; type: string; name?: string; wishes?: string }

export interface StoreState {
  graph: GraphModel
  stale: string | null
  agentStatus: AgentStatus
  selected: string | null
  collapsed: Set<string>
  showPlan: boolean
  drafts: DraftNode[]
  draftEdges: { source: string; target: string }[]
  modifies: Record<string, string>
  removes: Set<string>
  setGraph: (g: GraphModel, stale: string | null) => void
  setAgentStatus: (s: AgentStatus) => void
  select: (id: string | null) => void
  toggleGroup: (id: string) => void
  togglePlan: () => void
  addDraft: (type: string) => void
  setDraftName: (id: string, name: string) => void
  setDraftWishes: (id: string, wishes: string) => void
  addDraftEdge: (source: string, target: string) => void
  requestModify: (address: string, wishes: string) => void
  toggleRemove: (address: string) => void
  clearDrafts: () => void
}

export const useStore = create<StoreState>(set => ({
  graph: { nodes: [], edges: [], groups: [] },
  stale: null,
  agentStatus: 'idle',
  selected: null,
  collapsed: new Set<string>(),
  showPlan: true,
  drafts: [],
  draftEdges: [],
  modifies: {},
  removes: new Set<string>(),
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
  addDraft: type => set(s => ({
    drafts: [...s.drafts, { id: `draft-${s.drafts.length + 1}-${type}`, type }],
  })),
  setDraftName: (id, name) => set(s => ({
    drafts: s.drafts.map(d => (d.id === id ? { ...d, name } : d)),
  })),
  setDraftWishes: (id, wishes) => set(s => ({
    drafts: s.drafts.map(d => (d.id === id ? { ...d, wishes } : d)),
  })),
  addDraftEdge: (source, target) => set(s => {
    if (s.draftEdges.some(e => e.source === source && e.target === target)) return s
    return { draftEdges: [...s.draftEdges, { source, target }] }
  }),
  requestModify: (address, wishes) => set(s => {
    const removes = new Set(s.removes)
    removes.delete(address)
    return { modifies: { ...s.modifies, [address]: wishes }, removes }
  }),
  toggleRemove: address => set(s => {
    const removes = new Set(s.removes)
    let modifies = s.modifies
    if (removes.has(address)) {
      removes.delete(address)
    } else {
      removes.add(address)
      if (address in modifies) {
        modifies = { ...modifies }
        delete modifies[address]
      }
    }
    return { removes, modifies }
  }),
  clearDrafts: () => set({ drafts: [], draftEdges: [], modifies: {}, removes: new Set() }),
}))
