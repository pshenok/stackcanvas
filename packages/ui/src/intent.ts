import type { Intent } from '@stackcanvas/core'

export interface DraftState {
  drafts: { id: string; type: string; name?: string; wishes?: string }[]
  draftEdges: { source: string; target: string }[]
  modifies: Record<string, string>
  removes: Set<string>
}

export function isConnectEdge(
  draftIds: Set<string>, e: { source: string; target: string },
): boolean {
  return !draftIds.has(e.source) && !draftIds.has(e.target)
}

// Edge convention (matches core's deriveEdges): target is the resource whose
// HCL holds the reference, so the connect-request modify lands on the target.
function buildModifies(s: DraftState, draftIds: Set<string>): { address: string; wishes: string }[] {
  const byAddress = new Map<string, string[]>()
  for (const [address, wishes] of Object.entries(s.modifies)) byAddress.set(address, [wishes])
  for (const e of s.draftEdges.filter(e => isConnectEdge(draftIds, e))) {
    const wishes = byAddress.get(e.target) ?? []
    byAddress.set(e.target, [...wishes, `connect to ${e.source}`])
  }
  return [...byAddress.entries()].map(([address, wishes]) => ({
    address, wishes: wishes.filter(w => w.length > 0).join('; '),
  }))
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
    modify: buildModifies(s, draftIds),
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
