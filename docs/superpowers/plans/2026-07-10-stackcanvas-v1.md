# stackcanvas v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship stackcanvas v1 — an OSS MCP tool for Claude Code: a live local web canvas of Terraform infra where the user drags resources and the agent writes all HCL.

**Architecture:** pnpm monorepo with four packages: `core` (pure graph/diff engine over `terraform show -json` output), `server` (Hono + WebSocket + chokidar watcher + in-memory intent queue), `mcp` (stdio MCP server exposing 4 tools, owns the CLI binary), `ui` (React + React Flow canvas built with Vite). MCP and server run in one process; UI talks REST + WS.

**Tech Stack:** TypeScript 5 (strict), pnpm workspaces, Vitest, Hono + @hono/node-server, ws, chokidar, zod, @modelcontextprotocol/sdk, React 18, @xyflow/react (React Flow 12), elkjs, zustand, Vite, Playwright, tsx (dev runner), tsup (packaging).

## Global Constraints

- Node >= 20, pnpm >= 9.
- Server binds `127.0.0.1` only; port auto-selected starting at 4680.
- Sensitive attributes masked (per `sensitive_values`) before leaving `core`.
- The canvas never generates HCL and has no apply button — only the agent executes.
- No emoji anywhere in the UI — inline SVG glyphs only.
- Commit messages: plain conventional commits, **no Co-Authored-By trailers**.
- Spec: `docs/superpowers/specs/2026-07-10-stackcanvas-design.md`.
- Repo root for all paths below: `/Users/kp/Projects/my/stackcanvas`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/scaffold.test.ts`

**Interfaces:**
- Produces: workspace layout every later task builds on; root commands `pnpm test`, `pnpm -r typecheck`.

- [ ] **Step 1: Write root config files**

`package.json`:
```json
{
  "name": "stackcanvas-monorepo",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "noEmit": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.stackcanvas/
*.tfstate
*.tfstate.backup
.terraform/
test-results/
playwright-report/
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 2: Create the core package skeleton with a smoke test**

`packages/core/package.json`:
```json
{
  "name": "@stackcanvas/core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/core/src/index.ts`:
```ts
export const VERSION = '0.1.0'
```

`packages/core/src/scaffold.test.ts`:
```ts
import { expect, test } from 'vitest'
import { VERSION } from './index.js'

test('workspace wiring works', () => {
  expect(VERSION).toBe('0.1.0')
})
```

- [ ] **Step 3: Install and verify**

Run: `cd /Users/kp/Projects/my/stackcanvas && pnpm install && pnpm test && pnpm typecheck`
Expected: 1 test passes, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: pnpm monorepo scaffold with vitest"
```

---

### Task 2: core — types + state parser with sensitive masking and module groups

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/parse-state.ts`
- Create: `packages/core/test/fixtures/state.json`
- Test: `packages/core/src/parse-state.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces (used by every later task):

```ts
export type NodeStatus = 'create' | 'update' | 'delete' | 'replace' | 'noop'
export interface AttributeDiff { key: string; before: unknown; after: unknown }
export interface GraphNode {
  id: string           // terraform address, e.g. "module.net.aws_vpc.main"
  type: string         // "aws_vpc"
  name: string         // "main"
  provider: string     // "aws"
  group: string | null // group id
  attributes: Record<string, unknown>
  status: NodeStatus
  attributeDiff?: AttributeDiff[]
  dependsOn: string[]
}
export interface GraphEdge { id: string; source: string; target: string }
export interface GraphGroup {
  id: string; label: string
  kind: 'module' | 'vpc' | 'subnet'
  parent: string | null
}
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; groups: GraphGroup[] }
export interface Intent {
  add: { type: string; name?: string; wishes?: string; connect_to: string[] }[]
  modify: { address: string; wishes: string }[]
  remove: { address: string }[]
}
export type AgentStatus = 'idle' | 'writing' | 'planning'
export function parseState(showJson: unknown): GraphModel
```

- [ ] **Step 1: Write the fixture** — `packages/core/test/fixtures/state.json` (shape of `terraform show -json`):

```json
{
  "format_version": "1.0",
  "values": {
    "root_module": {
      "resources": [
        {
          "address": "aws_vpc.main", "mode": "managed", "type": "aws_vpc", "name": "main",
          "provider_name": "registry.terraform.io/hashicorp/aws",
          "values": { "id": "vpc-123", "cidr_block": "10.0.0.0/16" },
          "sensitive_values": {}
        },
        {
          "address": "aws_subnet.a", "mode": "managed", "type": "aws_subnet", "name": "a",
          "provider_name": "registry.terraform.io/hashicorp/aws",
          "values": { "id": "subnet-1", "vpc_id": "vpc-123", "cidr_block": "10.0.1.0/24" },
          "sensitive_values": {},
          "depends_on": ["aws_vpc.main"]
        },
        {
          "address": "aws_instance.web", "mode": "managed", "type": "aws_instance", "name": "web",
          "provider_name": "registry.terraform.io/hashicorp/aws",
          "values": { "id": "i-1", "subnet_id": "subnet-1", "instance_type": "t3.micro" },
          "sensitive_values": {}
        },
        {
          "address": "data.aws_ami.ubuntu", "mode": "data", "type": "aws_ami", "name": "ubuntu",
          "provider_name": "registry.terraform.io/hashicorp/aws",
          "values": { "id": "ami-1" }, "sensitive_values": {}
        }
      ],
      "child_modules": [
        {
          "address": "module.data",
          "resources": [
            {
              "address": "module.data.aws_db_instance.db", "mode": "managed",
              "type": "aws_db_instance", "name": "db",
              "provider_name": "registry.terraform.io/hashicorp/aws",
              "values": { "id": "db-1", "vpc_id": "vpc-123", "password": "hunter2", "engine": "postgres" },
              "sensitive_values": { "password": true }
            }
          ]
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Write the failing test** — `packages/core/src/parse-state.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/core/src/parse-state.test.ts`
Expected: FAIL — cannot find `./parse-state.js`.

- [ ] **Step 4: Implement**

`packages/core/src/types.ts` — exactly the interfaces from the Interfaces block above (all `export`).

`packages/core/src/parse-state.ts`:
```ts
import type { GraphGroup, GraphModel, GraphNode } from './types.js'

interface TfResource {
  address: string; mode: string; type: string; name: string
  provider_name?: string
  values?: Record<string, unknown>
  sensitive_values?: unknown
  depends_on?: string[]
}
interface TfModule { address?: string; resources?: TfResource[]; child_modules?: TfModule[] }

export function shortProvider(providerName: string | undefined): string {
  if (!providerName) return 'unknown'
  const last = providerName.split('/').pop() ?? providerName
  return last
}

function maskSensitive(
  values: Record<string, unknown>,
  sensitive: unknown,
): Record<string, unknown> {
  if (!sensitive || typeof sensitive !== 'object') return values
  const s = sensitive as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    if (s[k] === true) out[k] = '•••'
    else if (s[k] && typeof s[k] === 'object' && v && typeof v === 'object' && !Array.isArray(v))
      out[k] = maskSensitive(v as Record<string, unknown>, s[k])
    else out[k] = v
  }
  return out
}

function walkModule(
  mod: TfModule, parentGroup: string | null,
  nodes: GraphNode[], groups: GraphGroup[],
): void {
  let groupId = parentGroup
  if (mod.address) {
    groupId = mod.address
    groups.push({
      id: mod.address,
      label: mod.address.split('.').pop() ?? mod.address,
      kind: 'module',
      parent: parentGroup,
    })
  }
  for (const r of mod.resources ?? []) {
    if (r.mode !== 'managed') continue
    nodes.push({
      id: r.address,
      type: r.type,
      name: r.name,
      provider: shortProvider(r.provider_name),
      group: groupId,
      attributes: maskSensitive(r.values ?? {}, r.sensitive_values),
      status: 'noop',
      dependsOn: r.depends_on ?? [],
    })
  }
  for (const child of mod.child_modules ?? []) walkModule(child, groupId, nodes, groups)
}

export function parseState(showJson: unknown): GraphModel {
  const nodes: GraphNode[] = []
  const groups: GraphGroup[] = []
  const root = (showJson as { values?: { root_module?: TfModule } } | null)?.values?.root_module
  if (root) walkModule(root, null, nodes, groups)
  return { nodes, edges: [], groups }
}
```

`packages/core/src/index.ts`:
```ts
export * from './types.js'
export { parseState, shortProvider } from './parse-state.js'
```

- [ ] **Step 5: Run tests, verify pass, commit**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: all pass.

```bash
git add -A && git commit -m "feat(core): state parser with masking and module groups"
```

---

### Task 3: core — edge derivation + VPC/subnet containment

**Files:**
- Create: `packages/core/src/derive.ts`
- Test: `packages/core/src/derive.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/parse-state.ts`

**Interfaces:**
- Consumes: `GraphModel`, `GraphNode` from Task 2.
- Produces:
  - `deriveEdges(nodes: GraphNode[]): GraphEdge[]` — edges from `depends_on` + attribute values matching another node's physical `id` attribute; direction dependency → dependent.
  - `deriveContainment(g: GraphModel): GraphModel` — adds `vpc:`/`subnet:`-prefixed groups and reassigns `node.group`.
  - `parseState` now returns edges and containment applied.

- [ ] **Step 1: Write the failing test** — `packages/core/src/derive.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/derive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/core/src/derive.ts`:

```ts
import type { GraphEdge, GraphModel, GraphNode } from './types.js'

export function deriveEdges(nodes: GraphNode[]): GraphEdge[] {
  const byAddress = new Set(nodes.map(n => n.id))
  const byPhysicalId = new Map<string, string>()
  for (const n of nodes) {
    const pid = n.attributes['id']
    if (typeof pid === 'string' && pid.length > 0) byPhysicalId.set(pid, n.id)
  }
  const edges = new Map<string, GraphEdge>()
  const add = (source: string, target: string) => {
    if (source === target) return
    const id = `${source}->${target}`
    edges.set(id, { id, source, target })
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn) if (byAddress.has(dep)) add(dep, n.id)
    for (const [key, v] of Object.entries(n.attributes)) {
      if (key === 'id' || typeof v !== 'string') continue
      const target = byPhysicalId.get(v)
      if (target) add(target, n.id)
    }
  }
  return [...edges.values()]
}

export function deriveContainment(g: GraphModel): GraphModel {
  const groups = [...g.groups]
  const nodes = g.nodes.map(n => ({ ...n }))
  const vpcGroupByPhysicalId = new Map<string, string>()
  const subnetGroupByPhysicalId = new Map<string, string>()

  for (const n of nodes.filter(n => n.type === 'aws_vpc')) {
    const pid = n.attributes['id']
    if (typeof pid !== 'string') continue
    const gid = `vpc:${n.id}`
    groups.push({ id: gid, label: n.name, kind: 'vpc', parent: n.group })
    vpcGroupByPhysicalId.set(pid, gid)
    n.group = gid
  }
  for (const n of nodes) {
    if (n.type === 'aws_vpc') continue
    const vpcRef = n.attributes['vpc_id']
    if (typeof vpcRef === 'string' && vpcGroupByPhysicalId.has(vpcRef))
      n.group = vpcGroupByPhysicalId.get(vpcRef)!
  }
  for (const n of nodes.filter(n => n.type === 'aws_subnet')) {
    const pid = n.attributes['id']
    if (typeof pid !== 'string') continue
    const gid = `subnet:${n.id}`
    groups.push({ id: gid, label: n.name, kind: 'subnet', parent: n.group })
    subnetGroupByPhysicalId.set(pid, gid)
    n.group = gid
  }
  for (const n of nodes) {
    if (n.type === 'aws_subnet') continue
    const subnetRef = n.attributes['subnet_id']
    if (typeof subnetRef === 'string' && subnetGroupByPhysicalId.has(subnetRef))
      n.group = subnetGroupByPhysicalId.get(subnetRef)!
  }
  return { ...g, nodes, groups }
}
```

Modify `parseState` (last line of `packages/core/src/parse-state.ts`) to wire both in:
```ts
import { deriveContainment, deriveEdges } from './derive.js'
// ...replace the return statement with:
  const base: GraphModel = { nodes, edges: [], groups }
  const contained = deriveContainment(base)
  return { ...contained, edges: deriveEdges(contained.nodes) }
```

Add to `packages/core/src/index.ts`:
```ts
export { deriveContainment, deriveEdges } from './derive.js'
```

- [ ] **Step 4: Run all core tests — the Task 2 containment-free group assertions still pass** (the module-group test asserts `groups` *contains* the module entry, and the db node's group changes to `vpc:aws_vpc.main` — **update the Task 2 test**: change the expectation `...db!.group` from `'module.data'` to `'vpc:aws_vpc.main'`).

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): edge derivation and vpc/subnet containment"
```

---

### Task 4: core — plan diff engine

**Files:**
- Create: `packages/core/src/apply-plan.ts`, `packages/core/test/fixtures/plan.json`
- Test: `packages/core/src/apply-plan.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `GraphModel`, `deriveEdges`, `shortProvider`.
- Produces: `applyPlan(g: GraphModel, planJson: unknown): GraphModel` — sets `status`/`attributeDiff` on existing nodes, adds `create` nodes from `resource_changes`, re-derives edges.

- [ ] **Step 1: Write the fixture** — `packages/core/test/fixtures/plan.json`:

```json
{
  "format_version": "1.2",
  "resource_changes": [
    {
      "address": "aws_instance.web", "type": "aws_instance", "name": "web",
      "provider_name": "registry.terraform.io/hashicorp/aws",
      "change": {
        "actions": ["update"],
        "before": { "id": "i-1", "subnet_id": "subnet-1", "instance_type": "t3.micro" },
        "after": { "id": "i-1", "subnet_id": "subnet-1", "instance_type": "t3.large" }
      }
    },
    {
      "address": "aws_s3_bucket.assets", "type": "aws_s3_bucket", "name": "assets",
      "provider_name": "registry.terraform.io/hashicorp/aws",
      "change": { "actions": ["create"], "before": null, "after": { "bucket": "my-assets" } }
    },
    {
      "address": "aws_subnet.a", "type": "aws_subnet", "name": "a",
      "provider_name": "registry.terraform.io/hashicorp/aws",
      "change": {
        "actions": ["delete", "create"],
        "before": { "id": "subnet-1", "vpc_id": "vpc-123", "cidr_block": "10.0.1.0/24" },
        "after": { "vpc_id": "vpc-123", "cidr_block": "10.0.9.0/24" }
      }
    },
    {
      "address": "module.data.aws_db_instance.db", "type": "aws_db_instance", "name": "db",
      "provider_name": "registry.terraform.io/hashicorp/aws",
      "change": { "actions": ["delete"], "before": { "id": "db-1" }, "after": null }
    },
    {
      "address": "aws_vpc.main", "type": "aws_vpc", "name": "main",
      "provider_name": "registry.terraform.io/hashicorp/aws",
      "change": { "actions": ["no-op"], "before": {}, "after": {} }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test** — `packages/core/src/apply-plan.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseState } from './parse-state.js'
import { applyPlan } from './apply-plan.js'

const load = (f: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8'))

const graph = () => applyPlan(parseState(load('state.json')), load('plan.json'))

test('statuses map from actions', () => {
  const g = graph()
  const status = (id: string) => g.nodes.find(n => n.id === id)?.status
  expect(status('aws_instance.web')).toBe('update')
  expect(status('aws_subnet.a')).toBe('replace')
  expect(status('module.data.aws_db_instance.db')).toBe('delete')
  expect(status('aws_vpc.main')).toBe('noop')
})

test('create adds a new node with after-attributes', () => {
  const g = graph()
  const bucket = g.nodes.find(n => n.id === 'aws_s3_bucket.assets')
  expect(bucket?.status).toBe('create')
  expect(bucket?.attributes['bucket']).toBe('my-assets')
  expect(bucket?.provider).toBe('aws')
})

test('attributeDiff lists changed keys only', () => {
  const g = graph()
  const web = g.nodes.find(n => n.id === 'aws_instance.web')!
  expect(web.attributeDiff).toEqual([
    { key: 'instance_type', before: 't3.micro', after: 't3.large' },
  ])
})

test('garbage plan input leaves graph unchanged', () => {
  const base = parseState(load('state.json'))
  expect(applyPlan(base, null).nodes.length).toBe(base.nodes.length)
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/core/src/apply-plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — `packages/core/src/apply-plan.ts`:

```ts
import type { AttributeDiff, GraphModel, GraphNode, NodeStatus } from './types.js'
import { deriveEdges } from './derive.js'
import { shortProvider } from './parse-state.js'

interface TfChange {
  address: string; type: string; name: string; provider_name?: string
  change?: { actions?: string[]; before?: unknown; after?: unknown }
}

function statusOf(actions: string[]): NodeStatus {
  if (actions.includes('create') && actions.includes('delete')) return 'replace'
  if (actions.includes('create')) return 'create'
  if (actions.includes('delete')) return 'delete'
  if (actions.includes('update')) return 'update'
  return 'noop'
}

function diffAttrs(before: unknown, after: unknown): AttributeDiff[] {
  const b = (before ?? {}) as Record<string, unknown>
  const a = (after ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()
  const out: AttributeDiff[] = []
  for (const k of keys) {
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k]))
      out.push({ key: k, before: b[k] ?? null, after: a[k] ?? null })
  }
  return out
}

function moduleOf(address: string): string | null {
  const parts = address.split('.')
  const idx = parts.lastIndexOf('module')
  if (parts[0] !== 'module') return null
  // "module.a.module.b.aws_x.y" -> take pairs while they are module.<name>
  const chain: string[] = []
  for (let i = 0; i + 1 < parts.length && parts[i] === 'module'; i += 2)
    chain.push(`module.${parts[i + 1]}`)
  void idx
  return chain.length ? chain.join('.') : null
}

export function applyPlan(g: GraphModel, planJson: unknown): GraphModel {
  const changes = ((planJson as { resource_changes?: TfChange[] } | null)?.resource_changes) ?? []
  const nodes = new Map<string, GraphNode>(
    g.nodes.map(n => [n.id, { ...n, status: 'noop' as NodeStatus, attributeDiff: undefined }]),
  )
  const groups = [...g.groups]
  for (const c of changes) {
    const status = statusOf(c.change?.actions ?? [])
    if (status === 'noop') continue
    const existing = nodes.get(c.address)
    if (existing) {
      existing.status = status
      existing.attributeDiff = diffAttrs(c.change?.before, c.change?.after)
    } else if (status === 'create') {
      const group = moduleOf(c.address)
      if (group && !groups.some(x => x.id === group)) {
        const parentChain = group.split('.').slice(0, -2).join('.')
        groups.push({
          id: group,
          label: group.split('.').pop() ?? group,
          kind: 'module',
          parent: parentChain.startsWith('module.') ? parentChain : null,
        })
      }
      nodes.set(c.address, {
        id: c.address, type: c.type, name: c.name,
        provider: shortProvider(c.provider_name),
        group,
        attributes: (c.change?.after ?? {}) as Record<string, unknown>,
        status: 'create',
        attributeDiff: diffAttrs(null, c.change?.after),
        dependsOn: [],
      })
    }
  }
  const merged = [...nodes.values()]
  return { nodes: merged, edges: deriveEdges(merged), groups }
}
```

Add to `packages/core/src/index.ts`:
```ts
export { applyPlan } from './apply-plan.js'
```

- [ ] **Step 5: Run tests, verify pass, commit**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: all pass.

```bash
git add -A && git commit -m "feat(core): plan diff engine"
```

---

### Task 5: server — CanvasServer with graph API and injectable terraform runner

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/index.ts`, `packages/server/src/canvas-server.ts`, `packages/server/src/find-port.ts`
- Test: `packages/server/src/canvas-server.test.ts`

**Interfaces:**
- Consumes: `parseState`, `applyPlan`, `GraphModel`, `Intent`, `AgentStatus` from `@stackcanvas/core`.
- Produces (Tasks 6–9, 15 rely on these exact signatures):

```ts
export type TerraformShowRunner = (cwd: string, planPath?: string) => Promise<string>
export interface CanvasServerOptions {
  dir: string
  uiDist?: string                    // absolute path to built UI; optional in tests
  runTerraformShow?: TerraformShowRunner
  port?: number                      // fixed port for tests/e2e; otherwise auto from 4680
}
export class CanvasServer {
  constructor(opts: CanvasServerOptions)
  start(): Promise<{ port: number; url: string }>
  stop(): Promise<void>
  refreshGraph(): Promise<void>
  loadPlan(path: string): Promise<void>       // Task 6
  getGraph(): GraphModel
  awaitIntent(timeoutMs: number): Promise<Intent | null>   // Task 7
  setAgentStatus(s: AgentStatus): void                      // Task 7
}
```

- [ ] **Step 1: Package skeleton**

`packages/server/package.json`:
```json
{
  "name": "@stackcanvas/server",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@stackcanvas/core": "workspace:*",
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "ws": "^8.18.0",
    "chokidar": "^4.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": { "@types/ws": "^8.5.0", "@types/node": "^22.0.0" }
}
```

`packages/server/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run `pnpm install`.

- [ ] **Step 2: Write the failing test** — `packages/server/src/canvas-server.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CanvasServer } from './canvas-server.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

let server: CanvasServer
afterEach(async () => { await server?.stop() })

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), 'resource "aws_vpc" "main" {}')
  return dir
}

test('serves the parsed graph on /api/graph', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture })
  const { url } = await server.start()
  const res = await fetch(`${url}/api/graph`)
  expect(res.status).toBe(200)
  const graph = await res.json()
  expect(graph.nodes.some((n: { id: string }) => n.id === 'aws_vpc.main')).toBe(true)
})

test('terraform failure keeps last good graph and reports stale', async () => {
  let fail = false
  server = new CanvasServer({
    dir: makeDir(),
    runTerraformShow: async () => { if (fail) throw new Error('boom'); return stateFixture },
  })
  const { url } = await server.start()
  fail = true
  await server.refreshGraph()
  const graph = await (await fetch(`${url}/api/graph`)).json()
  expect(graph.nodes.length).toBeGreaterThan(0) // last good kept
})

test('binds localhost only', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture })
  const { url } = await server.start()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/server`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/server/src/find-port.ts`:
```ts
import net from 'node:net'

export async function findPort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    const free = await new Promise<boolean>(resolve => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error(`No free port found in ${start}..${start + 49}`)
}
```

`packages/server/src/canvas-server.ts`:
```ts
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import {
  applyPlan, parseState,
  type AgentStatus, type GraphModel, type Intent,
} from '@stackcanvas/core'
import { findPort } from './find-port.js'

const execFileAsync = promisify(execFile)

export type TerraformShowRunner = (cwd: string, planPath?: string) => Promise<string>

export const defaultRunner: TerraformShowRunner = async (cwd, planPath) => {
  const args = ['show', '-json', ...(planPath ? [planPath] : [])]
  try {
    const { stdout } = await execFileAsync('terraform', args, { cwd, maxBuffer: 256 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT')
      throw new Error('terraform binary not found in PATH. Install Terraform or add it to PATH.')
    throw new Error(`terraform show failed: ${(err as Error).message}`)
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
}

export interface CanvasServerOptions {
  dir: string
  uiDist?: string
  runTerraformShow?: TerraformShowRunner
  port?: number
}

export class CanvasServer {
  readonly dir: string
  private uiDist?: string
  private run: TerraformShowRunner
  private fixedPort?: number
  private graph: GraphModel = { nodes: [], edges: [], groups: [] }
  private planJson: unknown = null
  private stale: string | null = null
  private httpServer: ServerType | null = null
  private onGraphChange: Array<(g: GraphModel, stale: string | null) => void> = []

  constructor(opts: CanvasServerOptions) {
    this.dir = opts.dir
    this.uiDist = opts.uiDist
    this.run = opts.runTerraformShow ?? defaultRunner
    this.fixedPort = opts.port
  }

  getGraph(): GraphModel { return this.graph }
  getStale(): string | null { return this.stale }
  subscribe(fn: (g: GraphModel, stale: string | null) => void): void { this.onGraphChange.push(fn) }

  async refreshGraph(): Promise<void> {
    try {
      const stateJson = JSON.parse(await this.run(this.dir))
      let g = parseState(stateJson)
      if (this.planJson) g = applyPlan(g, this.planJson)
      this.graph = g
      this.stale = null
    } catch (err) {
      this.stale = (err as Error).message
    }
    for (const fn of this.onGraphChange) fn(this.graph, this.stale)
  }

  protected buildApp(): Hono {
    const app = new Hono()
    app.get('/api/graph', c => c.json(this.graph))
    app.get('/api/meta', c => c.json({ dir: this.dir, stale: this.stale }))
    if (this.uiDist) {
      const dist = this.uiDist
      app.get('*', c => {
        const reqPath = c.req.path === '/' ? '/index.html' : c.req.path
        const file = join(dist, reqPath)
        if (existsSync(file) && statSync(file).isFile()) {
          return c.body(readFileSync(file), 200, {
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          })
        }
        return c.body(readFileSync(join(dist, 'index.html')), 200, { 'content-type': 'text/html' })
      })
    }
    return app
  }

  async start(): Promise<{ port: number; url: string }> {
    if (!existsSync(this.dir)) throw new Error(`Directory not found: ${this.dir}`)
    await this.refreshGraph()
    const port = this.fixedPort ?? (await findPort(4680))
    const app = this.buildApp()
    this.httpServer = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
    return { port, url: `http://127.0.0.1:${port}` }
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => {
      if (!this.httpServer) return resolve()
      this.httpServer.close(() => resolve())
    })
    this.httpServer = null
  }
}
```

`packages/server/src/index.ts`:
```ts
export { CanvasServer, defaultRunner } from './canvas-server.js'
export type { CanvasServerOptions, TerraformShowRunner } from './canvas-server.js'
```

- [ ] **Step 5: Run tests, verify pass, commit**

Run: `pnpm vitest run packages/server && pnpm typecheck`
Expected: all pass.

```bash
git add -A && git commit -m "feat(server): CanvasServer with graph API and injectable terraform runner"
```

---

### Task 6: server — file watcher, WebSocket push, plan loading

**Files:**
- Modify: `packages/server/src/canvas-server.ts`, `packages/server/src/index.ts`
- Test: `packages/server/src/watch-ws.test.ts`

**Interfaces:**
- Produces:
  - WS endpoint at `/ws`; messages: `{ type: 'graph', graph: GraphModel, stale: string | null }` on connect and every refresh; `{ type: 'agent_status', status: AgentStatus }` (wired in Task 7).
  - `loadPlan(path: string): Promise<void>` — `.json` file read directly, otherwise passed to the terraform runner as a plan file; plan re-applied on every refresh; the file `.stackcanvas/plan.json` under `dir` is always watched and auto-loaded.
  - Watcher: `*.tfstate` under `dir` (ignoring `.terraform/`), debounce 300ms.

- [ ] **Step 1: Write the failing test** — `packages/server/src/watch-ws.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { CanvasServer } from './canvas-server.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)
const planFixture = readFileSync(
  new URL('../../core/test/fixtures/plan.json', import.meta.url), 'utf8',
)

let server: CanvasServer
afterEach(async () => { await server?.stop() })

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))))
}

test('pushes graph on connect and again when tfstate changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  writeFileSync(join(dir, 'terraform.tfstate'), '{}')
  server = new CanvasServer({ dir, runTerraformShow: async () => stateFixture })
  const { url } = await server.start()
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
  const first = await nextMessage(ws)
  expect(first['type']).toBe('graph')
  const changed = nextMessage(ws)
  writeFileSync(join(dir, 'terraform.tfstate'), '{"serial": 2}')
  const msg = await changed
  expect(msg['type']).toBe('graph')
  ws.close()
}, 15000)

test('loadPlan applies diff statuses to the served graph', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  mkdirSync(join(dir, '.stackcanvas'))
  const planPath = join(dir, '.stackcanvas', 'plan.json')
  writeFileSync(planPath, planFixture)
  server = new CanvasServer({ dir, runTerraformShow: async () => stateFixture })
  const { url } = await server.start()
  await server.loadPlan(planPath)
  const graph = await (await fetch(`${url}/api/graph`)).json()
  const web = graph.nodes.find((n: { id: string }) => n.id === 'aws_instance.web')
  expect(web.status).toBe('update')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/server/src/watch-ws.test.ts`
Expected: FAIL — no `/ws`, no `loadPlan`.

- [ ] **Step 3: Implement** — modify `packages/server/src/canvas-server.ts`:

Add imports:
```ts
import { WebSocketServer, WebSocket } from 'ws'
import chokidar, { type FSWatcher } from 'chokidar'
```

Add fields to the class:
```ts
  private wss: WebSocketServer | null = null
  private watcher: FSWatcher | null = null
  private planPath: string | null = null
  private refreshTimer: NodeJS.Timeout | null = null
```

Add methods:
```ts
  async loadPlan(path: string): Promise<void> {
    if (path.endsWith('.json')) this.planJson = JSON.parse(readFileSync(path, 'utf8'))
    else this.planJson = JSON.parse(await this.run(this.dir, path))
    this.planPath = path
    await this.refreshGraph()
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      void (async () => {
        const autoPlan = join(this.dir, '.stackcanvas', 'plan.json')
        if (this.planPath === null && existsSync(autoPlan)) await this.loadPlan(autoPlan)
        else if (this.planPath?.endsWith('.json') && existsSync(this.planPath))
          this.planJson = JSON.parse(readFileSync(this.planPath, 'utf8'))
        await this.refreshGraph()
      })()
    }, 300)
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg)
    for (const client of this.wss?.clients ?? [])
      if (client.readyState === WebSocket.OPEN) client.send(data)
  }
```

In `start()`, after `this.httpServer = serve(...)`, add:
```ts
    this.wss = new WebSocketServer({ noServer: true })
    this.httpServer.on('upgrade', (req, socket, head) => {
      if (req.url === '/ws') {
        this.wss!.handleUpgrade(req, socket, head, ws => {
          ws.send(JSON.stringify({ type: 'graph', graph: this.graph, stale: this.stale }))
        })
      } else socket.destroy()
    })
    this.subscribe((graph, stale) => this.broadcast({ type: 'graph', graph, stale }))
    this.watcher = chokidar.watch(
      [join(this.dir, '**/*.tfstate'), join(this.dir, '.stackcanvas/plan.json')],
      { ignored: /\.terraform\//, ignoreInitial: true, cwd: this.dir },
    )
    this.watcher.on('all', () => this.scheduleRefresh())
```

In `stop()`, before closing the http server:
```ts
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    await this.watcher?.close()
    this.watcher = null
    for (const c of this.wss?.clients ?? []) c.terminate()
    this.wss?.close()
    this.wss = null
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm vitest run packages/server && pnpm typecheck`
Expected: all pass (watcher test may take a few seconds).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): tfstate watcher, websocket push, plan loading"
```

---

### Task 7: server — intent queue and agent status

**Files:**
- Create: `packages/server/src/intent-queue.ts`
- Modify: `packages/server/src/canvas-server.ts`
- Test: `packages/server/src/intent.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/intent` — body `Intent` (zod-validated), responds `202 {"queued":true}`.
  - `CanvasServer.awaitIntent(timeoutMs): Promise<Intent | null>` — resolves with the oldest queued intent or `null` on timeout.
  - `CanvasServer.setAgentStatus(s: AgentStatus)` — broadcasts `{ type: 'agent_status', status }`; also sent to new WS clients on connect.

- [ ] **Step 1: Write the failing test** — `packages/server/src/intent.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CanvasServer } from './canvas-server.js'
import { IntentQueue } from './intent-queue.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

test('IntentQueue: take resolves when an intent is pushed later', async () => {
  const q = new IntentQueue()
  const taking = q.take(5000)
  q.push({ add: [], modify: [], remove: [{ address: 'aws_s3_bucket.x' }] })
  expect((await taking)?.remove[0]?.address).toBe('aws_s3_bucket.x')
})

test('IntentQueue: take times out with null', async () => {
  const q = new IntentQueue()
  expect(await q.take(50)).toBeNull()
})

let server: CanvasServer
afterEach(async () => { await server?.stop() })

test('POST /api/intent flows to awaitIntent; bad payload rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  server = new CanvasServer({ dir, runTerraformShow: async () => stateFixture })
  const { url } = await server.start()
  const waiting = server.awaitIntent(5000)
  const good = await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      add: [{ type: 'aws_db_instance', wishes: 'small', connect_to: ['aws_vpc.main'] }],
      modify: [], remove: [],
    }),
  })
  expect(good.status).toBe(202)
  const intent = await waiting
  expect(intent?.add[0]?.type).toBe('aws_db_instance')

  const bad = await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonsense: true }),
  })
  expect(bad.status).toBe(400)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/server/src/intent.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/server/src/intent-queue.ts`:
```ts
import type { Intent } from '@stackcanvas/core'

export class IntentQueue {
  private queue: Intent[] = []
  private waiters: Array<(i: Intent) => void> = []

  push(intent: Intent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(intent)
    else this.queue.push(intent)
  }

  take(timeoutMs: number): Promise<Intent | null> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter)
        resolve(null)
      }, timeoutMs)
      const waiter = (i: Intent) => { clearTimeout(timer); resolve(i) }
      this.waiters.push(waiter)
    })
  }
}
```

Modify `packages/server/src/canvas-server.ts`:

```ts
import { z } from 'zod'
import { IntentQueue } from './intent-queue.js'
import type { AgentStatus, Intent } from '@stackcanvas/core' // extend existing type import

const intentSchema = z.object({
  add: z.array(z.object({
    type: z.string().min(1),
    name: z.string().optional(),
    wishes: z.string().optional(),
    connect_to: z.array(z.string()),
  })),
  modify: z.array(z.object({ address: z.string().min(1), wishes: z.string() })),
  remove: z.array(z.object({ address: z.string().min(1) })),
})
```

Class additions:
```ts
  private intents = new IntentQueue()
  private agentStatus: AgentStatus = 'idle'

  awaitIntent(timeoutMs: number): Promise<Intent | null> { return this.intents.take(timeoutMs) }

  setAgentStatus(s: AgentStatus): void {
    this.agentStatus = s
    this.broadcast({ type: 'agent_status', status: s })
  }
```

In `buildApp()`, before the static handler:
```ts
    app.post('/api/intent', async c => {
      const parsed = intentSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid intent' }, 400)
      this.intents.push(parsed.data)
      return c.json({ queued: true }, 202)
    })
```

In the WS connect handler (Task 6), after sending the graph message, also send:
```ts
          ws.send(JSON.stringify({ type: 'agent_status', status: this.agentStatus }))
```

Export from `packages/server/src/index.ts`:
```ts
export { IntentQueue } from './intent-queue.js'
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm vitest run packages/server && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): intent queue with long-poll take and agent status broadcast"
```

---

### Task 8: core — graph summary (for the agent)

**Files:**
- Create: `packages/core/src/summarize.ts`
- Test: `packages/core/src/summarize.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `summarizeGraph(g: GraphModel): string` — compact text: resource count, count by type, pending plan changes.

- [ ] **Step 1: Write the failing test** — `packages/core/src/summarize.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { applyPlan } from './apply-plan.js'
import { parseState } from './parse-state.js'
import { summarizeGraph } from './summarize.js'

const load = (f: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8'))

test('summarizes counts and plan changes', () => {
  const text = summarizeGraph(applyPlan(parseState(load('state.json')), load('plan.json')))
  expect(text).toContain('5 resources')
  expect(text).toContain('aws_instance: 1')
  expect(text).toContain('update: aws_instance.web')
  expect(text).toContain('replace: aws_subnet.a')
  expect(text).toContain('create: aws_s3_bucket.assets')
})

test('no plan changes reported when everything is noop', () => {
  const text = summarizeGraph(parseState(load('state.json')))
  expect(text).toContain('No pending plan changes')
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run packages/core/src/summarize.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `packages/core/src/summarize.ts`:

```ts
import type { GraphModel } from './types.js'

export function summarizeGraph(g: GraphModel): string {
  const byType = new Map<string, number>()
  for (const n of g.nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1)
  const typeLines = [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, c]) => `  ${t}: ${c}`)
  const changes = g.nodes
    .filter(n => n.status !== 'noop')
    .map(n => `  ${n.status}: ${n.id}`)
    .sort()
  return [
    `${g.nodes.length} resources, ${g.edges.length} edges, ${g.groups.length} groups.`,
    'By type:',
    ...typeLines,
    changes.length ? 'Pending plan changes:' : 'No pending plan changes.',
    ...changes,
  ].join('\n')
}
```

Add to `packages/core/src/index.ts`:
```ts
export { summarizeGraph } from './summarize.js'
```

- [ ] **Step 4: Run, verify pass** — `pnpm vitest run packages/core && pnpm typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): graph summary for agent context"
```

---

### Task 9: mcp — stdio MCP server with 4 tools + `serve` dev subcommand

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/src/server.ts`, `packages/mcp/src/cli.ts`, `packages/mcp/src/open-browser.ts`
- Test: `packages/mcp/src/server.test.ts`

**Interfaces:**
- Consumes: `CanvasServer` from `@stackcanvas/server`; `summarizeGraph` from `@stackcanvas/core`.
- Produces:
  - `createMcpServer(deps?: { makeCanvas?: (dir: string) => CanvasServer; openBrowser?: (url: string) => void }): McpServer` — deps injectable for tests.
  - MCP tools: `open_canvas {dir}`, `load_plan {path}`, `get_graph_summary {}`, `await_canvas_intent {timeoutSeconds?}` (default 300).
  - CLI: `stackcanvas` (no args) = stdio MCP; `stackcanvas serve --dir <d> [--port <p>] [--fixture <state.json>]` = plain server for dev/e2e.

- [ ] **Step 1: Package skeleton**

`packages/mcp/package.json`:
```json
{
  "name": "stackcanvas",
  "version": "0.1.0",
  "type": "module",
  "main": "src/server.ts",
  "bin": { "stackcanvas": "./dist/cli.js" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@stackcanvas/core": "workspace:*",
    "@stackcanvas/server": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": { "@types/node": "^22.0.0" }
}
```

`packages/mcp/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run `pnpm install`.

- [ ] **Step 2: Write the failing test** — `packages/mcp/src/server.test.ts` (in-memory MCP client):

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasServer } from '@stackcanvas/server'
import { afterEach, expect, test } from 'vitest'
import { createMcpServer } from './server.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

let canvas: CanvasServer | undefined
afterEach(async () => { await canvas?.stop() })

async function connect() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  const opened: string[] = []
  const mcp = createMcpServer({
    makeCanvas: d => {
      canvas = new CanvasServer({ dir: d, runTerraformShow: async () => stateFixture })
      return canvas
    },
    openBrowser: url => { opened.push(url) },
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  return { client, dir, opened }
}

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text
}

test('open_canvas starts server, opens browser, returns URL', async () => {
  const { client, dir, opened } = await connect()
  const res = await client.callTool({ name: 'open_canvas', arguments: { dir } })
  expect(text(res)).toMatch(/http:\/\/127\.0\.0\.1:\d+/)
  expect(opened.length).toBe(1)
})

test('open_canvas rejects a non-terraform dir', async () => {
  const { client } = await connect()
  const empty = mkdtempSync(join(tmpdir(), 'sc-empty-'))
  const res = await client.callTool({ name: 'open_canvas', arguments: { dir: empty } })
  expect((res as { isError?: boolean }).isError).toBe(true)
  expect(text(res)).toContain('does not look like a Terraform root')
})

test('get_graph_summary returns the summary text', async () => {
  const { client, dir } = await connect()
  await client.callTool({ name: 'open_canvas', arguments: { dir } })
  const res = await client.callTool({ name: 'get_graph_summary', arguments: {} })
  expect(text(res)).toContain('resources')
})

test('await_canvas_intent returns queued intent as JSON', async () => {
  const { client, dir } = await connect()
  const openRes = await client.callTool({ name: 'open_canvas', arguments: { dir } })
  const url = text(openRes).match(/http:\/\/127\.0\.0\.1:\d+/)![0]
  const waiting = client.callTool({
    name: 'await_canvas_intent', arguments: { timeoutSeconds: 10 },
  })
  await fetch(`${url}/api/intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ add: [], modify: [], remove: [{ address: 'aws_vpc.main' }] }),
  })
  const res = await waiting
  expect(JSON.parse(text(res)).intent.remove[0].address).toBe('aws_vpc.main')
})

test('await_canvas_intent times out with null intent', async () => {
  const { client, dir } = await connect()
  await client.callTool({ name: 'open_canvas', arguments: { dir } })
  const res = await client.callTool({
    name: 'await_canvas_intent', arguments: { timeoutSeconds: 0.1 },
  })
  expect(JSON.parse(text(res)).intent).toBeNull()
})
```

- [ ] **Step 3: Run to verify failure** — `pnpm vitest run packages/mcp` → FAIL.

- [ ] **Step 4: Implement**

`packages/mcp/src/open-browser.ts`:
```ts
import { execFile } from 'node:child_process'

export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  execFile(cmd, args, () => { /* best-effort */ })
}
```

`packages/mcp/src/server.ts`:
```ts
import { existsSync, readdirSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { summarizeGraph } from '@stackcanvas/core'
import { CanvasServer } from '@stackcanvas/server'
import { z } from 'zod'
import { openBrowser as defaultOpenBrowser } from './open-browser.js'

function looksLikeTerraformRoot(dir: string): boolean {
  if (!existsSync(dir)) return false
  const entries = readdirSync(dir)
  return entries.some(f => f.endsWith('.tf') || f.endsWith('.tfstate'))
}

const ok = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }] })
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true })

export interface McpDeps {
  makeCanvas?: (dir: string) => CanvasServer
  openBrowser?: (url: string) => void
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const makeCanvas = deps.makeCanvas ?? ((dir: string) => new CanvasServer({ dir }))
  const open = deps.openBrowser ?? defaultOpenBrowser
  let canvas: CanvasServer | null = null
  let url: string | null = null

  const mcp = new McpServer({ name: 'stackcanvas', version: '0.1.0' })

  mcp.registerTool('open_canvas', {
    description:
      'Start (or reuse) the stackcanvas live infrastructure canvas for a Terraform root directory. '
      + 'Opens the UI in the browser and returns its URL.',
    inputSchema: { dir: z.string().describe('Absolute path to the Terraform root directory') },
  }, async ({ dir }) => {
    if (!looksLikeTerraformRoot(dir))
      return fail(`${dir} does not look like a Terraform root (no .tf or .tfstate files). `
        + 'Pass the directory that contains the Terraform configuration.')
    if (canvas && canvas.dir !== dir) { await canvas.stop(); canvas = null }
    if (!canvas) {
      canvas = makeCanvas(dir)
      const started = await canvas.start()
      url = started.url
      canvas.setAgentStatus('idle')
      open(url)
    }
    return ok(`Canvas running at ${url}. The graph live-updates as tfstate changes. `
      + 'Run `terraform plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json` '
      + 'to show the plan diff, then call await_canvas_intent to receive user edits.')
  })

  mcp.registerTool('load_plan', {
    description: 'Register a Terraform plan for diff highlighting on the canvas. '
      + 'Accepts a JSON plan (terraform show -json output) or a binary plan file.',
    inputSchema: { path: z.string().describe('Path to plan file (.json preferred)') },
  }, async ({ path }) => {
    if (!canvas) return fail('No canvas open. Call open_canvas first.')
    canvas.setAgentStatus('planning')
    try {
      await canvas.loadPlan(path)
      return ok('Plan loaded; canvas now highlights pending changes.')
    } catch (err) {
      return fail(`Failed to load plan: ${(err as Error).message}`)
    } finally {
      canvas.setAgentStatus('idle')
    }
  })

  mcp.registerTool('get_graph_summary', {
    description: 'Get a compact text summary of the current infrastructure graph.',
    inputSchema: {},
  }, async () => {
    if (!canvas) return fail('No canvas open. Call open_canvas first.')
    return ok(summarizeGraph(canvas.getGraph()))
  })

  mcp.registerTool('await_canvas_intent', {
    description: 'Block until the user clicks Apply on the canvas, then return their requested '
      + 'changes as intent JSON: {intent: {add, modify, remove} | null}. null = timeout, call again '
      + 'to keep waiting. After receiving an intent, write the Terraform code for it.',
    inputSchema: {
      timeoutSeconds: z.number().positive().max(3600).default(300)
        .describe('How long to wait before returning {intent: null}'),
    },
  }, async ({ timeoutSeconds }) => {
    if (!canvas) return fail('No canvas open. Call open_canvas first.')
    canvas.setAgentStatus('idle')
    const intent = await canvas.awaitIntent(timeoutSeconds * 1000)
    if (intent) canvas.setAgentStatus('writing')
    return ok(JSON.stringify({ intent }))
  })

  return mcp
}
```

`packages/mcp/src/cli.ts`:
```ts
#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CanvasServer } from '@stackcanvas/server'
import { createMcpServer } from './server.js'

const uiDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui-dist')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  if (process.argv[2] === 'serve') {
    const dir = arg('dir') ?? process.cwd()
    const fixture = arg('fixture')
    const port = arg('port')
    const server = new CanvasServer({
      dir,
      uiDist,
      port: port ? Number(port) : undefined,
      runTerraformShow: fixture ? async () => readFileSync(fixture, 'utf8') : undefined,
    })
    const { url } = await server.start()
    console.log(`stackcanvas serving ${dir} at ${url}`)
    return
  }
  const mcp = createMcpServer({
    makeCanvas: dir => new CanvasServer({ dir, uiDist }),
  })
  await mcp.connect(new StdioServerTransport())
}

void main()
```

- [ ] **Step 5: Run tests, verify pass, commit**

Run: `pnpm vitest run packages/mcp && pnpm typecheck`
Expected: all pass.

```bash
git add -A && git commit -m "feat(mcp): stdio server with open_canvas/load_plan/get_graph_summary/await_canvas_intent"
```

---

### Task 10: ui — scaffold + graph rendering with ELK layout

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vite.config.ts`, `packages/ui/index.html`, `packages/ui/src/main.tsx`, `packages/ui/src/App.tsx`, `packages/ui/src/store.ts`, `packages/ui/src/layout.ts`, `packages/ui/src/icons.tsx`, `packages/ui/src/nodes/ResourceNode.tsx`, `packages/ui/src/styles.css`

**Interfaces:**
- Consumes: `GraphModel` types from `@stackcanvas/core`; `GET /api/graph`.
- Produces:
  - zustand store `useStore` with `graph`, `stale: string | null`, `agentStatus`, `selected: string | null`, `collapsed: Set<string>`, actions `setGraph(g, stale)`, `setAgentStatus(s)`, `select(id)`, `toggleGroup(id)` — later tasks extend it.
  - `layoutGraph(model, collapsed): Promise<{ nodes: RFNode[]; edges: RFEdge[] }>` — React Flow nodes (`type: 'group' | 'resource'`, children use `parentId` + relative positions).
  - Custom node type `resource` reading `data: { label, type, provider, status, draft?: boolean, removed?: boolean, modified?: boolean }`.

- [ ] **Step 1: Scaffold the package**

`packages/ui/package.json`:
```json
{
  "name": "@stackcanvas/ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@stackcanvas/core": "workspace:*",
    "@xyflow/react": "^12.3.0",
    "elkjs": "^0.9.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0"
  }
}
```

`packages/ui/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext", "moduleResolution": "Bundler",
    "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

`packages/ui/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4680',
      '/ws': { target: 'ws://127.0.0.1:4680', ws: true },
    },
  },
})
```

`packages/ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>stackcanvas</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run `pnpm install`.

- [ ] **Step 2: Store, icons, node component**

`packages/ui/src/store.ts`:
```ts
import type { AgentStatus, GraphModel } from '@stackcanvas/core'
import { create } from 'zustand'

export interface StoreState {
  graph: GraphModel
  stale: string | null
  agentStatus: AgentStatus
  selected: string | null
  collapsed: Set<string>
  showPlan: boolean
  setGraph: (g: GraphModel, stale: string | null) => void
  setAgentStatus: (s: AgentStatus) => void
  select: (id: string | null) => void
  toggleGroup: (id: string) => void
  togglePlan: () => void
}

export const useStore = create<StoreState>(set => ({
  graph: { nodes: [], edges: [], groups: [] },
  stale: null,
  agentStatus: 'idle',
  selected: null,
  collapsed: new Set<string>(),
  showPlan: true,
  setGraph: (graph, stale) =>
    set(s => ({
      graph, stale,
      collapsed: graph.nodes.length > 150 && s.collapsed.size === 0
        ? new Set(graph.groups.map(g => g.id))
        : s.collapsed,
    })),
  setAgentStatus: agentStatus => set({ agentStatus }),
  select: selected => set({ selected }),
  toggleGroup: id => set(s => {
    const collapsed = new Set(s.collapsed)
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
    return { collapsed }
  }),
  togglePlan: () => set(s => ({ showPlan: !s.showPlan })),
}))
```

`packages/ui/src/icons.tsx` (inline SVG, no emoji):
```tsx
const glyphFor = (type: string): 'network' | 'compute' | 'database' | 'storage' | 'security' | 'messaging' | 'generic' => {
  if (/vpc|subnet|route53|cloudfront|lb|apigateway|nat|gateway/.test(type)) return 'network'
  if (/instance$|autoscaling|ecs|eks|lambda|launch/.test(type)) return 'compute'
  if (/db_|dynamodb|elasticache|rds/.test(type)) return 'database'
  if (/s3|ecr|log_group|efs/.test(type)) return 'storage'
  if (/iam|security_group|kms/.test(type)) return 'security'
  if (/sqs|sns|eventbridge|kinesis/.test(type)) return 'messaging'
  return 'generic'
}

export function ResourceIcon({ type }: { type: string }) {
  const glyph = glyphFor(type)
  const paths: Record<string, JSX.Element> = {
    network: <><circle cx="8" cy="8" r="6.5" fill="none" /><path d="M1.5 8h13M8 1.5c-2.5 2-2.5 11 0 13M8 1.5c2.5 2 2.5 11 0 13" fill="none" /></>,
    compute: <><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" /><rect x="5.5" y="5.5" width="5" height="5" /></>,
    database: <><ellipse cx="8" cy="3.5" rx="6" ry="2" fill="none" /><path d="M2 3.5v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9" fill="none" /></>,
    storage: <><rect x="2" y="4" width="12" height="9" rx="1" fill="none" /><path d="M2 7.5h12" fill="none" /></>,
    security: <path d="M8 1.5l5.5 2v4c0 3.5-2.3 6-5.5 7-3.2-1-5.5-3.5-5.5-7v-4z" fill="none" />,
    messaging: <path d="M2 4l6 4.5L14 4M2.5 3.5h11a1 1 0 011 1v7a1 1 0 01-1 1h-11a1 1 0 01-1-1v-7a1 1 0 011-1z" fill="none" />,
    generic: <rect x="3" y="3" width="10" height="10" rx="2" fill="none" />,
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.4" className="icon">
      {paths[glyph]}
    </svg>
  )
}
```

`packages/ui/src/nodes/ResourceNode.tsx`:
```tsx
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
```

- [ ] **Step 3: Layout** — `packages/ui/src/layout.ts`:

```ts
import type { GraphModel } from '@stackcanvas/core'
import type { Edge, Node } from '@xyflow/react'
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'

const elk = new ELK()
const NODE_W = 190
const NODE_H = 52

export async function layoutGraph(
  model: GraphModel,
  collapsed: Set<string>,
  showPlan: boolean,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  // Effective group for a node: nearest non-collapsed ancestor chain is kept;
  // if any ancestor is collapsed, the node is hidden and its topmost collapsed
  // ancestor is rendered as a plain collapsed box.
  const groupById = new Map(model.groups.map(g => [g.id, g]))
  const isHidden = (group: string | null): string | null => {
    let cur = group
    let hiddenUnder: string | null = null
    while (cur) {
      if (collapsed.has(cur)) hiddenUnder = cur
      cur = groupById.get(cur)?.parent ?? null
    }
    return hiddenUnder
  }

  const visibleNodes = model.nodes.filter(n => !isHidden(n.group))
  const representedCollapsed = new Set(
    model.nodes.map(n => isHidden(n.group)).filter((x): x is string => x !== null),
  )

  const elkChildrenFor = (parent: string | null): ElkNode[] => [
    ...model.groups
      .filter(g => g.parent === parent && !isHidden(g.parent) && !collapsed.has(g.id))
      .map(g => ({
        id: g.id,
        layoutOptions: { 'elk.padding': '[top=36,left=12,bottom=12,right=12]' },
        children: elkChildrenFor(g.id),
      })),
    ...[...representedCollapsed]
      .filter(id => groupById.get(id)?.parent === parent)
      .map(id => ({ id, width: NODE_W, height: NODE_H })),
    ...visibleNodes
      .filter(n => n.group === parent)
      .map(n => ({ id: n.id, width: NODE_W, height: NODE_H })),
  ]

  const visibleIds = new Set([...visibleNodes.map(n => n.id), ...representedCollapsed])
  const nodeAnchor = (id: string): string | null => {
    if (visibleIds.has(id)) return id
    const n = model.nodes.find(x => x.id === id)
    return n ? isHidden(n.group) : null
  }
  const elkEdges = model.edges
    .map(e => ({ id: e.id, from: nodeAnchor(e.source), to: nodeAnchor(e.target) }))
    .filter(e => e.from && e.to && e.from !== e.to)
    .map(e => ({ id: e.id, sources: [e.from as string], targets: [e.to as string] }))

  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '24',
    },
    children: elkChildrenFor(null),
    edges: elkEdges,
  })

  const rfNodes: Node[] = []
  const nodesById = new Map(model.nodes.map(n => [n.id, n]))
  const walk = (elkNode: ElkNode, parentId?: string): void => {
    for (const child of elkNode.children ?? []) {
      const model2 = nodesById.get(child.id)
      const isGroup = groupById.has(child.id)
      rfNodes.push({
        id: child.id,
        type: isGroup && !collapsed.has(child.id) ? 'group' : 'resource',
        position: { x: child.x ?? 0, y: child.y ?? 0 },
        ...(parentId ? { parentId, extent: 'parent' as const } : {}),
        style: isGroup && !collapsed.has(child.id)
          ? { width: child.width, height: child.height }
          : undefined,
        data: isGroup
          ? { label: groupById.get(child.id)!.label, type: groupById.get(child.id)!.kind,
              provider: '', status: 'noop', collapsedGroup: collapsed.has(child.id) }
          : {
              label: model2?.name ?? child.id,
              type: model2?.type ?? '',
              provider: model2?.provider ?? '',
              status: showPlan ? model2?.status ?? 'noop' : 'noop',
            },
      })
      walk(child, child.id)
    }
  }
  walk(res)

  const rfEdges: Edge[] = elkEdges.map(e => ({
    id: e.id, source: e.sources[0], target: e.targets[0],
  }))
  return { nodes: rfNodes, edges: rfEdges }
}
```

- [ ] **Step 4: App shell + styles**

`packages/ui/src/App.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { layoutGraph } from './layout.js'
import { ResourceNode } from './nodes/ResourceNode.js'
import { useStore } from './store.js'

const nodeTypes = { resource: ResourceNode }

export function App() {
  const { graph, collapsed, showPlan, stale, agentStatus, select, toggleGroup, togglePlan } = useStore()
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] })

  useEffect(() => {
    let cancelled = false
    void layoutGraph(graph, collapsed, showPlan).then(f => { if (!cancelled) setFlow(f) })
    return () => { cancelled = true }
  }, [graph, collapsed, showPlan])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">stackcanvas</span>
        <button onClick={togglePlan}>{showPlan ? 'Hide plan' : 'Show plan'}</button>
        <span className={`agent-badge agent-${agentStatus}`}>agent: {agentStatus}</span>
        {stale && <span className="stale-banner" role="alert">stale: {stale}</span>}
      </header>
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if ((node.data as { collapsedGroup?: boolean }).collapsedGroup) toggleGroup(node.id)
          else select(node.id)
        }}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
      </ReactFlow>
    </div>
  )
}
```

`packages/ui/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
```

`packages/ui/src/styles.css`:
```css
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; }
.app { width: 100vw; height: 100vh; display: flex; flex-direction: column; }
.topbar { display: flex; gap: 12px; align-items: center; padding: 8px 14px;
  border-bottom: 1px solid #e2e8f0; background: #fff; z-index: 10; }
.brand { font-weight: 700; }
.agent-badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #f1f5f9; }
.agent-writing { background: #fef9c3; }
.agent-planning { background: #dbeafe; }
.stale-banner { color: #b91c1c; font-size: 12px; }
.resource-node { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border: 1.5px solid #94a3b8; border-radius: 8px; background: #fff; width: 190px; }
.resource-node .labels { display: flex; flex-direction: column; overflow: hidden; }
.resource-node .name { font-size: 13px; font-weight: 600; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.resource-node .type { font-size: 10px; color: #64748b; }
.status-create { border-color: #22c55e; box-shadow: 0 0 0 2px #22c55e33; }
.status-update { border-color: #eab308; box-shadow: 0 0 0 2px #eab30833; }
.status-delete { border-color: #ef4444; box-shadow: 0 0 0 2px #ef444433; }
.status-replace { border-color: #a855f7; box-shadow: 0 0 0 2px #a855f733; }
.draft { border-style: dashed; opacity: 0.85; }
.removed { border-style: dashed; border-color: #ef4444; opacity: 0.6; text-decoration: line-through; }
.modified::after { content: ""; position: absolute; }
.react-flow__node-group { border-radius: 10px; border: 1px dashed #cbd5e1; background: #f8fafc80; }
```

- [ ] **Step 5: Verify with the dev fixture server and commit**

Run (two terminals or background):
```bash
pnpm exec tsx packages/mcp/src/cli.ts serve --dir /tmp --fixture packages/core/test/fixtures/state.json --port 4680 &
pnpm --filter @stackcanvas/ui dev
```
Open the Vite URL; expected: graph with VPC group containing subnet group, nodes with icons. Then:
```bash
pnpm --filter @stackcanvas/ui build && pnpm typecheck
git add -A && git commit -m "feat(ui): react-flow canvas with elk layout, groups, status styling"
```

---

### Task 11: ui — live WS updates + initial fetch

**Files:**
- Create: `packages/ui/src/ws.ts`
- Modify: `packages/ui/src/App.tsx`

**Interfaces:**
- Consumes: WS `/ws` messages `{type:'graph'|'agent_status'}` from Task 6/7; `GET /api/graph`.
- Produces: `connectLive(): () => void` — fetches initial graph, opens WS, reconnects every 2s while closed, dispatches to store.

- [ ] **Step 1: Implement** — `packages/ui/src/ws.ts`:

```ts
import type { AgentStatus, GraphModel } from '@stackcanvas/core'
import { useStore } from './store.js'

type WsMessage =
  | { type: 'graph'; graph: GraphModel; stale: string | null }
  | { type: 'agent_status'; status: AgentStatus }

export function connectLive(): () => void {
  let ws: WebSocket | null = null
  let closed = false

  void fetch('/api/graph').then(r => r.json()).then((g: GraphModel) =>
    useStore.getState().setGraph(g, null),
  ).catch(() => { /* WS will retry */ })

  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onmessage = e => {
      const msg = JSON.parse(e.data as string) as WsMessage
      if (msg.type === 'graph') useStore.getState().setGraph(msg.graph, msg.stale)
      else if (msg.type === 'agent_status') useStore.getState().setAgentStatus(msg.status)
    }
    ws.onclose = () => { if (!closed) setTimeout(open, 2000) }
  }
  open()
  return () => { closed = true; ws?.close() }
}
```

- [ ] **Step 2: Wire into App** — in `packages/ui/src/App.tsx` add:

```tsx
import { connectLive } from './ws.js'
// inside App(), first hook:
  useEffect(() => connectLive(), [])
```

- [ ] **Step 3: Verify manually**

With the fixture serve command from Task 10 running and UI open via the *server* URL (`http://127.0.0.1:4680` won't have Vite proxy issues once uiDist exists — during dev use Vite URL): touch the fixture-watched dir is not applicable in fixture mode, so verify: reload page → graph appears via initial fetch; stop the serve process → within ~2s console shows reconnect attempts; restart serve → graph returns without reload.

Run: `pnpm --filter @stackcanvas/ui build && pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(ui): live websocket updates with reconnect"
```

---

### Task 12: ui — inspector panel with attribute diff

**Files:**
- Create: `packages/ui/src/Inspector.tsx`
- Modify: `packages/ui/src/App.tsx`, `packages/ui/src/styles.css`

**Interfaces:**
- Consumes: `useStore` (`graph`, `selected`, `select`).
- Produces: right-hand panel; used by Task 13/14 for draft wishes editing (`draftWishes` prop pattern established here).

- [ ] **Step 1: Implement** — `packages/ui/src/Inspector.tsx`:

```tsx
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
```

- [ ] **Step 2: Wire into App and style**

`App.tsx`: render `<Inspector />` as a sibling after `<ReactFlow …>` inside a new wrapper `<div className="canvas-row">` that contains ReactFlow + Inspector side by side.

`styles.css` additions:
```css
.canvas-row { flex: 1; display: flex; min-height: 0; }
.canvas-row > .react-flow { flex: 1; }
.inspector { width: 320px; border-left: 1px solid #e2e8f0; padding: 12px; overflow: auto;
  background: #fff; font-size: 13px; }
.inspector-head { display: flex; justify-content: space-between; align-items: center; }
.inspector table { width: 100%; border-collapse: collapse; }
.inspector td { border-top: 1px solid #f1f5f9; padding: 4px 6px; vertical-align: top;
  word-break: break-all; }
.inspector .before code { color: #b91c1c; text-decoration: line-through; }
.inspector .after code { color: #15803d; }
.status-pill, .type-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: #f1f5f9; margin-right: 6px; }
```

- [ ] **Step 3: Verify + commit**

Run fixture serve + UI dev (Task 10 Step 5 commands); click `aws_instance.web`; expected: inspector shows attributes; with a plan fixture loaded it shows before/after rows.
Run: `pnpm --filter @stackcanvas/ui build && pnpm typecheck` → clean.

```bash
git add -A && git commit -m "feat(ui): node inspector with plan attribute diff"
```

---

### Task 13: ui — palette, draft layer, Apply → intent, copy-as-prompt

**Files:**
- Create: `packages/ui/src/palette.ts`, `packages/ui/src/Palette.tsx`, `packages/ui/src/intent.ts`
- Modify: `packages/ui/src/store.ts`, `packages/ui/src/App.tsx`, `packages/ui/src/Inspector.tsx`, `packages/ui/src/styles.css`
- Test: `packages/ui/src/intent.test.ts`

**Interfaces:**
- Produces:
  - Store additions: `drafts: DraftNode[]`, `draftEdges: {source: string; target: string}[]`, `modifies: Record<string,string>`, `removes: Set<string>`, actions `addDraft(type)`, `setDraftWishes(id, w)`, `setDraftName(id, name)`, `addDraftEdge(s,t)`, `requestModify(address, wishes)`, `toggleRemove(address)`, `clearDrafts()`. `DraftNode = { id: string; type: string; name?: string; wishes?: string }` (draft ids: `draft-1`, `draft-2`, …).
  - `buildIntent(state): Intent` and `buildPrompt(intent): string` (pure, unit-tested).
  - UI: left palette (click to add), Apply button POSTs `/api/intent` and clears drafts on 202, Copy-prompt button puts `buildPrompt` text on the clipboard.

- [ ] **Step 1: Write the failing test** — `packages/ui/src/intent.test.ts`:

```ts
import { expect, test } from 'vitest'
import { buildIntent, buildPrompt } from './intent.js'

const state = {
  drafts: [{ id: 'draft-1', type: 'aws_db_instance', name: 'app_db', wishes: 'small instance' }],
  draftEdges: [
    { source: 'aws_vpc.main', target: 'draft-1' },
    { source: 'draft-1', target: 'draft-1' },
  ],
  modifies: { 'aws_instance.web': 'bump root volume to 50gb' },
  removes: new Set(['aws_s3_bucket.legacy']),
}

test('buildIntent maps drafts, connections, modifies, removes', () => {
  const intent = buildIntent(state)
  expect(intent).toEqual({
    add: [{ type: 'aws_db_instance', name: 'app_db', wishes: 'small instance',
            connect_to: ['aws_vpc.main'] }],
    modify: [{ address: 'aws_instance.web', wishes: 'bump root volume to 50gb' }],
    remove: [{ address: 'aws_s3_bucket.legacy' }],
  })
})

test('buildPrompt renders human-readable instructions', () => {
  const text = buildPrompt(buildIntent(state))
  expect(text).toContain('ADD aws_db_instance')
  expect(text).toContain('connected to: aws_vpc.main')
  expect(text).toContain('MODIFY aws_instance.web')
  expect(text).toContain('REMOVE aws_s3_bucket.legacy')
  expect(text).toContain('.stackcanvas/plan.json')
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run packages/ui` → FAIL.
  (Note: vitest root config already includes `packages/**/*.test.ts`; the ui tsconfig uses Bundler resolution — vitest handles it.)

- [ ] **Step 3: Implement intent module** — `packages/ui/src/intent.ts`:

```ts
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
    modify: Object.entries(s.modifies).map(([address, wishes]) => ({ address, wishes })),
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
```

- [ ] **Step 4: Run intent tests, verify pass** — `pnpm vitest run packages/ui` → PASS.

- [ ] **Step 5: Palette data** — `packages/ui/src/palette.ts`:

```ts
export const PALETTE: { type: string; label: string }[] = [
  { type: 'aws_vpc', label: 'VPC' },
  { type: 'aws_subnet', label: 'Subnet' },
  { type: 'aws_security_group', label: 'Security group' },
  { type: 'aws_instance', label: 'EC2 instance' },
  { type: 'aws_autoscaling_group', label: 'Auto Scaling group' },
  { type: 'aws_lb', label: 'Load balancer' },
  { type: 'aws_lb_target_group', label: 'Target group' },
  { type: 'aws_ecs_cluster', label: 'ECS cluster' },
  { type: 'aws_ecs_service', label: 'ECS service' },
  { type: 'aws_eks_cluster', label: 'EKS cluster' },
  { type: 'aws_lambda_function', label: 'Lambda' },
  { type: 'aws_apigatewayv2_api', label: 'API Gateway' },
  { type: 'aws_db_instance', label: 'RDS instance' },
  { type: 'aws_dynamodb_table', label: 'DynamoDB table' },
  { type: 'aws_elasticache_cluster', label: 'ElastiCache' },
  { type: 'aws_s3_bucket', label: 'S3 bucket' },
  { type: 'aws_ecr_repository', label: 'ECR repo' },
  { type: 'aws_cloudfront_distribution', label: 'CloudFront' },
  { type: 'aws_route53_zone', label: 'Route53 zone' },
  { type: 'aws_route53_record', label: 'Route53 record' },
  { type: 'aws_sqs_queue', label: 'SQS queue' },
  { type: 'aws_sns_topic', label: 'SNS topic' },
  { type: 'aws_cloudwatch_log_group', label: 'Log group' },
  { type: 'aws_iam_role', label: 'IAM role' },
  { type: 'aws_iam_policy', label: 'IAM policy' },
]
```

- [ ] **Step 6: Store extensions** — add to `packages/ui/src/store.ts` state/actions (extend `StoreState`):

```ts
  drafts: { id: string; type: string; name?: string; wishes?: string }[]
  draftEdges: { source: string; target: string }[]
  modifies: Record<string, string>
  removes: Set<string>
  addDraft: (type: string) => void
  setDraftName: (id: string, name: string) => void
  setDraftWishes: (id: string, wishes: string) => void
  addDraftEdge: (source: string, target: string) => void
  requestModify: (address: string, wishes: string) => void
  toggleRemove: (address: string) => void
  clearDrafts: () => void
```

Implementation inside `create()`:
```ts
  drafts: [],
  draftEdges: [],
  modifies: {},
  removes: new Set<string>(),
  addDraft: type => set(s => ({
    drafts: [...s.drafts, { id: `draft-${s.drafts.length + 1}-${type}`, type }],
  })),
  setDraftName: (id, name) => set(s => ({
    drafts: s.drafts.map(d => (d.id === id ? { ...d, name } : d)),
  })),
  setDraftWishes: (id, wishes) => set(s => ({
    drafts: s.drafts.map(d => (d.id === id ? { ...d, wishes } : d)),
  })),
  addDraftEdge: (source, target) => set(s => ({
    draftEdges: [...s.draftEdges, { source, target }],
  })),
  requestModify: (address, wishes) => set(s => ({
    modifies: { ...s.modifies, [address]: wishes },
  })),
  toggleRemove: address => set(s => {
    const removes = new Set(s.removes)
    if (removes.has(address)) removes.delete(address)
    else removes.add(address)
    return { removes }
  }),
  clearDrafts: () => set({ drafts: [], draftEdges: [], modifies: {}, removes: new Set() }),
```

- [ ] **Step 7: Palette component + App wiring**

`packages/ui/src/Palette.tsx`:
```tsx
import { useState } from 'react'
import { ResourceIcon } from './icons.js'
import { PALETTE } from './palette.js'
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
```

`App.tsx` changes:
- Render `<Palette />` before ReactFlow inside `.canvas-row`.
- Merge drafts into the flow after layout:

```tsx
  const { drafts, draftEdges, modifies, removes, addDraftEdge, clearDrafts } = useStore()
  const draftNodes: Node[] = drafts.map((d, i) => ({
    id: d.id,
    type: 'resource',
    position: { x: 40 + i * 30, y: 40 + i * 60 },
    data: { label: d.name ?? d.type, type: d.type, provider: 'aws', status: 'noop', draft: true },
  }))
  const decoratedNodes = flow.nodes.map(n => ({
    ...n,
    data: { ...n.data, removed: removes.has(n.id), modified: n.id in modifies },
  }))
  const allNodes = [...decoratedNodes, ...draftNodes]
  const allEdges = [
    ...flow.edges,
    ...draftEdges.map((e, i) => ({
      id: `draft-edge-${i}`, source: e.source, target: e.target, animated: true,
    })),
  ]
```
- Pass `nodes={allNodes} edges={allEdges}` and `onConnect={c => { if (c.source && c.target) addDraftEdge(c.source, c.target) }}`.
- Topbar buttons:

```tsx
  const pendingCount = drafts.length + Object.keys(modifies).length + removes.size
  const apply = async () => {
    const intent = buildIntent(useStore.getState())
    const res = await fetch('/api/intent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    })
    if (res.status === 202) clearDrafts()
  }
  const copyPrompt = async () => {
    await navigator.clipboard.writeText(buildPrompt(buildIntent(useStore.getState())))
  }
  // in the header:
  <button className="apply" disabled={pendingCount === 0} onClick={() => void apply()}>
    Apply ({pendingCount})
  </button>
  <button disabled={pendingCount === 0} onClick={() => void copyPrompt()}>Copy as prompt</button>
```

`Inspector.tsx`: when `selected` is a draft id (starts with `draft-`), render name + wishes inputs bound to `setDraftName`/`setDraftWishes` instead of the attributes table; when the selected node is in `modifies`, render a wishes textarea bound to `requestModify`.

`styles.css` additions:
```css
.palette { width: 200px; border-right: 1px solid #e2e8f0; padding: 10px; overflow: auto;
  background: #fff; display: flex; flex-direction: column; gap: 4px; }
.palette-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; cursor: pointer;
  font-size: 12px; text-align: left; }
.palette-item:hover { background: #f1f5f9; }
.palette-custom { display: flex; gap: 4px; margin-top: 8px; }
.palette-custom input { flex: 1; min-width: 0; font-size: 12px; padding: 4px; }
.apply { background: #0f172a; color: #fff; border: none; border-radius: 6px;
  padding: 6px 14px; cursor: pointer; }
.apply:disabled { opacity: 0.4; }
```

- [ ] **Step 8: Verify + commit**

Run fixture serve + UI dev; click "RDS instance" in palette → dashed draft node appears; drag a connection from `aws_vpc.main` to it; click Apply → in the serve terminal the POST arrives (add temporary `curl http://127.0.0.1:4680/api/graph` sanity if needed); Copy as prompt puts text in clipboard.
Run: `pnpm vitest run packages/ui && pnpm --filter @stackcanvas/ui build && pnpm typecheck` → clean.

```bash
git add -A && git commit -m "feat(ui): palette, draft layer, apply intent, copy-as-prompt"
```

---

### Task 14: ui — context menu for modify/remove on existing nodes

**Files:**
- Create: `packages/ui/src/ContextMenu.tsx`
- Modify: `packages/ui/src/App.tsx`, `packages/ui/src/styles.css`

**Interfaces:**
- Consumes: store actions `requestModify`, `toggleRemove`, `select` from Task 13.
- Produces: right-click on a non-draft node → menu with "Request change" (selects node, seeds `modifies[address] = ''`, opens inspector wishes field) and "Mark for removal" / "Unmark removal".

- [ ] **Step 1: Implement** — `packages/ui/src/ContextMenu.tsx`:

```tsx
import { useStore } from './store.js'

export interface MenuState { x: number; y: number; nodeId: string }

export function ContextMenu({ menu, close }: { menu: MenuState; close: () => void }) {
  const { removes, requestModify, toggleRemove, select } = useStore()
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
      <button onClick={() => { requestModify(menu.nodeId, ''); select(menu.nodeId); close() }}>
        Request change
      </button>
      <button onClick={() => { toggleRemove(menu.nodeId); close() }}>
        {removes.has(menu.nodeId) ? 'Unmark removal' : 'Mark for removal'}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Wire into App**

```tsx
  const [menu, setMenu] = useState<MenuState | null>(null)
  // on ReactFlow:
  onNodeContextMenu={(e, node) => {
    e.preventDefault()
    if (!node.id.startsWith('draft-') && node.type === 'resource')
      setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
  }}
  onPaneClick={() => { setMenu(null); select(null) }}
  // after ReactFlow:
  {menu && <ContextMenu menu={menu} close={() => setMenu(null)} />}
```

`styles.css`:
```css
.context-menu { position: fixed; z-index: 50; background: #fff; border: 1px solid #e2e8f0;
  border-radius: 8px; box-shadow: 0 8px 24px #0002; display: flex; flex-direction: column;
  min-width: 170px; overflow: hidden; }
.context-menu button { border: none; background: none; text-align: left; padding: 8px 12px;
  cursor: pointer; font-size: 13px; }
.context-menu button:hover { background: #f1f5f9; }
```

- [ ] **Step 3: Verify + commit**

Fixture serve + UI dev: right-click `aws_instance.web` → menu; "Mark for removal" → node dashed red + Apply counter increments; "Request change" → inspector opens with wishes textarea.
Run: `pnpm --filter @stackcanvas/ui build && pnpm typecheck` → clean.

```bash
git add -A && git commit -m "feat(ui): context menu for modify/remove requests"
```

---

### Task 15: e2e — Playwright smoke suite

**Files:**
- Create: `playwright.config.ts`, `e2e/canvas.spec.ts`, `e2e/fixtures/tfroot/main.tf` (empty file to satisfy root check)
- Modify: root `package.json` (add script + devDependency)

**Interfaces:**
- Consumes: `stackcanvas serve --fixture` from Task 9; built UI from Task 10 (`packages/ui/dist` passed via env `STACKCANVAS_UI_DIST` is NOT needed — cli resolves `packages/mcp/ui-dist`; for e2e we copy the build there first).

- [ ] **Step 1: Config**

Root `package.json` additions:
```json
  "scripts": {
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck",
    "e2e": "pnpm --filter @stackcanvas/ui build && rm -rf packages/mcp/ui-dist && cp -R packages/ui/dist packages/mcp/ui-dist && playwright test"
  },
  "devDependencies": { "@playwright/test": "^1.48.0" }
```
Run `pnpm install && pnpm exec playwright install chromium`.

`e2e/fixtures/tfroot/main.tf`:
```hcl
# placeholder terraform root for e2e (fixture data comes from --fixture)
```

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://127.0.0.1:4681' },
  webServer: {
    command:
      'pnpm exec tsx packages/mcp/src/cli.ts serve --dir e2e/fixtures/tfroot '
      + '--fixture packages/core/test/fixtures/state.json --port 4681',
    url: 'http://127.0.0.1:4681/api/graph',
    reuseExistingServer: false,
  },
})
```

- [ ] **Step 2: Write the tests** — `e2e/canvas.spec.ts`:

```ts
import { expect, test } from '@playwright/test'

test('renders the fixture graph', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('aws_instance', { exact: true })).toBeVisible()
  await expect(page.getByText('web', { exact: true })).toBeVisible()
})

test('palette click creates a dashed draft and Apply posts the intent', async ({ page }) => {
  await page.goto('/')
  const posted = page.waitForRequest(r => r.url().includes('/api/intent') && r.method() === 'POST')
  await page.getByRole('button', { name: 'RDS instance' }).click()
  await expect(page.locator('.resource-node.draft')).toBeVisible()
  await page.getByRole('button', { name: /^Apply/ }).click()
  const req = await posted
  const body = req.postDataJSON() as { add: { type: string }[] }
  expect(body.add[0].type).toBe('aws_db_instance')
  await expect(page.locator('.resource-node.draft')).toHaveCount(0)
})

test('context menu marks a node for removal', async ({ page }) => {
  await page.goto('/')
  await page.getByText('web', { exact: true }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Mark for removal' }).click()
  await expect(page.locator('.resource-node.removed')).toBeVisible()
})
```

- [ ] **Step 3: Run**

Run: `pnpm e2e`
Expected: 3 tests pass. If the exact-text locators collide with the inspector, scope them: `page.locator('.react-flow').getByText(...)`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(e2e): playwright smoke for render, draft+apply, removal"
```

---

### Task 16: packaging — publishable npm package + Claude Code plugin + skill

**Files:**
- Create: `packages/mcp/tsup.config.ts`, `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/skills/stackcanvas/SKILL.md`
- Modify: `packages/mcp/package.json`, root `package.json`

**Interfaces:**
- Consumes: everything prior.
- Produces: `pnpm build:pkg` → `packages/mcp/dist/cli.js` (self-contained, workspace deps bundled) + `packages/mcp/ui-dist/`; `npx stackcanvas` works from the packed tarball.

- [ ] **Step 1: tsup config** — `packages/mcp/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  noExternal: ['@stackcanvas/core', '@stackcanvas/server'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
})
```

`packages/mcp/package.json` changes:
```json
  "files": ["dist", "ui-dist", "README.md"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsup"
  },
  "devDependencies": { "@types/node": "^22.0.0", "tsup": "^8.0.0" }
```

Root `package.json` script:
```json
    "build:pkg": "pnpm --filter @stackcanvas/ui build && rm -rf packages/mcp/ui-dist && cp -R packages/ui/dist packages/mcp/ui-dist && pnpm --filter stackcanvas build"
```

- [ ] **Step 2: Plugin files**

`plugin/.claude-plugin/plugin.json`:
```json
{
  "name": "stackcanvas",
  "description": "Live infrastructure canvas for Claude Code: watch the agent build your Terraform, drag new resources, the agent writes the HCL.",
  "version": "0.1.0",
  "author": { "name": "kp" }
}
```

`plugin/.mcp.json`:
```json
{
  "mcpServers": {
    "stackcanvas": { "command": "npx", "args": ["-y", "stackcanvas"] }
  }
}
```

`plugin/skills/stackcanvas/SKILL.md`:
```markdown
---
name: stackcanvas
description: Open a live visual canvas of the Terraform infrastructure in this repo and enter the collaborative loop where the user draws changes and you write the HCL. Use when the user asks to visualize infrastructure, open the canvas, or build infra visually.
---

# stackcanvas loop

1. Call `open_canvas` with the absolute path to the Terraform root of this repo
   (the directory containing the `.tf` files).
2. If state exists, run `terraform plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json`
   so the canvas highlights pending changes. Add `.stackcanvas/` to .gitignore if missing.
3. Enter the loop:
   a. Call `await_canvas_intent` (default timeout 300s).
   b. If the result is `{"intent": null}`, call it again — unless the user has asked
      you to stop or the conversation has moved on.
   c. When an intent arrives: write idiomatic HCL for every `add`/`modify`/`remove`
      entry, matching the existing repo style and module layout. `wishes` fields are
      the user's free-text requirements — honor them. `connect_to` lists existing
      resource addresses the new resource must reference.
   d. Run `terraform plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json`.
      The canvas updates automatically. NEVER run `terraform apply` unless the user
      explicitly asks.
   e. Briefly tell the user what you changed, then go back to (a).
4. `get_graph_summary` is available whenever you need the current graph in text form.
```

- [ ] **Step 3: Verify the packed package**

```bash
pnpm build:pkg
cd packages/mcp && npm pack --dry-run
node dist/cli.js serve --dir ../../e2e/fixtures/tfroot --fixture ../core/test/fixtures/state.json --port 4699 &
curl -s http://127.0.0.1:4699/api/graph | head -c 200
curl -s http://127.0.0.1:4699/ | head -c 100   # expect <!doctype html>
kill %1
```
Expected: tarball lists `dist/cli.js` + `ui-dist/**`; both curls return content.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: packaging (tsup bundle), claude code plugin and skill"
```

---

### Task 17: demo repo + README

**Files:**
- Create: `examples/demo/main.tf`, `README.md`

**Interfaces:**
- Consumes: nothing new; demo exercises the whole loop manually.

- [ ] **Step 1: Demo config** — `examples/demo/main.tf`:

```hcl
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "stackcanvas-demo" }
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_security_group" "web" {
  vpc_id = aws_vpc.main.id
}

resource "aws_instance" "web" {
  ami                    = "ami-0c02fb55956c7d316"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.app.id
  vpc_security_group_ids = [aws_security_group.web.id]
}

resource "aws_s3_bucket" "assets" {
  bucket_prefix = "stackcanvas-demo-"
}
```

- [ ] **Step 2: README** — `README.md`:

```markdown
# stackcanvas

Live infrastructure canvas for [Claude Code](https://claude.com/claude-code).
The agent writes and plans your Terraform — stackcanvas shows it as a living
diagram. Drag new resources onto the canvas; the agent turns them into
idiomatic HCL. No SaaS, no credentials leave your machine: everything runs on
localhost, reading your local state and plan.

## How it works

1. `open_canvas` starts a local web UI for your Terraform root.
2. The graph re-renders live whenever `*.tfstate` or `.stackcanvas/plan.json`
   change — you watch the agent work.
3. You drag resources from the palette (or right-click existing ones to
   request changes / removal) and hit **Apply**.
4. The agent receives your edits as a structured intent via
   `await_canvas_intent`, writes the HCL, runs `terraform plan`, and the
   canvas highlights what will change. Only the agent executes Terraform —
   the canvas has no apply button by design.

## Install (Claude Code)

    claude plugin add stackcanvas

or add the MCP server manually:

    claude mcp add stackcanvas -- npx -y stackcanvas

Then, inside a repo with Terraform:

    /stackcanvas

## Tools

| Tool | Purpose |
|------|---------|
| `open_canvas` | Start the canvas for a Terraform root, open the browser |
| `load_plan` | Register a plan (JSON or binary) for diff highlighting |
| `get_graph_summary` | Text summary of the graph for the agent |
| `await_canvas_intent` | Block until the user clicks Apply; returns their edits |

## Demo

`examples/demo` contains a small AWS config. Run `terraform init && terraform
plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json`
there (no apply needed, no AWS account touched by plan with these resources
until refresh) and open the canvas to see create-highlighting.

## Development

    pnpm install
    pnpm test          # unit + integration
    pnpm e2e           # playwright smoke
    pnpm build:pkg     # build the publishable package

## License

MIT
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm test && pnpm typecheck` (full suite green).

```bash
git add -A && git commit -m "docs: README and demo terraform config"
```

---

## Self-Review (done at planning time)

- **Spec coverage:** parser+masking (T2), edges+containment (T3), diff engine (T4), server+API (T5), watcher+WS+plan (T6), intent queue+agent status (T7), summary (T8), 4 MCP tools+CLI (T9), canvas+layout+collapse (T10), live updates (T11), inspector (T12), palette+drafts+apply+copy-prompt (T13), modify/remove menu (T14), Playwright smoke (T15), packaging+plugin+skill (T16), demo+README (T17). Spec items all mapped. Static export, drift, UI apply — explicitly out, matching spec.
- **Placeholder scan:** no TBD/TODO; all steps carry code or exact commands.
- **Type consistency:** `GraphModel/GraphNode/Intent/AgentStatus` defined once in T2 and imported everywhere; `CanvasServer` signatures in T5 Interfaces match usage in T6/T7/T9/T15; store action names in T13 match usage in T14.
- Known judgment call: Task 3 modifies one Task 2 assertion (containment changes the db node's group) — flagged inside Task 3 Step 4 so it's not a surprise.
