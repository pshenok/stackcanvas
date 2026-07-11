import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ResourceIcon } from '../icons.js'

export interface ResourceData {
  label: string; type: string; provider: string; status: string
  draft?: boolean; removed?: boolean; modified?: boolean
  [key: string]: unknown
}

export function ResourceNode({ data }: NodeProps) {
  const d = data as ResourceData
  const classes = ['resource-node', `status-${d.status}`]
  if (d.draft) classes.push('draft')
  if (d.removed) classes.push('removed')
  if (d.modified) classes.push('modified')
  return (
    <div className={classes.join(' ')}>
      <Handle type="target" position={Position.Left} />
      <ResourceIcon type={d.type} />
      <div className="labels">
        <span className="name">{d.label}</span>
        <span className="type">{d.type}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
