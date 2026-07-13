import { expect, test } from 'vitest'
import { composeGraphs } from './compose.js'
import type { ProviderSnapshot } from './provider.js'
import type { GraphEdge, GraphGroup, GraphModel, GraphNode } from './types.js'

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: 'aws_vpc',
    name: id,
    provider: 'aws',
    group: null,
    attributes: {},
    status: 'noop',
    dependsOn: [],
    ...overrides,
  }
}

function group(id: string, overrides: Partial<GraphGroup> = {}): GraphGroup {
  return { id, label: id, kind: 'vpc', parent: null, ...overrides }
}

function edge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target }
}

function graph(partial: Partial<GraphModel>): GraphModel {
  return { nodes: [], edges: [], groups: [], ...partial }
}

function snapshot(origin: string, overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return { origin, graph: graph({}), stale: null, ...overrides }
}

test('empty snapshot list produces an empty graph and null stale', () => {
  const result = composeGraphs([])
  expect(result).toEqual({ graph: { nodes: [], edges: [], groups: [] }, stale: null, conflicts: [] })
})

test('single snapshot passes through with origin stamped on nodes and groups', () => {
  const snap = snapshot('terraform', {
    graph: graph({
      nodes: [node('aws_vpc.main')],
      groups: [group('vpc:aws_vpc.main')],
    }),
  })
  const result = composeGraphs([snap])
  expect(result.graph.nodes).toEqual([{ ...node('aws_vpc.main'), origin: 'terraform' }])
  expect(result.graph.groups).toEqual([{ ...group('vpc:aws_vpc.main'), origin: 'terraform' }])
  expect(result.conflicts).toEqual([])
})

test('single-snapshot stale is returned verbatim, with no origin prefix', () => {
  const snap = snapshot('terraform', { stale: 'terraform show failed: boom' })
  const result = composeGraphs([snap])
  expect(result.stale).toBe('terraform show failed: boom')
})

test('two snapshots with disjoint ids concatenate nodes, edges, and groups', () => {
  const tf = snapshot('terraform', {
    graph: graph({
      nodes: [node('aws_vpc.main')],
      groups: [group('vpc:aws_vpc.main')],
      edges: [edge('e1', 'aws_vpc.main', 'aws_vpc.main')],
    }),
  })
  const live = snapshot('aws-live', {
    graph: graph({
      nodes: [node('aws_instance.web', { type: 'aws_instance' })],
      groups: [group('vpc:live-vpc')],
      edges: [edge('e2', 'aws_instance.web', 'aws_instance.web')],
    }),
  })
  const result = composeGraphs([tf, live])
  expect(result.graph.nodes.map(n => n.id).sort()).toEqual(['aws_instance.web', 'aws_vpc.main'])
  expect(result.graph.nodes.find(n => n.id === 'aws_vpc.main')?.origin).toBe('terraform')
  expect(result.graph.nodes.find(n => n.id === 'aws_instance.web')?.origin).toBe('aws-live')
  expect(result.graph.groups.map(g => g.id).sort()).toEqual(['vpc:aws_vpc.main', 'vpc:live-vpc'])
  expect(result.graph.edges.map(e => e.id).sort()).toEqual(['e1', 'e2'])
  expect(result.conflicts).toEqual([])
})

test('node id collision: first snapshot wins, loser recorded in conflicts', () => {
  const first = snapshot('terraform', {
    graph: graph({ nodes: [node('aws_vpc.main', { status: 'create' })] }),
  })
  const second = snapshot('aws-live', {
    graph: graph({ nodes: [node('aws_vpc.main', { status: 'update' })] }),
  })
  const result = composeGraphs([first, second])
  expect(result.graph.nodes).toHaveLength(1)
  expect(result.graph.nodes[0]).toEqual({ ...node('aws_vpc.main', { status: 'create' }), origin: 'terraform' })
  expect(result.conflicts).toEqual([{ id: 'aws_vpc.main', origin: 'aws-live' }])
})

test('group id collision: first snapshot wins, loser recorded in conflicts', () => {
  const first = snapshot('terraform', { graph: graph({ groups: [group('vpc:main', { label: 'first' })] }) })
  const second = snapshot('aws-live', { graph: graph({ groups: [group('vpc:main', { label: 'second' })] }) })
  const result = composeGraphs([first, second])
  expect(result.graph.groups).toEqual([{ ...group('vpc:main', { label: 'first' }), origin: 'terraform' }])
  expect(result.conflicts).toEqual([{ id: 'vpc:main', origin: 'aws-live' }])
})

test('edge with a missing endpoint is dropped', () => {
  const snap = snapshot('terraform', {
    graph: graph({
      nodes: [node('aws_vpc.main')],
      edges: [edge('e1', 'aws_vpc.main', 'aws_subnet.missing')],
    }),
  })
  const result = composeGraphs([snap])
  expect(result.graph.edges).toEqual([])
})

test('duplicate edge ids across snapshots are deduped, first wins', () => {
  const tf = snapshot('terraform', {
    graph: graph({
      nodes: [node('a'), node('b')],
      edges: [edge('shared', 'a', 'b')],
    }),
  })
  const live = snapshot('aws-live', {
    graph: graph({
      nodes: [node('a'), node('b')],
      edges: [edge('shared', 'b', 'a')],
    }),
  })
  const result = composeGraphs([tf, live])
  // second snapshot's nodes are dropped as id collisions, so only the first
  // snapshot's edge ('a' -> 'b') has both endpoints present.
  expect(result.graph.edges).toEqual([edge('shared', 'a', 'b')])
})

test('multi-provider stale is joined as "origin: msg; origin2: msg2"', () => {
  const tf = snapshot('terraform', { stale: 'terraform show failed' })
  const live = snapshot('aws-live', { stale: 'scan failed' })
  const result = composeGraphs([tf, live])
  expect(result.stale).toBe('terraform: terraform show failed; aws-live: scan failed')
})

test('multi-provider stale skips providers with no failure', () => {
  const tf = snapshot('terraform', { stale: null })
  const live = snapshot('aws-live', { stale: 'scan failed' })
  const result = composeGraphs([tf, live])
  expect(result.stale).toBe('aws-live: scan failed')
})

test('multi-provider stale is null when nothing failed', () => {
  const tf = snapshot('terraform', { stale: null })
  const live = snapshot('aws-live', { stale: null })
  const result = composeGraphs([tf, live])
  expect(result.stale).toBeNull()
})

test('snapshot meta is ignored by compose: composed graph is identical with or without it', () => {
  const withoutMeta = snapshot('terraform', { graph: graph({ nodes: [node('aws_vpc.main')] }) })
  const withMeta = snapshot('terraform', {
    graph: graph({ nodes: [node('aws_vpc.main')] }),
    meta: { scannedAt: '2026-07-12T00:00:00Z', errors: [], coveredTypes: ['aws_vpc'] },
  })
  expect(composeGraphs([withoutMeta])).toEqual(composeGraphs([withMeta]))
})
