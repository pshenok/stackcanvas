# Telemetry

stackcanvas can send a small amount of **anonymous, opt-in** usage telemetry
to help prioritize development. This document is the complete, authoritative
description of what that is, when it happens, and how to turn it off. If
anything in the product disagrees with this file, treat it as a bug in the
product, not in this file — [`packages/server/src/telemetry.ts`](packages/server/src/telemetry.ts)
has a test (`envelope allowlist tripwire`, in
[`telemetry.test.ts`](packages/server/src/telemetry.test.ts)) that fails the
build the moment the code sends a field that isn't documented here.

## tl;dr

- **Off by default.** Nothing is ever sent until you click **Allow** on the
  one-time consent banner in the canvas UI.
- **Five counters, ever.** Installs, canvases opened, edits sent (by kind),
  scans run, and drift-lens opens. No resource names, no infrastructure
  data, no file paths, no IPs.
- **One vendor endpoint, source included.** `https://t.stackcanvas.dev/e`, a
  small Cloudflare Worker whose source lives in this repo. It is the *only*
  network endpoint stackcanvas' own code ever calls out to.
- **Three ways to turn it off:** click "No thanks", set `DO_NOT_TRACK=1`, or
  set `STACKCANVAS_TELEMETRY=0`.

## Consent model

Consent has four possible states:

| State | Meaning |
|---|---|
| `unset` | Default. Nothing has ever been sent. The consent banner shows once. |
| `granted` | You clicked **Allow**. Events are sent as described below. |
| `denied` | You clicked **No thanks**. Nothing is sent, ever, until you change your mind (there is currently no UI to re-open the banner after a `denied` decision short of editing the config file below). |
| `disabled_env` | An environment variable overrides everything else (see below). Nothing is sent, the banner never shows, and nothing is written to disk. |

The MCP server itself runs over stdio and has no way to prompt you, so the
**canvas web UI is the only consent surface**. The first time you open a
canvas with consent `unset`, a banner appears:

> Anonymous usage counters (no resource names, no infra data) help
> prioritize development — see TELEMETRY.md.
> **[Allow]** **[No thanks]**

Clicking either button persists the decision (see "Config file" below) and
the banner never reappears.

### Opt-out mechanisms (all three win over everything else)

1. **"No thanks"** in the banner — persists `consent: "denied"` to the config
   file.
2. **`DO_NOT_TRACK=1`** — the ambient convention some CLIs respect. Forces
   `disabled_env`, regardless of what's in the config file.
3. **`STACKCANVAS_TELEMETRY=0`** — stackcanvas-specific equivalent. Also
   forces `disabled_env`, regardless of what's in the config file.

`STACKCANVAS_TELEMETRY=1` is **not** an opt-out mechanism and does **not**
grant consent by itself — opt-in must be an explicit click. Setting it only
un-hides the banner if the stored decision was `denied`, letting you
re-decide.

## Config file

`~/.stackcanvas/config.json` (path overridable with `STACKCANVAS_CONFIG_DIR`,
used by this repo's own test suite and e2e run to stay hermetic — see
`vitest.config.ts` / `playwright.config.ts`):

```jsonc
{
  "telemetry": {
    "consent": "granted",              // "granted" | "denied"
    "anonId": "1c9f6a8e-…",            // random UUIDv4, minted at the moment of grant, deleted on deny
    "decidedAt": "2026-07-12",         // UTC date the consent decision was made
    "installReportedAt": "2026-07-12"  // dedupe marker: the 'install' event fires at most once, ever
  }
}
```

`anonId` is a coin-flip UUID — there is no MAC address, hostname, or user
identifier hashed into it, no fingerprinting of any kind. Denying consent
deletes `anonId` from the file. Config writes are atomic (`.tmp` + rename);
a crash mid-write just means the banner may show again next launch.

## When events fire, and by what path

Four of the five events are emitted **directly** by server- or MCP-side code
that already holds a `TelemetryClient` — they never touch the browser:

