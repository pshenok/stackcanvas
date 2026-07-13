import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProviderSnapshot } from '@stackcanvas/core'
import { binaryKind, defaultRunner, resolveTfBinary, TerraformProvider } from './terraform.js'

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

// ---------------------------------------------------------------------------
// resolveTfBinary / createShowRunner / binaryKind (P2-12, issue #26)
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs()
})

test('resolveTfBinary: explicit argument wins over everything, without probing', async () => {
  const probe = vi.fn(async () => true)
  const bin = await resolveTfBinary('/custom/path/mytf', { probe })
  expect(bin).toBe('/custom/path/mytf')
  expect(probe).not.toHaveBeenCalled()
})

test('resolveTfBinary: STACKCANVAS_TF_BIN env wins over PATH probing', async () => {
  vi.stubEnv('STACKCANVAS_TF_BIN', 'my-tofu-fork')
  const probe = vi.fn(async () => true)
  const bin = await resolveTfBinary(undefined, { probe })
  expect(bin).toBe('my-tofu-fork')
  expect(probe).not.toHaveBeenCalled()
})

test('resolveTfBinary: explicit argument wins over STACKCANVAS_TF_BIN too', async () => {
  vi.stubEnv('STACKCANVAS_TF_BIN', 'env-bin')
  const probe = vi.fn(async () => true)
  const bin = await resolveTfBinary('explicit-bin', { probe })
  expect(bin).toBe('explicit-bin')
  expect(probe).not.toHaveBeenCalled()
})

test('resolveTfBinary: PATH fallback probes terraform before tofu, stopping on first pass', async () => {
  const calls: string[] = []
  const probe = vi.fn(async (bin: string) => { calls.push(bin); return bin === 'terraform' })
  const bin = await resolveTfBinary(undefined, { probe })
  expect(bin).toBe('terraform')
  expect(calls).toEqual(['terraform']) // tofu never probed once terraform passes
})

test('resolveTfBinary: falls through to tofu when the terraform probe fails silently', async () => {
  const calls: string[] = []
  const probe = vi.fn(async (bin: string) => { calls.push(bin); return bin === 'tofu' })
  const bin = await resolveTfBinary(undefined, { probe })
  expect(bin).toBe('tofu')
  expect(calls).toEqual(['terraform', 'tofu'])
})

test('resolveTfBinary: returns null when neither terraform nor tofu probes succeed', async () => {
  const probe = vi.fn(async () => false)
  const bin = await resolveTfBinary(undefined, { probe })
  expect(bin).toBeNull()
})

test('resolveTfBinary performs a fresh probe on every call — no internal caching, so a later '
  + 'call recovers once a binary becomes available (re-probe recovery)', async () => {
  let installed = false
  const probe = vi.fn(async (bin: string) => installed && bin === 'terraform')
  expect(await resolveTfBinary(undefined, { probe })).toBeNull()
  installed = true
  expect(await resolveTfBinary(undefined, { probe })).toBe('terraform')
})

test('binaryKind maps a resolved binary to terraform/tofu/unknown by basename', () => {
  expect(binaryKind('terraform')).toBe('terraform')
  expect(binaryKind('/usr/local/bin/terraform')).toBe('terraform')
  expect(binaryKind('terraform.exe')).toBe('terraform')
  expect(binaryKind('tofu')).toBe('tofu')
  expect(binaryKind('/opt/homebrew/bin/tofu')).toBe('tofu')
  expect(binaryKind('some-custom-wrapper')).toBe('unknown')
  expect(binaryKind(null)).toBe('unknown')
})

// ---------------------------------------------------------------------------
// TerraformProvider binary detection wiring (P2-12) — hermetic PATH swap via
// real (fake) executables, so it exercises the real execFile probe/runner
// wiring without depending on terraform/tofu actually being installed.
// ---------------------------------------------------------------------------

function writeFakeBinary(dir: string, name: string): void {
  const path = join(dir, name)
  // Responds to `version` (the resolveTfBinary probe) and `show -json ...`
  // (the runner) with just enough to satisfy parseState. Uses only shell
  // builtins (echo/if/exit) — no external PATH-resolved commands — so it
  // works even when PATH is stubbed down to just this fake-bin dir.
  writeFileSync(path, [
    '#!/bin/sh',
    'if [ "$1" = "version" ]; then exit 0; fi',
    'echo \'{"format_version":"1.0","values":{"root_module":{"resources":[]}}}\'',
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
}

test('TerraformProvider: no injected runShow and no binary on PATH resolves to '
  + 'stale + binaryUsed null', async () => {
  const dir = makeDir()
  const emptyPathDir = mkdtempSync(join(tmpdir(), 'sc-emptypath-'))
  vi.stubEnv('PATH', emptyPathDir) // hermetic: real terraform/tofu on this machine is unreachable
  provider = new TerraformProvider({ dir })
  const snap = await provider.refresh()
  expect(provider.binaryUsed).toBeNull()
  expect(snap.stale).toBe('No terraform or tofu binary found in PATH. Install one or set STACKCANVAS_TF_BIN.')
  expect(provider.label).toBe(`Terraform (${dir})`)
}, 15000)

test('TerraformProvider: re-probes and recovers once a binary appears on PATH, no restart needed', async () => {
  const dir = makeDir()
  const emptyPathDir = mkdtempSync(join(tmpdir(), 'sc-emptypath-'))
  vi.stubEnv('PATH', emptyPathDir)
  provider = new TerraformProvider({ dir })
  const first = await provider.refresh()
  expect(first.stale).not.toBeNull()
  expect(provider.binaryUsed).toBeNull()

  const fakeBinDir = mkdtempSync(join(tmpdir(), 'sc-fakebin-'))
  writeFakeBinary(fakeBinDir, 'terraform')
  vi.stubEnv('PATH', fakeBinDir)

  const second = await provider.refresh()
  expect(second.stale).toBeNull()
  expect(provider.binaryUsed).toBe('terraform')
  expect(provider.label).toBe(`Terraform (${dir}) via terraform`)
}, 15000)

test('TerraformProvider: an injected runShow skips probing entirely — binaryUsed stays null', async () => {
  const dir = makeDir()
  provider = new TerraformProvider({ dir, runShow: async () => stateFixture })
  await provider.refresh()
  expect(provider.binaryUsed).toBeNull()
  expect(provider.label).toBe(`Terraform (${dir})`)
})

test('TerraformProvider: an explicit binary option is used verbatim, skipping probing', async () => {
  const dir = makeDir()
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'sc-fakebin-'))
  writeFakeBinary(fakeBinDir, 'tofu')
  vi.stubEnv('PATH', fakeBinDir)
  provider = new TerraformProvider({ dir, binary: 'tofu' })
  const snap = await provider.refresh()
  expect(provider.binaryUsed).toBe('tofu')
  expect(snap.stale).toBeNull()
  expect(provider.label).toBe(`Terraform (${dir}) via tofu`)
})
