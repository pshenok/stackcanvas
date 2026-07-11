import { useStore } from './store.js'

export interface MenuState { x: number; y: number; nodeId: string }

export function ContextMenu({ menu, close }: { menu: MenuState; close: () => void }) {
  const { removes, requestModify, toggleRemove, select } = useStore()
  const left = Math.max(0, Math.min(menu.x, window.innerWidth - 190))
  const top = Math.max(0, Math.min(menu.y, window.innerHeight - 100))
  return (
    <div className="context-menu" style={{ left, top }}>
      <button onClick={() => { requestModify(menu.nodeId, ''); select(menu.nodeId); close() }}>
        Request change
      </button>
      <button onClick={() => { toggleRemove(menu.nodeId); close() }}>
        {removes.has(menu.nodeId) ? 'Unmark removal' : 'Mark for removal'}
      </button>
    </div>
  )
}