| Event | Fires when | Code |
|---|---|---|
| `install` | The *first* time you ever click "Allow" (deduped forever via `installReportedAt`) | `TelemetryClient.setConsent(true)`, [`telemetry.ts`](packages/server/src/telemetry.ts) |
| `canvas_opened` | Every successful `CanvasServer.start()` — covers both `stackcanvas serve` and the MCP `open_canvas` tool (which calls `start()` once per new canvas, never again for a reused one) | [`canvas-server.ts`](packages/server/src/canvas-server.ts) |
| `intent_sent` | Every valid `POST /api/intent` (i.e. every **Apply** click on the canvas), counted by action kind *after* validation/normalization | [`canvas-server.ts`](packages/server/src/canvas-server.ts) |
| `scan_run` | Reserved for the live-scan feature; not emitted by any code yet | — |

`drift_opened` is the **one** browser-originated event (the drift lens is
UI-only, it has no server-side trigger). It never goes straight from the
browser to the collector — it travels:

```
browser  →  POST /api/telemetry/event { name: "drift_opened" }  →  CanvasServer  →  TelemetryClient.emit()  →  collector
```

`POST /api/telemetry/event` re-checks `consent === "granted"` server-side
(it never trusts the browser's belief about its own state) and validates
`name` against a **server-side allowlist narrower than the full event set**
— currently just `["drift_opened"]` — so a browser can never spoof
`install`/`canvas_opened`/`intent_sent`/`scan_run`. An unknown `name` gets a
`400`; a known name with consent not `granted` still returns `200 {ok:
true}` so the response never leaks your consent state. This route (like
every `/api/*` POST route: `/api/intent`, `/api/telemetry`,
`/api/telemetry/event`) is also behind a Host/Origin allowlist
(`127.0.0.1|localhost`, any port) that rejects anything that isn't a
same-machine request.

`emit()` itself is a hard no-op unless `getConsent() === "granted"`. When it
does run: it builds the envelope below and does
`fetch(endpoint, { method: "POST", body, signal: AbortSignal.timeout(3000) }).catch(() => {})`
— fire-and-forget, 3-second timeout, no retries, no local queue (losing an
event is fine; storing unsent events on disk is not), and no logging to
stdout or stderr (stdout is the MCP protocol channel; a stray log line would
corrupt it).

## Exactly what is sent

Every event is wrapped in the same envelope. **This is the complete list —
nothing else is ever added to it without a documented schema-version bump.**

```ts
interface TelemetryEnvelope {
  schema: 1            // TELEMETRY_SCHEMA_VERSION, telemetry.ts
  anon_id: string       // random UUIDv4, see "Config file" above
  day: string            // "YYYY-MM-DD", UTC — the finest time precision that ever leaves the machine
  app_version: string    // the published `stackcanvas` npm package version
  platform: "darwin" | "linux" | "win32" | "other"
  node_major: number     // e.g. 22
  payload: TelemetryProps  // one of the five shapes below
}
```

The five `payload` shapes — **every field of every event, verbatim**:

```ts
{ event: "install" }

{ event: "canvas_opened", nodes_bucket: NodesBucket, tf_bin: "terraform" | "tofu" | "unknown" }

{ event: "intent_sent", add: number, modify: number, remove: number, adopt: number, investigate: number }
// each counter capped at 50; adopt/investigate are always 0 until the
// intent-v2 pipeline ships (reserved now so no schema bump is needed later)

{ event: "scan_run", provider: "aws" | "gcp" | "azure" | "other", nodes_bucket: NodesBucket }
// reserved — no code emits this yet; ships with the live-scan feature

{ event: "drift_opened", nodes_bucket: NodesBucket }
// reserved — no UI calls this yet; ships with the drift-lens feature.
// The forwarding route (POST /api/telemetry/event) already exists (above).
```

```ts
type NodesBucket = "0" | "1-10" | "11-50" | "51-200" | "200+"
```

`nodes_bucket` is a coarse bucket of your Terraform graph's node count
(computed by `nodesBucket()` in `telemetry.ts`) — never the actual count,
never any resource identity.

## What is never collected

- Resource **names, types, addresses, or attributes** (beyond the coarse
  node-count bucket above)
- File paths, directory names, repo names
- IP addresses, hostnames, MAC addresses, or any device fingerprint
- Cloud account IDs, ARNs, or any other cloud-provider identifier
- Timestamps finer than a UTC **day**
- Anything not listed in the schema above — enforced by the "envelope
  allowlist tripwire" test (see "How to verify" below)

## The collector

**Endpoint:** `https://t.stackcanvas.dev/e` (`POST` only). A small
self-hosted Cloudflare Worker, source in this repo at
`telemetry-worker/worker.ts` (ships with the collector-deployment increment;
until then, consent-gated code paths in this repo are wired to POST there,
but no code path can ever reach it without an explicit "Allow" click). It
validates every envelope against the same hard allowlist described above
(rejects unknown keys, unknown `event`, a non-UUID `anon_id`, counts over
50, or a malformed `day`), writes one row to Workers Analytics Engine and
mirrors the raw envelope as one line to an R2 bucket, and responds `204` on
success / `400` otherwise. It stores no cookies, reads no client IP, and
has CORS closed (only this repo's own server-side code calls it — never the
browser directly, see "When events fire" above).

**PostHog / third-party analytics were evaluated and rejected**: a
third-party processor breaks the "no cloud backend of ours, fully
auditable" story this project is built on, and its SDKs pull in
batching/retry/persistent-queue machinery this project deliberately doesn't
want. The client here is a single `fetch` call.

### Vendor-endpoint carve-out

**`t.stackcanvas.dev` is the *only* vendor-side endpoint anywhere in
stackcanvas.** It receives only the allowlisted envelope documented above.
Every other feature of the product — reading your Terraform state, talking
to the Terraform/OpenTofu CLI, serving the canvas UI — runs entirely on
`127.0.0.1`. The product is **fully functional with telemetry denied, or
with this endpoint unreachable entirely**: `emit()` is fire-and-forget with
a 3-second timeout and every failure is silently swallowed, by design (see
"When events fire" above). No other stackcanvas code path ever calls out to
infrastructure we run.

## Known limitations (stated plainly, not buried)

- **"install" really means "first consented open."** Since consent only
  exists in the canvas UI, someone who installs the package but never opens
  a canvas — or opens one and never clicks "Allow" — is invisible to this
  telemetry. `install` undercounts raw installs; npm's own download stats
  are the better proxy for reach. This telemetry answers activation/retention
  questions, not "how many people installed this."
- **`anon_id` is pseudonymous, not anonymous**, under a strict reading of
  GDPR-style definitions — it's a stable per-machine identifier, even though
  it carries no directly identifying data and there is no user account to
  link it to.

## Deletion on request

Because the collector's only key is the random `anon_id` in your own
`~/.stackcanvas/config.json`, you can request deletion of any data
associated with it: open an issue at
[github.com/pshenok/stackcanvas](https://github.com/pshenok/stackcanvas)
with the `anon_id` value (never anything else from the config file) and
we'll delete the matching rows from Analytics Engine and the R2 mirror.

## How to verify this yourself

- Read the source: [`packages/server/src/telemetry.ts`](packages/server/src/telemetry.ts)
  (client + consent state machine) and
  [`packages/server/src/canvas-server.ts`](packages/server/src/canvas-server.ts)
  (the three `/api/telemetry*` routes and the emitter call sites).
- Run the test suite: `npx pnpm@9 test`. In particular,
  [`packages/server/src/telemetry.test.ts`](packages/server/src/telemetry.test.ts)
  has an **envelope allowlist tripwire** test (`test.each` over all five
  events) that parses the exact JSON body `emit()` would send and fails if a
  single key exists outside the schema on this page — a future field can't
  quietly ship without this file being updated in the same PR.
  [`packages/server/src/telemetry-routes.test.ts`](packages/server/src/telemetry-routes.test.ts)
  additionally proves, with a real `CanvasServer` and a spied `fetch`, that
  no event is ever sent before consent is granted, and that
  `DO_NOT_TRACK=1` silences a config file that already says `granted`.
- Watch it yourself: open dev tools' network tab (or a local proxy) while
  running `stackcanvas serve` with consent granted — the only external host
  it will ever contact is `t.stackcanvas.dev`.

## Schema changes

Telemetry never becomes opt-out, and never gains a field outside the
allowlist above without: a bump to `TELEMETRY_SCHEMA_VERSION` in
`telemetry.ts`, an update to this file in the same PR, and a documented
minor version release.
