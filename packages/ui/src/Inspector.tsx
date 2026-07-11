import { useStore } from './store.js'

function Value({ v }: { v: unknown }) {
  return <code>{typeof v === 'string' ? v : JSON.stringify(v)}</code>
}

export function Inspector() {
  const { graph, selected, select } = useStore()
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
