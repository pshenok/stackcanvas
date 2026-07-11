import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseState } from './parse-state.js'
import { deriveContainment, deriveEdges } from './derive.js'

const fixture = JSON.parse(
  readFileSync(new URL('../test/fixtures/state.json', import.meta.url), 'utf8'),
)

test('edges from depends_on and physical id references, deduplicated', () => {
  const g = parseState(fixture)
  const edges = deriveEdges(g.nodes)
  const ids = edges.map(e => e.id).sort()
  expect(ids).toEqual([
    'aws_subnet.a->aws_instance.web',
    'aws_vpc.main->aws_subnet.a',
    'aws_vpc.main->module.data.aws_db_instance.db',
  ])
})

test('no self-edges', () => {
  const g = parseState(fixture)
  expect(deriveEdges(g.nodes).every(e => e.source !== e.target)).toBe(true)
})

test('vpc and subnet containment groups', () => {
  const g = deriveContainment({ ...parseState(fixture), edges: [] })
  const vpcGroup = g.groups.find(x => x.id === 'vpc:aws_vpc.main')
  expect(vpcGroup).toEqual({ id: 'vpc:aws_vpc.main', label: 'main', kind: 'vpc', parent: null })
  const subnetGroup = g.groups.find(x => x.id === 'subnet:aws_subnet.a')
  expect(subnetGroup?.parent).toBe('vpc:aws_vpc.main')
  expect(g.nodes.find(n => n.id === 'aws_vpc.main')!.group).toBe('vpc:aws_vpc.main')
  expect(g.nodes.find(n => n.id === 'aws_instance.web')!.group).toBe('subnet:aws_subnet.a')
  expect(g.nodes.find(n => n.id === 'module.data.aws_db_instance.db')!.group).toBe('vpc:aws_vpc.main')
})
