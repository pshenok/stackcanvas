import { useCallback, useEffect, useState } from 'react'
import {
  Background, ReactFlow,
  type Edge, type Node, type NodeChange, type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { buildIntent, buildPrompt, isConnectEdge } from './intent.js'
import { layoutGraph } from './layout.js'
import { ResourceNode } from './nodes/ResourceNode.js'
import { Palette } from './Palette.js'
import { providerOfType } from './resource-palette.js'
import { useStore } from './store.js'
import { connectLive } from './ws.js'
import { Inspector } from './Inspector.js'
import { ContextMenu, type MenuState } from './ContextMenu.js'
import { ConsentBanner } from './ConsentBanner.js'

const nodeTypes = { resource: ResourceNode }

export function App() {
  const {
    graph, collapsed, showPlan, stale, agentStatus, select, toggleGroup, togglePlan,
    drafts, draftEdges, modifies, removes, addDraftEdge, clearDrafts,
  } = useStore()
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] })
  const [notice, setNotice] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  // Positions the user set by dragging; they win over the auto-layout while the
  // graph is stable. When the graph itself changes, ELK re-layouts and dragged
  // positions of real nodes are dropped (draft positions survive — they are not
  // part of the layout).
  const [userPos, setUserPos] = useState<Record<string, XYPosition>>({})
  useEffect(() => {
    setUserPos(prev => {
      const kept = Object.entries(prev).filter(([id]) => id.startsWith('draft-'))
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
    })
  }, [graph])
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setUserPos(prev => {
      let next: Record<string, XYPosition> | null = null
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          next ??= { ...prev }
          next[c.id] = c.position
        }
      }
      return next ?? prev
    })
  }, [])
  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 4000) }

  useEffect(() => connectLive(), [])

  useEffect(() => {
    let cancelled = false
    void layoutGraph(graph, collapsed, showPlan).then(f => { if (!cancelled) setFlow(f) })
    return () => { cancelled = true }
  }, [graph, collapsed, showPlan])

  const draftNodes: Node[] = drafts.map((d, i) => ({
    id: d.id,
    type: 'resource',
    position: userPos[d.id] ?? { x: 40 + i * 30, y: 40 + i * 60 },
    data: { label: d.name ?? d.type, type: d.type, provider: providerOfType(d.type), status: 'noop', draft: true },
  }))
  const decoratedNodes = flow.nodes.map(n => ({
    ...n,
    position: userPos[n.id] ?? n.position,
    data: { ...n.data, removed: removes.has(n.id), modified: n.id in modifies },
  }))
  const allNodes = [...decoratedNodes, ...draftNodes]
  const allEdges = [
    ...flow.edges,
    ...draftEdges.map((e, i) => ({
      id: `draft-edge-${i}`, source: e.source, target: e.target, animated: true,
    })),
  ]

  const draftIds = new Set(drafts.map(d => d.id))
  const connectEdgeCount = draftEdges.filter(e => isConnectEdge(draftIds, e)).length
  const pendingCount =
    drafts.length + Object.keys(modifies).length + removes.size + connectEdgeCount
  const apply = async () => {
    const intent = buildIntent(useStore.getState())
    try {
      const res = await fetch('/api/intent', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(intent),
      })
      if (res.status === 202) {
        clearDrafts()
        flash('Sent to agent')
      } else {
        flash(`Apply failed: HTTP ${res.status}`)
      }
    } catch {
      flash('Apply failed: network error')
    }
  }
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildPrompt(buildIntent(useStore.getState())))
      flash('Prompt copied')
    } catch {
      flash('Copy failed — clipboard unavailable')
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">stackcanvas</span>
        <button onClick={togglePlan}>{showPlan ? 'Hide plan' : 'Show plan'}</button>
        <span className={`agent-badge agent-${agentStatus}`}>agent: {agentStatus}</span>
        {stale && <span className="stale-banner" role="alert">stale: {stale}</span>}
        {notice && <span className="notice">{notice}</span>}
        <button className="apply" disabled={pendingCount === 0} onClick={() => void apply()}>
          Apply ({pendingCount})
        </button>
        <button disabled={pendingCount === 0} onClick={() => void copyPrompt()}>Copy as prompt</button>
      </header>
      <div className="canvas-row">
        <Palette />
        <ReactFlow
          nodes={allNodes}
          edges={allEdges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => {
            setMenu(null)
            if ((node.data as { collapsedGroup?: boolean }).collapsedGroup) toggleGroup(node.id)
            else select(node.id)
          }}
          onNodeContextMenu={(e, node) => {
            e.preventDefault()
            if (
              !node.id.startsWith('draft-') &&
              node.type === 'resource' &&
              !(node.data as { collapsedGroup?: boolean }).collapsedGroup
            )
              setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
          }}
          onMoveStart={() => setMenu(null)}
          onNodeDragStart={() => setMenu(null)}
          onNodesChange={onNodesChange}
          onConnect={c => {
            if (c.source && c.target) addDraftEdge(c.source, c.target)
          }}
          onPaneClick={() => { setMenu(null); select(null) }}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
        </ReactFlow>
        <Inspector />
      </div>
      {menu && <ContextMenu menu={menu} close={() => setMenu(null)} />}
      <ConsentBanner />
    </div>
  )
}
