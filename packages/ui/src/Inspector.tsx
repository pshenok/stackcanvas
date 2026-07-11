import { useStore } from './store.js'

function Value({ v }: { v: unknown }) {
  return <code>{typeof v === 'string' ? v : JSON.stringify(v)}</code>
}

export function Inspector() {
  const {
    graph, selected, select, drafts, setDraftName, setDraftWishes,
    modifies, requestModify, removes, toggleRemove,
  } = useStore()

  if (selected?.startsWith('draft-')) {
    const draft = drafts.find(d => d.id === selected)
    if (!draft) return null
    return (
      <aside className="inspector">
        <div className="inspector-head">
          <strong>{draft.id}</strong>
          <button onClick={() => select(null)} aria-label="Close">×</button>
        </div>
        <div className="badge-row">
          <span className="type-pill">{draft.type}</span>
        </div>
        <section>
          <h4>Name</h4>
          <input
            value={draft.name ?? ''}
            placeholder={draft.type}
            onChange={e => setDraftName(draft.id, e.target.value)}
          />
        </section>
        <section>
          <h4>Wishes</h4>
          <textarea
            value={draft.wishes ?? ''}
            placeholder="describe what this resource should do"
            onChange={e => setDraftWishes(draft.id, e.target.value)}
          />
        </section>
      </aside>
    )
  }

  const node = graph.nodes.find(n => n.id === selected)
  if (!node) return null
  return (
    <aside className="inspector">
      <div className="inspector-head">
        <strong>{node.id}</strong>
        <button onClick={() => select(null)} aria-label="Close">×</button>
      </div>
      <div className="badge-row">
        <span className={`status-pill status-${node.status}`}>{node.status}</span>
        <span className="type-pill">{node.type}</span>
      </div>
      <div className="inspector-actions">
        {!(node.id in modifies) && (
          <button onClick={() => requestModify(node.id, '')}>Modify</button>
        )}
        <button onClick={() => toggleRemove(node.id)}>
          {removes.has(node.id) ? 'Unmark remove' : 'Mark for removal'}
        </button>
      </div>
      {node.attributeDiff && node.attributeDiff.length > 0 && (
        <section>
          <h4>Plan changes</h4>
          <table>
            <tbody>
              {node.attributeDiff.map(d => (
                <tr key={d.key}>
                  <td>{d.key}</td>
                  <td className="before"><Value v={d.before} /></td>
                  <td className="after"><Value v={d.after} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {node.id in modifies && (
        <section>
          <h4>Wishes for this change</h4>
          <textarea
            value={modifies[node.id] ?? ''}
            placeholder="describe the change you want"
            onChange={e => requestModify(node.id, e.target.value)}
          />
        </section>
      )}
      <section>
        <h4>Attributes</h4>
        <table>
          <tbody>
            {Object.entries(node.attributes).map(([k, v]) => (
              <tr key={k}><td>{k}</td><td><Value v={v} /></td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </aside>
  )
}
