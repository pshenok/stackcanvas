import { useEffect, useState } from 'react'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { buildIntent, buildPrompt } from './intent.js'
import { layoutGraph } from './layout.js'
import { ResourceNode } from './nodes/ResourceNode.js'
import { Palette } from './Palette.js'
import { useStore } from './store.js'
import { connectLive } from './ws.js'
import { Inspector } from './Inspector.js'

const nodeTypes = { resource: ResourceNode }

export function App() {
  const {
    graph, collapsed, showPlan, stale, agentStatus, select, toggleGroup, togglePlan,
    drafts, draftEdges, modifies, removes, addDraftEdge, clearDrafts,
  } = useStore()
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] })

  useEffect(() => connectLive(), [])

  useEffect(() => {
    let cancelled = false
    void layoutGraph(graph, collapsed, showPlan).then(f => { if (!cancelled) setFlow(f) })
    return () => { cancelled = true }
  }, [graph, collapsed, showPlan])

  const draftNodes: Node[] = drafts.map((d, i) => ({
    id: d.id,
    type: 'resource',
    position: { x: 40 + i * 30, y: 40 + i * 60 },
    data: { label: d.name ?? d.type, type: d.type, provider: 'aws', status: 'noop', draft: true },
  }))
  const decoratedNodes = flow.nodes.map(n => ({
    ...n,
    data: { ...n.data, removed: removes.has(n.id), modified: n.id in modifies },
  }))
  const allNodes = [...decoratedNodes, ...draftNodes]
  const allEdges = [
    ...flow.edges,
    ...draftEdges.map((e, i) => ({
      id: `draft-edge-${i}`, source: e.source, target: e.target, animated: true,
    })),
  ]

  const pendingCount = drafts.length + Object.keys(modifies).length + removes.size
  const apply = async () => {
    const intent = buildIntent(useStore.getState())
    const res = await fetch('/api/intent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    })
    if (res.status === 202) clearDrafts()
  }
  const copyPrompt = async () => {
    await navigator.clipboard.writeText(buildPrompt(buildIntent(useStore.getState())))
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">stackcanvas</span>
        <button onClick={togglePlan}>{showPlan ? 'Hide plan' : 'Show plan'}</button>
        <span className={`agent-badge agent-${agentStatus}`}>agent: {agentStatus}</span>
        {stale && <span className="stale-banner" role="alert">stale: {stale}</span>}
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
            if ((node.data as { collapsedGroup?: boolean }).collapsedGroup) toggleGroup(node.id)
            else select(node.id)
          }}
          onConnect={c => { if (c.source && c.target) addDraftEdge(c.source, c.target) }}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
        </ReactFlow>
        <Inspector />
      </div>
    </div>
  )
}
