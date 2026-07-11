import { useStore } from './store.js'

export interface MenuState { x: number; y: number; nodeId: string }

export function ContextMenu({ menu, close }: { menu: MenuState; close: () => void }) {
  const { removes, requestModify, toggleRemove, select } = useStore()
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
      <button onClick={() => { requestModify(menu.nodeId, ''); select(menu.nodeId); close() }}>
        Request change
      </button>
      <button onClick={() => { toggleRemove(menu.nodeId); close() }}>
        {removes.has(menu.nodeId) ? 'Unmark removal' : 'Mark for removal'}
      </button>
    </div>
  )
}
