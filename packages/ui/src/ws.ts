import type { AgentStatus, GraphModel } from '@stackcanvas/core'
import { useStore } from './store.js'

type WsMessage =
  | { type: 'graph'; graph: GraphModel; stale: string | null }
  | { type: 'agent_status'; status: AgentStatus }

export function connectLive(): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let gotLive = false

  void fetch('/api/graph').then(r => r.json()).then((g: GraphModel) => {
    if (!gotLive && !closed) useStore.getState().setGraph(g, null)
  }).catch(() => { /* WS will retry */ })

  const open = () => {
    if (closed) return
    ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onmessage = e => {
      const msg = JSON.parse(e.data as string) as WsMessage
      if (msg.type === 'graph') {
        gotLive = true
        useStore.getState().setGraph(msg.graph, msg.stale)
      } else if (msg.type === 'agent_status') {
        useStore.getState().setAgentStatus(msg.status)
      }
    }
    ws.onclose = () => { if (!closed) timer = setTimeout(open, 2000) }
  }
  open()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    ws?.close()
  }
}
