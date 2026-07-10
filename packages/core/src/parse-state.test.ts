import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseState } from './parse-state.js'

const fixture = JSON.parse(
  readFileSync(new URL('../test/fixtures/state.json', import.meta.url), 'utf8'),
)

test('parses managed resources into nodes, skips data sources', () => {
  const g = parseState(fixture)
  expect(g.nodes.map(n => n.id).sort()).toEqual([
    'aws_instance.web', 'aws_subnet.a', 'aws_vpc.main', 'module.data.aws_db_instance.db',
  ])
  const vpc = g.nodes.find(n => n.id === 'aws_vpc.main')!
  expect(vpc.type).toBe('aws_vpc')
  expect(vpc.name).toBe('main')
  expect(vpc.provider).toBe('aws')
  expect(vpc.status).toBe('noop')
})

test('module resources get module groups', () => {
  const g = parseState(fixture)
  expect(g.groups).toContainEqual({ id: 'module.data', label: 'data', kind: 'module', parent: null })
  expect(g.nodes.find(n => n.id === 'module.data.aws_db_instance.db')!.group).toBe('module.data')
})

test('sensitive attributes are masked', () => {
  const g = parseState(fixture)
  const db = g.nodes.find(n => n.id === 'module.data.aws_db_instance.db')!
  expect(db.attributes['password']).toBe('•••')
  expect(db.attributes['engine']).toBe('postgres')
})

test('handles empty/garbage input without throwing', () => {
  expect(parseState(null)).toEqual({ nodes: [], edges: [], groups: [] })
  expect(parseState({ values: {} })).toEqual({ nodes: [], edges: [], groups: [] })
})
