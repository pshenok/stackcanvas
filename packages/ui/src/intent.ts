import type { Intent } from '@stackcanvas/core'

export interface DraftState {
  drafts: { id: string; type: string; name?: string; wishes?: string }[]
  draftEdges: { source: string; target: string }[]
  modifies: Record<string, string>
  removes: Set<string>
}

export function buildIntent(s: DraftState): Intent {
  const draftIds = new Set(s.drafts.map(d => d.id))
  return {
    add: s.drafts.map(d => ({
      type: d.type,
      ...(d.name ? { name: d.name } : {}),
      ...(d.wishes ? { wishes: d.wishes } : {}),
      connect_to: s.draftEdges
        .filter(e => (e.source === d.id) !== (e.target === d.id))
        .map(e => (e.source === d.id ? e.target : e.source))
        .filter(other => !draftIds.has(other)),
    })),
    modify: [
      ...Object.entries(s.modifies).map(([address, wishes]) => ({ address, wishes })),
      // an edge drawn between two existing resources = "connect them" request
      ...s.draftEdges
        .filter(e => !draftIds.has(e.source) && !draftIds.has(e.target))
        .map(e => ({ address: e.source, wishes: `connect to ${e.target}` })),
    ],
    remove: [...s.removes].map(address => ({ address })),
  }
}

export function buildPrompt(intent: Intent): string {
  const lines: string[] = [
    'The user drew changes on the stackcanvas canvas. Apply them to the Terraform configuration:',
    '',
  ]
  for (const a of intent.add)
    lines.push(`ADD ${a.type}${a.name ? ` (name suggestion: "${a.name}")` : ''}`
      + `${a.connect_to.length ? ` connected to: ${a.connect_to.join(', ')}` : ''}`
      + `${a.wishes ? `. Wishes: "${a.wishes}"` : ''}`)
  for (const m of intent.modify) lines.push(`MODIFY ${m.address}: "${m.wishes}"`)
  for (const r of intent.remove) lines.push(`REMOVE ${r.address}`)
  lines.push(
    '',
    'Write idiomatic HCL matching the repo style. Then run:',
    'terraform plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json',
    'so the canvas shows the diff.',
  )
  return lines.join('\n')
}
