import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProviderSnapshot } from '@stackcanvas/core'
import { defaultRunner, TerraformProvider } from './terraform.js'

const stateFixture = readFileSync(
  new URL('../../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)
const planFixture = readFileSync(
  new URL('../../../core/test/fixtures/plan.json', import.meta.url), 'utf8',
)

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-tf-'))
  writeFileSync(join(dir, 'main.tf'), 'resource "aws_vpc" "main" {}')
  return dir
}

// Polls instead of a single fixed sleep: under a parallel test run, chokidar
// event delivery + the debounce timer can slip well past a couple hundred ms
// (CI/dev-machine scheduling noise), so a one-shot wait is flaky where a
// bounded poll is not.
async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

let provider: TerraformProvider | undefined
afterEach(async () => {
  await provider?.dispose()
  provider = undefined
})

test('origin, refreshOnStart, and label reflect a terraform-backed provider', () => {
  const dir = makeDir()
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture })
  expect(provider.origin).toBe('terraform')
  expect(provider.refreshOnStart).toBe(true)
  expect(provider.label).toContain(dir)
})

test('defaultRunner is still exported for backcompat', () => {
  expect(typeof defaultRunner).toBe('function')
})

test('refresh() returns a parsed graph with stale: null', async () => {
  const dir = makeDir()
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture })
  const snap = await provider.refresh()
  expect(snap.origin).toBe('terraform')
  expect(snap.stale).toBeNull()
  expect(snap.graph.nodes.some(n => n.id === 'aws_vpc.main')).toBe(true)
})

test('refresh({force: true}) behaves identically — no cache to bypass', async () => {
  const dir = makeDir()
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture })
  const plain = await provider.refresh()
  const forced = await provider.refresh({ force: true })
  expect(forced.graph).toEqual(plain.graph)
  expect(forced.stale).toBeNull()
})

test('refresh({onProgress}) never invokes the callback', async () => {
  const dir = makeDir()
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture })
  const onProgress = vi.fn()
  await provider.refresh({ onProgress })
  expect(onProgress).not.toHaveBeenCalled()
})

test('runner throw keeps the last good graph and sets stale instead of rejecting', async () => {
  const dir = makeDir()
  let fail = false
  provider = new TerraformProvider({
    dir, runShow: async () => { if (fail) throw new Error('boom'); return stateFixture },
  })
  const good = await provider.refresh()
  expect(good.stale).toBeNull()
  fail = true
  const bad = await provider.refresh()
  expect(bad.stale).toBe('boom')
  expect(bad.graph).toEqual(good.graph) // last good kept
})

test('loadPlan applies plan statuses; a malformed plan file rejects', async () => {
  const dir = makeDir()
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture })
  mkdirSync(join(dir, '.stackcanvas'))
  const planPath = join(dir, '.stackcanvas', 'plan.json')
  writeFileSync(planPath, planFixture)
  const snap = await provider.loadPlan(planPath)
  const web = snap.graph.nodes.find(n => n.id === 'aws_instance.web')
  expect(web?.status).toBe('update')

  const badPath = join(dir, '.stackcanvas', 'bad.json')
  writeFileSync(badPath, '{ not json')
  await expect(provider.loadPlan(badPath)).rejects.toThrow()
})

test('watch() fires exactly one push within the debounce window when tfstate changes', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'terraform.tfstate'), '{}')
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture, debounceMs: 100 })
  await provider.init()
  const pushes: ProviderSnapshot[] = []
  provider.watch(s => pushes.push(s))
  // A burst of writes should collapse into a single debounced push.
  writeFileSync(join(dir, 'terraform.tfstate'), '{"serial": 1}')
  writeFileSync(join(dir, 'terraform.tfstate'), '{"serial": 2}')
  await waitFor(() => pushes.length > 0)
  // Give any further (unwanted) debounced pushes a chance to land before
  // asserting there was exactly one.
  await new Promise(r => setTimeout(r, 400))
  expect(pushes.length).toBe(1)
  expect(pushes[0]?.origin).toBe('terraform')
  expect(pushes[0]?.graph.nodes.length).toBeGreaterThan(0)
}, 15000)

test('watcher auto-loads .stackcanvas/plan.json created after watch() starts', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'terraform.tfstate'), '{}')
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture, debounceMs: 100 })
  await provider.init()
  const pushes: ProviderSnapshot[] = []
  provider.watch(s => pushes.push(s))
  mkdirSync(join(dir, '.stackcanvas'))
  writeFileSync(join(dir, '.stackcanvas', 'plan.json'), planFixture)
  await waitFor(() => pushes.some(s => s.graph.nodes.find(n => n.id === 'aws_instance.web')?.status === 'update'))
  const last = pushes[pushes.length - 1]
  const web = last?.graph.nodes.find(n => n.id === 'aws_instance.web')
  expect(web?.status).toBe('update')
}, 15000)

test('dispose() then a file change fires no further push', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'terraform.tfstate'), '{}')
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture, debounceMs: 100 })
  await provider.init()
  const pushes: ProviderSnapshot[] = []
  provider.watch(s => pushes.push(s))
  await provider.dispose()
  writeFileSync(join(dir, 'terraform.tfstate'), '{"serial": 99}')
  await new Promise(r => setTimeout(r, 800))
  expect(pushes.length).toBe(0)
}, 15000)

test('dispose() is idempotent — calling it twice resolves cleanly', async () => {
  const dir = makeDir()
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture })
  await provider.init()
  await provider.dispose()
  await expect(provider.dispose()).resolves.toBeUndefined()
})
