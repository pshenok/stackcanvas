# Releasing stackcanvas

This is the runbook for cutting a release of the `stackcanvas` npm package
and its Claude Code plugin. It's written for the founder (the only person
with npm publish access today) but every step before the manual `npm
publish` is either a script or CI, so anyone with a merged PR could run it.

Design context: [`docs/SPEC.md`](docs/SPEC.md)'s "Telemetry, CI matrix,
release & registry engineering" chapter, §5 ("npm release flow").

## tl;dr

```
node scripts/bump-version.mjs 0.2.0   # locally, on a clean tree
git add -A && git commit -m "release: v0.2.0" && git push
# open a PR, get it merged to main
gh workflow run release.yml -f version=0.2.0
# watch it go green, then:
cd packages/mcp && npm publish --access public --otp=<code>
```

The rest of this document is the detail behind each of those lines, plus
what to do when things aren't the happy path.

## Why release.yml doesn't publish to npm

Two constraints collide:

- The founder's npm account requires **2FA on every publish** — a laptop
  `npm publish --otp=<code>` is the only way to authenticate as a human
  today.
- npm **provenance attestations** (the "Built and signed on GitHub Actions"
  badge) can only be generated from a supported CI running over OIDC — a
  laptop publish can never carry one.

Rather than pick one, `release.yml` does everything that *can* be
automated — verify, build, pack, tag, draft the GitHub Release — and stops
one command short of publishing. The stopping point is the `publish` job in
`.github/workflows/release.yml`, which is fully written but shipped with
`if: false`: **npm trusted publishing (OIDC)** is the real long-term fix
(no npm token ever stored in this repo's secrets, and it's the only way to
get provenance without giving up 2FA-for-humans), but it requires one-time
setup on npmjs.com that hasn't happened yet. See "Enabling npm trusted
publishing" below for exactly what to do when that setup is done. Until
then, every release is published by hand with an OTP, and that version's
release notes carry no provenance badge — noted inline, not hidden.

## Step by step

### 1. Bump the version

On a clean working tree (commit or stash first — the script refuses
otherwise):

```
node scripts/bump-version.mjs <patch|minor|major|x.y.z>
```

This rewrites, in lockstep:

- `packages/mcp/package.json` — `"version"`
- `plugin/.claude-plugin/plugin.json` — `"version"`
- `packages/mcp/src/version.ts` — the exported `VERSION` constant (the MCP
  protocol version string and `TelemetryEnvelope.app_version` both read
  this at runtime)
- `plugin/.mcp.json` — pins the npx invocation to `stackcanvas@<version>`
  (Claude Code installs from the plugin `.mcp.json`, so this is what
  actually pins the version users get)
