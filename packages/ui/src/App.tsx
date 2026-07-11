import { useEffect, useState } from 'react'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { layoutGraph } from './layout.js'
import { ResourceNode } from './nodes/ResourceNode.js'
import { useStore } from './store.js'
import { connectLive } from './ws.js'
import { Inspector } from './Inspector.js'

const nodeTypes = { resource: ResourceNode }

export function App() {
  const { graph, collapsed, showPlan, stale, agentStatus, select, toggleGroup, togglePlan } = useStore()
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] })

  useEffect(() => connectLive(), [])

  useEffect(() => {
    let cancelled = false
    void layoutGraph(graph, collapsed, showPlan).then(f => { if (!cancelled) setFlow(f) })
    return () => { cancelled = true }
  }, [graph, collapsed, showPlan])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">stackcanvas</span>
        <button onClick={togglePlan}>{showPlan ? 'Hide plan' : 'Show plan'}</button>
        <span className={`agent-badge agent-${agentStatus}`}>agent: {agentStatus}</span>
        {stale && <span className="stale-banner" role="alert">stale: {stale}</span>}
      </header>
      <div className="canvas-row">
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => {
            if ((node.data as { collapsedGroup?: boolean }).collapsedGroup) toggleGroup(node.id)
            else select(node.id)
          }}
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
