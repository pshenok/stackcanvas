import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { TerraformProvider } from './terraform.js'

const execFileAsync = promisify(execFile)

// Real-binary integration coverage for TerraformProvider (P2-13, issue #27).
// Gated on STACKCANVAS_IT_TF_BIN so `pnpm test` never depends on a
// terraform/tofu install: skipped entirely (not run-and-fail) when the env
// var is unset. The CI `it-tf` matrix job sets it once per binary (see
// ci.yml) — 'terraform' via hashicorp/setup-terraform, 'tofu' via
// opentofu/setup-opentofu. The value is the binary's PATH name or an
// absolute path, passed straight to TerraformProvider's `binary` option,
// which resolveTfBinary() then uses verbatim (no probing).
const tfBin = process.env.STACKCANVAS_IT_TF_BIN

// Entirely offline: the fixture config uses only `terraform_data`, which
// lives in the "terraform.io/builtin/terraform" provider bundled with the
// binary since Terraform 1.4 (OpenTofu ships the same builtin) — `init`
// resolves it locally and never touches the network, so this runs safely
// in CI with no credentials and on a laptop with no connectivity.
describe.skipIf(!tfBin)('TerraformProvider (real binary via STACKCANVAS_IT_TF_BIN)', () => {
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sc-tf-it-'))
    writeFileSync(join(dir, 'main.tf'), [
      'resource "terraform_data" "example" {',
      '  input = "hello-integration"',
      '}',
      '',
    ].join('\n'))
    const bin = tfBin as string
    await execFileAsync(bin, ['init', '-input=false', '-no-color'], { cwd: dir })
    await execFileAsync(bin, ['apply', '-auto-approve', '-input=false', '-no-color'], { cwd: dir })
  }, 45_000)

  afterAll(async () => {
    if (!dir) return
    // Best-effort: terraform_data has no real infra behind it, and the temp
    // dir itself is left for the OS to reclaim, but tearing down keeps a
    // reused tmpdir clean across repeated local runs.
    await execFileAsync(tfBin as string, ['destroy', '-auto-approve', '-input=false', '-no-color'], { cwd: dir })
      .catch(() => {})
  }, 30_000)

  test('refresh() against the real binary produces a snapshot containing the terraform_data node', async () => {
    const provider = new TerraformProvider({ dir, binary: tfBin })
    try {
      const snap = await provider.refresh()
      expect(snap.stale).toBeNull()
      const node = snap.graph.nodes.find(n => n.id === 'terraform_data.example')
      expect(node).toBeDefined()
      expect(node?.type).toBe('terraform_data')
      // resolveTfBinary was actually exercised (explicit path, no probing).
      expect(provider.binaryUsed).toBe(tfBin)
    } finally {
      await provider.dispose()
    }
  }, 20_000)

  test('a plan written to .stackcanvas/plan.json flows to node statuses', async () => {
    // Change the input so the next plan has a real diff to report.
    writeFileSync(join(dir, 'main.tf'), [
      'resource "terraform_data" "example" {',
      '  input = "hello-integration-changed"',
      '}',
      '',
    ].join('\n'))
    const stackcanvasDir = join(dir, '.stackcanvas')
    mkdirSync(stackcanvasDir, { recursive: true })
    const planFile = join(dir, 'tfplan.bin')
    const planJsonPath = join(stackcanvasDir, 'plan.json')
    const bin = tfBin as string

    await execFileAsync(bin, ['plan', '-input=false', '-no-color', `-out=${planFile}`], { cwd: dir })
    const { stdout } = await execFileAsync(
      bin, ['show', '-json', planFile], { cwd: dir, maxBuffer: 64 * 1024 * 1024 },
    )
    writeFileSync(planJsonPath, stdout)

    const provider = new TerraformProvider({ dir, binary: tfBin })
    try {
      const snap = await provider.loadPlan(planJsonPath)
      const node = snap.graph.nodes.find(n => n.id === 'terraform_data.example')
      expect(node?.status).toBe('update')
    } finally {
      await provider.dispose()
    }
  }, 20_000)
})