- `packages/scan-aws/package.json`, once that package exists (see "Second
  published package" below) — the two published packages version-lock

It prints the resulting version to stdout and exits non-zero (with no files
touched) if the tree is dirty, the spec isn't `patch`/`minor`/`major`/a
valid `x.y.z`, or any target file doesn't look like the shape it expects.
Run `node scripts/bump-version.mjs --help` for the full usage.

`node scripts/check-plugin.mjs` (also the CI `check-plugin` job) verifies
all of the above stayed in sync — run it locally as a sanity check before
committing.

### 2. Commit, PR, merge

```
git add -A
git commit -m "release: v<version>"
git push -u origin <branch>
```

Open a PR, let CI (`ci.yml`) go green, merge to `main`. Nothing about the
version bump requires special review beyond normal CI — it's plain data
changes in four files.

### 3. Dispatch the release workflow

From `main`, after the version-bump PR is merged:

```
gh workflow run release.yml -f version=<version>
```

(or: GitHub → Actions → "Release" → "Run workflow", type the version into
the form). The `version` input **must** equal `packages/mcp/package.json`'s
version on the ref you dispatch against — the workflow's first job
(`check-version`) fails fast with a clear message if it doesn't, before
spending CI minutes on the rest.

`release.yml` then, in order:

1. **`verify`** — runs the exact same workflow every PR runs (`ci.yml`,
   called as a reusable workflow: unit tests on Node 20/22, `check-plugin`,
   the telemetry-collector suite, Playwright e2e). No separate copy of these
   steps to keep in sync.
2. **`build`** — `pnpm build:pkg`, then `npm pack` inside `packages/mcp`,
   uploads the resulting tarball as a workflow artifact named
   `stackcanvas-<version>`.
3. **`publish`** — scaffolded, `if: false`. Skipped today; see above.
4. **`tag-and-release`** — creates and pushes the `v<version>` git tag
   (fails if it already exists — no silent re-tagging), then creates a
   GitHub Release via `gh release create --generate-notes`, with the
   tarball attached and a header paragraph (prepended to the generated
   notes) containing the exact manual publish command for this version.

Watch the run; if `verify` is red, nothing downstream happens and nothing
external changed — fix and re-dispatch (the `tag-and-release` job also
refuses to reuse an existing tag, so a botched partial run is safe to
re-run after a fix).

### 4. Publish to npm, by hand

Once the workflow is green, from a local clone at the tagged commit (or
using the tarball attached to the GitHub Release, inspected first):

```
git fetch --tags && git checkout v<version>
cd packages/mcp
npm publish --access public --otp=<code>
```

`<code>` is the 2FA one-time code from the founder's authenticator. This is
the one step in the whole flow that's genuinely manual and stays that way
until npm trusted publishing is enabled (next section) — it is also copied
verbatim into the GitHub Release body by `tag-and-release`, so there's
never a question of what command to run.

Sanity-check before publishing: `npm pack --dry-run` inside `packages/mcp`
should list `dist/**`, `ui-dist/**`, and `README.md`, and nothing from
`src/`.

### 5. Verify the release

- `npx stackcanvas@<version>` cold-starts cleanly in a scratch directory.
- `npm view stackcanvas version` shows the new version.
- The GitHub Release page shows the tarball and generated notes.
- `node scripts/check-plugin.mjs` on `main` still passes (it does — nothing
  in this flow un-syncs the manifests).

### Rollback

If something is wrong before step 4 (npm publish): delete the tag
(`git push --delete origin v<version>`) and the GitHub Release, fix the
issue, and re-dispatch `release.yml` with the same version — the workflow
refuses to reuse an existing tag, so this is safe. If something is wrong
**after** npm publish: npm allows unpublishing only within 72 hours and
only if no other package depends on the version — prefer a fixed `patch`
release over unpublishing.

## Enabling npm trusted publishing

Do this once, when there's time to set it up carefully (not mid-release):

1. On npmjs.com, on the `stackcanvas` package → **Settings** → **Publishing
   access** → add a **Trusted publisher**: GitHub Actions, repository
   `pshenok/stackcanvas`, workflow `release.yml`, environment
   `npm-publish`.
2. On the same package settings, enable **"Require two-factor
   authentication and disallow tokens"** — this makes the trusted-publisher
   OIDC flow the *only* non-human publish path, matching the local-first
   trust story this project already tells about credentials.
3. In this repo's GitHub settings, create the `npm-publish` **environment**
   (Settings → Environments) with a required reviewer (the founder) — this
   is what makes the automated publish still require a manual
   click-approval, preserving the "manual" property even once it's
   automated end-to-end.
4. In `.github/workflows/release.yml`, flip the `publish` job's `if: false`
   to `if: true` (or delete the line). No other change is needed —
   `permissions.id-token: write` is already granted at the workflow level,
   and `npm publish --provenance` picks up the OIDC token automatically
   once step 1 is configured.
5. Update step 4 above ("Publish to npm, by hand") to note that it's now
   the fallback path for an npm OIDC outage, not the primary path — and
   that fallback publishes carry no provenance badge, which is fine and
   should be noted in that release's notes if it happens.

## Second published package: `@stackcanvas/scan-aws`

Per `docs/SPEC.md`'s source-graph and AWS live-scan chapters, AWS scan
support ships as `@stackcanvas/scan-aws`, a **second** published npm
package, loaded by `stackcanvas` via dynamic `import('@stackcanvas/scan-aws')`
on first scan (so it costs nothing until used) rather than as a plugin
dependency of its own — `plugin/.mcp.json` never references it. The two
packages **version-lock**: same version number, always, because the
scanner's API-skew guard assumes it. Once `packages/scan-aws/` exists as a
workspace package:

- `scripts/bump-version.mjs` already bumps `packages/scan-aws/package.json`
  in the same run as the other four files — no change needed there, it's
  guarded by `existsSync` and currently a no-op.
- `scripts/check-plugin.mjs` already asserts `packages/scan-aws/package.json`'s
  version matches `packages/mcp/package.json`'s, once the file exists — also
  already a no-op today.
- `.github/workflows/release.yml` needs one addition: a second `npm pack`
  (in the `build` job) and, once trusted publishing is enabled, a second
  `npm publish --provenance --access public` step (in the `publish` job,
  `working-directory: packages/scan-aws`) under its own npmjs.com
  trusted-publisher registration (same repo, same `release.yml` workflow,
  its own package). The manual-publish fallback in step 4 above gets a
  second line: `cd packages/scan-aws && npm publish --access public
  --otp=<code>`.
- `tag-and-release` doesn't change — one git tag and one GitHub Release
  still cover both packages, since they always ship at the same version.

## Plugin marketplace update

Nothing beyond the steps above. This repo *is* its own Claude Code
marketplace (`.claude-plugin/marketplace.json` at the repo root points at
`./plugin`), so the moment the version-bump commit lands on `main`:

- `claude plugin marketplace add pshenok/stackcanvas` /
  `claude plugin update stackcanvas@stackcanvas` picks up the new
  `plugin/.claude-plugin/plugin.json` version and the newly-pinned
  `plugin/.mcp.json` (`npx -y stackcanvas@<version>`) — no separate
  marketplace publish step exists or is needed.
- The CI `check-plugin` job (part of `verify` above) is what keeps this
  honest — a release can't go green if the plugin manifest and the npm
  package version disagree.

## Launch-ops checklist (Stage 1, non-code)

Per `docs/VISION.md` §5 (Stage 1) and `docs/SPEC.md` §3.2's M1 table —
these are checklist items, not code, and are **not** automated by
`release.yml`; do them once, around the v0.2.0 cut, alongside the first
real publish:

- [ ] **Verify every market stat in launch copy against its primary
      source** before posting anywhere (the 93%/34%/20% figures referenced
      in `docs/VISION.md`) — unverifiable numbers ship hedged or not at
      all. A misquoted stat is a reputational tripwire in exactly the
      community (HN, r/devops, Terraform) this is launched into.
  - [ ] Cursor and Windsurf setups are either verified-and-documented in
        the README, or the multi-client claim is explicitly dropped — no
        silent unfalsifiable claim either way (tracked separately in M1-3 /
        issue history; re-check it's still true at launch time).
- [ ] **GitHub Sponsors** enabled on the repo (Settings → Sponsor this
      project), tiers matching `docs/VISION.md` §6 ($5/$25/$100 individual
      + $500–1k/mo corporate).
- [ ] **README email capture** — an actual link/form for people who want
      updates without watching the repo (e.g. a Substack/Buttondown
      signup link near the top of `README.md`).
- [ ] **Pinned "would you pay for this" GitHub Discussion** — opened and
      pinned before or at launch, referenced from the README, so the
      earliest interest signal is captured in public and durably (not
      scattered across HN/Reddit comment threads).
- [ ] Telemetry is live end-to-end (`t.stackcanvas.dev` responding — see
      `telemetry-collector/README.md`) *before* launch traffic hits, so the
      2026-08-15 gate's numbers start accruing from day one, not from
      whenever someone notices the collector was never deployed.

These feed the **2026-08-15 publish gate** (hard: publish or archive) and
arm the **2026-10-15 retention gate** — see `docs/VISION.md` §5 for what
those gates read.
