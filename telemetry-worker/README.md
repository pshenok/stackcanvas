# stackcanvas telemetry collector

The receiving end of stackcanvas' opt-in, privacy-credible product
telemetry. Source-in-repo per the design in
[`docs/SPEC.md`](../docs/SPEC.md)'s "Telemetry, CI matrix, release &
registry engineering" chapter; the user-facing contract (what's sent, when,
how to opt out) lives in [`TELEMETRY.md`](../TELEMETRY.md) at the repo root.

This package is **deliberately not part of the pnpm workspace** and is never
published to npm — it's a standalone Cloudflare Worker with its own
`package.json`, installed and tested with plain `npm`, not `pnpm`.

Storage: **Workers Analytics Engine** for aggregate counters (~90-day
retention) + an **R2** NDJSON mirror as the long-term system of record — no
D1 database, per the chapter's explicit transport decision. See
[`schema.sql`](./schema.sql) for the row layout and the week-2 reopen query.

## Local development

```bash
npm install
npm run typecheck
npm test          # 29 vitest cases, no network, no Cloudflare tooling required
```

Tests fake the `EVENTS` (Analytics Engine) and `BUCKET` (R2) bindings with
plain spies — no `wrangler dev`, no miniflare, no workerd binary download.
See `vitest.config.ts` and `src/index.test.ts` for why that's sufficient.

## Founder deploy steps

Everything below runs from this directory (`telemetry-worker/`). **Two of
these steps are manual and cannot be scripted or done in CI**, flagged
explicitly:

1. **[MANUAL] Cloudflare authentication.**

   ```bash
   npx wrangler@4 login
   ```

   Opens a browser to authorize the CLI against your Cloudflare account.
   Confirm the right account with:

   ```bash
   npx wrangler@4 whoami
   ```

   Copy the Account ID it prints into `wrangler.toml`'s commented-out
   `account_id = "..."` line (uncomment it).

2. Create the R2 bucket (one-time; Analytics Engine needs no equivalent —
   its dataset is created implicitly by the first write):

   ```bash
   npx wrangler@4 r2 bucket create stackcanvas-telemetry-mirror
   ```

3. **[MANUAL] DNS for `t.stackcanvas.dev`.** `wrangler.toml`'s `[[routes]]`
   block tells *Cloudflare* which Worker answers for that host once the zone
   exists and points here — it does not create the DNS record itself. In the
   Cloudflare dashboard for the `stackcanvas.dev` zone: add a `t` record
   (CNAME or a proxied A/AAAA record, orange-clouded) so the hostname is
   served by Cloudflare, then attach the custom domain to this Worker (the
   dashboard does this automatically once `wrangler deploy` has run once and
   the route is picked up, or do it manually under Workers & Pages > your
   worker > Settings > Domains & Routes > Custom Domains).

4. Deploy:

   ```bash
   npm run deploy   # npx wrangler@4 deploy
   ```

   No CI secret sprawl on purpose — this is a founder-run command, not part
   of `ci.yml`/`release.yml` (see docs/SPEC.md: "Deployed manually by
   founder via `wrangler deploy`").

5. Verify:

   ```bash
   # Before DNS is live, or to sanity-check the deploy directly:
   curl -i https://stackcanvas-telemetry.<your-subdomain>.workers.dev/health
   # -> HTTP/1.1 200 OK  {"status":"ok"}

   # After DNS + custom domain are attached:
   curl -i https://t.stackcanvas.dev/health
   # -> HTTP/1.1 200 OK  {"status":"ok"}

   curl -i -X POST https://t.stackcanvas.dev/e \
     -H 'content-type: application/json' \
     -d '{"schema":1,"anon_id":"00000000-0000-4000-8000-000000000000","day":"2026-07-12","app_version":"0.1.0","platform":"darwin","node_major":22,"payload":{"event":"install"}}'
   # -> HTTP/1.1 204 No Content

   curl -i -X POST https://t.stackcanvas.dev/e -d 'not json'
   # -> HTTP/1.1 400 Bad Request
   ```

   Then confirm the row landed: query Analytics Engine's SQL API (see
   `schema.sql` §3a) or list the R2 bucket:

   ```bash
   npx wrangler@4 r2 object get stackcanvas-telemetry-mirror/events/2026-07-12/<uuid-from-listing>.ndjson
   ```

## Routes

| Route | Behavior |
|---|---|
| `POST /e` | Validate the envelope against the hard allowlist (schema version, envelope keys, event name, per-event payload keys, UUID-shaped `anon_id`, `YYYY-MM-DD` `day`, counters capped 0-50) and body size (`>4KB` → `413`). Valid → write to Analytics Engine + mirror to R2, respond `204`. Invalid → `400`, nothing stored. Storage failures (AE or R2) never surface as an error response — see "Error handling" in the chapter. |
| `GET /health` | Always `200 {"status":"ok"}` — liveness check, no bindings touched. |
| everything else | `404` — including `GET /e` (only `POST` is handled) and any CORS preflight `OPTIONS` request. There is no browser client for this endpoint (only stackcanvas' own server-side `TelemetryClient.emit()`), so no CORS headers are ever set and preflights simply hit the unmatched-route case. |

## What's never done here

- No cookies, no reading `cf-connecting-ip` — the worker never sees or
  stores the caller's IP.
- No CORS — closed by construction (see routing table above).
- No retries, no queue on the collector side — the client
  (`TelemetryClient.emit()` in `packages/server/src/telemetry.ts`) is
  already fire-and-forget with a 3s timeout, so a slow or down collector
  never blocks or breaks stackcanvas itself.
