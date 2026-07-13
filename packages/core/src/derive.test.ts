import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseState } from './parse-state.js'
import { DEFAULT_CONTAINMENT_RULES, deriveContainment, deriveEdges } from './derive.js'
import type { GraphModel } from './types.js'

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

test('gcp network/subnetwork containment keyed by self_link', () => {
  const g: GraphModel = {
    edges: [],
    groups: [],
    nodes: [
      {
        id: 'google_compute_network.main', type: 'google_compute_network', name: 'main',
        provider: 'google', group: null, status: 'noop', dependsOn: [],
        attributes: { id: 'projects/p/global/networks/main', self_link: 'https://www.googleapis.com/compute/v1/projects/p/global/networks/main' },
      },
      {
        id: 'google_compute_subnetwork.a', type: 'google_compute_subnetwork', name: 'a',
        provider: 'google', group: null, status: 'noop', dependsOn: [],
        attributes: {
          id: 'projects/p/regions/us/subnetworks/a',
          self_link: 'https://www.googleapis.com/compute/v1/projects/p/regions/us/subnetworks/a',
          network: 'https://www.googleapis.com/compute/v1/projects/p/global/networks/main',
        },
      },
      {
        id: 'google_compute_instance.web', type: 'google_compute_instance', name: 'web',
        provider: 'google', group: null, status: 'noop', dependsOn: [],
        attributes: { id: 'i-1', network: 'https://www.googleapis.com/compute/v1/projects/p/global/networks/main' },
      },
    ],
  }
  const out = deriveContainment(g, DEFAULT_CONTAINMENT_RULES)
  const netGroup = out.groups.find(x => x.id === 'vpc:google_compute_network.main')
  expect(netGroup?.kind).toBe('vpc')
  // the instance references the network directly (not via the subnetwork),
  // so it's contained by the vpc group, not the subnet group.
  expect(out.nodes.find(n => n.id === 'google_compute_instance.web')!.group).toBe('vpc:google_compute_network.main')
  expect(out.nodes.find(n => n.id === 'google_compute_network.main')!.group).toBe('vpc:google_compute_network.main')
})

test('azurerm subnet containment (nic subnet_id references subnet.id)', () => {
  const g: GraphModel = {
    edges: [],
    groups: [],
    nodes: [
      {
        id: 'azurerm_subnet.internal', type: 'azurerm_subnet', name: 'internal',
        provider: 'azurerm', group: null, status: 'noop', dependsOn: [],
        attributes: { id: '/subscriptions/x/resourceGroups/rg/subnets/internal' },
      },
      {
        id: 'azurerm_network_interface.nic', type: 'azurerm_network_interface', name: 'nic',
        provider: 'azurerm', group: null, status: 'noop', dependsOn: [],
        attributes: { id: 'nic-1', subnet_id: '/subscriptions/x/resourceGroups/rg/subnets/internal' },
      },
    ],
  }
  const out = deriveContainment(g, DEFAULT_CONTAINMENT_RULES)
  const subnetGroup = out.groups.find(x => x.id === 'subnet:azurerm_subnet.internal')
  expect(subnetGroup?.kind).toBe('subnet')
  expect(out.nodes.find(n => n.id === 'azurerm_network_interface.nic')!.group).toBe('subnet:azurerm_subnet.internal')
})

test('cloudflare zone containment (record zone_id references zone.id)', () => {
  const g: GraphModel = {
    edges: [],
    groups: [],
    nodes: [
      {
        id: 'cloudflare_zone.example', type: 'cloudflare_zone', name: 'example',
        provider: 'cloudflare', group: null, status: 'noop', dependsOn: [],
        attributes: { id: 'zone-1' },
      },
      {
        id: 'cloudflare_dns_record.www', type: 'cloudflare_dns_record', name: 'www',
        provider: 'cloudflare', group: null, status: 'noop', dependsOn: [],
        attributes: { id: 'rec-1', zone_id: 'zone-1' },
      },
    ],
  }
  const out = deriveContainment(g, DEFAULT_CONTAINMENT_RULES)
  const zoneGroup = out.groups.find(x => x.id === 'vpc:cloudflare_zone.example')
  expect(zoneGroup?.kind).toBe('vpc')
  expect(out.nodes.find(n => n.id === 'cloudflare_dns_record.www')!.group).toBe('vpc:cloudflare_zone.example')
})
