import type { AgentStatus, GraphModel } from '@stackcanvas/core'
import { useStore } from './store.js'

type WsMessage =
  | { type: 'graph'; graph: GraphModel; stale: string | null }
  | { type: 'agent_status'; status: AgentStatus }

export function connectLive(): () => void {
  let ws: WebSocket | null = null
  let closed = false

  void fetch('/api/graph').then(r => r.json()).then((g: GraphModel) =>
    useStore.getState().setGraph(g, null),
  ).catch(() => { /* WS will retry */ })

  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onmessage = e => {
      const msg = JSON.parse(e.data as string) as WsMessage
      if (msg.type === 'graph') useStore.getState().setGraph(msg.graph, msg.stale)
      else if (msg.type === 'agent_status') useStore.getState().setAgentStatus(msg.status)
    }
    ws.onclose = () => { if (!closed) setTimeout(open, 2000) }
  }
  open()
  return () => { closed = true; ws?.close() }
}
