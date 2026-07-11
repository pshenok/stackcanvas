import { useState } from 'react'
import { ResourceIcon } from './icons.js'
import { PALETTE } from './resource-palette.js'
import { useStore } from './store.js'

export function Palette() {
  const addDraft = useStore(s => s.addDraft)
  const [customType, setCustomType] = useState('')
  return (
    <aside className="palette">
      <h4>Add resource</h4>
      {PALETTE.map(p => (
        <button key={p.type} className="palette-item" onClick={() => addDraft(p.type)}>
          <ResourceIcon type={p.type} /> {p.label}
        </button>
      ))}
      <div className="palette-custom">
        <input
          placeholder="any terraform type"
          value={customType}
          onChange={e => setCustomType(e.target.value)}
        />
        <button
          disabled={!customType.trim()}
          onClick={() => { addDraft(customType.trim()); setCustomType('') }}
        >Add</button>
      </div>
    </aside>
  )
}
