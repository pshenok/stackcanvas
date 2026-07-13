# stackcanvas telemetry collector — storage layout + week-2 reopen query

Ported from `telemetry-worker/schema.sql` (Cloudflare Worker: Workers
Analytics Engine + R2) to the AWS Lambda collector's storage: **Kinesis
Data Firehose -> S3**, no separate aggregate-query engine — one NDJSON
system of record, queried with DuckDB.

## 1. Why Firehose -> S3, not a DB

Same rationale as the worker's original "PostHog vs Cloudflare Worker"
transport decision (`docs/SPEC.md`, Telemetry chapter): no third-party
processor, no always-on database to operate for five low-cardinality
counters. `src/handler.ts` validates each envelope, then does one
`firehose:PutRecord` per event; Firehose buffers and batches delivery to S3
on its own schedule (size/time-based, configured on the delivery stream —
see README.md's provisioning steps). There is no D1/Analytics-Engine
equivalent in this port: S3 + DuckDB is the entire system of record.

## 2. Record shape (one JSON object per line, NDJSON)

Each line `handler.ts`'s `toNdjsonLine()` sends to Firehose is the
validated envelope (see `src/validate.ts`'s `ValidatedEvent`) plus one
field the collector stamps on receipt:

```jsonc
{
  "schema": 1,
  "anon_id": "1c9f6a8e-…",          // UUIDv4
  "day": "2026-07-12",               // 'YYYY-MM-DD', UTC, client-supplied
  "app_version": "0.1.0",
  "platform": "darwin",              // 'darwin' | 'linux' | 'win32' | 'other'
  "node_major": 22,
  "payload": { "event": "install" }, // one of the five TelemetryProps shapes
  "received_at": "2026-07-12T18:03:41.552Z"  // server-stamped, ISO 8601, collector-added
}
```

`received_at` is the one field this collector adds that the old worker's R2
mirror didn't have (the worker relied on the R2 object key's `events/<day>/`
prefix plus Analytics Engine for freshness; Firehose-delivered S3 objects
have no per-record key, so a receipt timestamp is the only way to recover
"when did the collector actually see this" from the file alone).

## 3. S3 layout

```
s3://stackcanvas-telemetry/events/YYYY/MM/DD/*.gz
```

Each object is a gzip-compressed batch of concatenated NDJSON lines (one or
more records — however Firehose happened to batch them), written under the
delivery stream's configured S3 prefix. **Note the partitioning caveat**:
Firehose's built-in S3 prefix (`events/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/`)
partitions by the *delivery* timestamp (when Firehose flushed the buffer to
S3), not by the event's own `day` field — unlike the old R2 mirror, which
was keyed by `envelope.day` directly on `put()`. In practice these agree to
within Firehose's buffer window (60s–900s, whatever the delivery stream is
configured with), but a query that needs exact `day`-based partitioning
should filter on the `day` field inside the record, not rely on the S3 key.
(Dynamic partitioning by the record's own `day` field is possible with
Firehose's JQ-based dynamic partitioning feature but isn't provisioned here
— see README.md's "Not provisioned" note — since it adds cost/complexity
this collector's volume doesn't justify yet.)

## 4. Week-2 reopen rate — the gate metric

"Distinct installs with `canvas_opened` on >=1 day in days 8-14 after
install / installs" — same definition as the original worker's schema.sql
§3, ported to DuckDB reading over the S3 mirror (no Analytics Engine SQL
API equivalent exists on this stack, so there's only one query form here,
not two).

```bash
# Sync the mirror down first (read-only, no need for full bucket access —
# scope the IAM policy to this prefix):
aws s3 sync s3://stackcanvas-telemetry/events ./mirror/events

# Then run with `duckdb` (DuckDB's read_ndjson_auto transparently
# decompresses .gz by extension):
duckdb -c "$(cat <<'SQL'
WITH events AS (
  SELECT * FROM read_ndjson_auto('mirror/events/**/*.gz')
),
installs AS (
  SELECT anon_id, day::DATE AS install_day
  FROM events
  WHERE payload.event = 'install'
),
reopens AS (
  SELECT DISTINCT e.anon_id
  FROM events e
  INNER JOIN installs i USING (anon_id)
  WHERE e.payload.event = 'canvas_opened'
    AND e.day::DATE BETWEEN i.install_day + 8 AND i.install_day + 14
)
SELECT
  (SELECT count(*) FROM reopens)                                       AS week2_reopens,
  (SELECT count(DISTINCT anon_id) FROM installs)                       AS total_installs,
  (SELECT count(*) FROM reopens)::DOUBLE
    / NULLIF((SELECT count(DISTINCT anon_id) FROM installs), 0)        AS week2_reopen_rate;
SQL
)"
```

Or, without syncing down first, DuckDB's `httpfs` extension can query S3
directly (`INSTALL httpfs; LOAD httpfs;` then read `s3://stackcanvas-telemetry/events/**/*.gz`
with credentials in the environment) — useful for an ad hoc check, but
`aws s3 sync` + local DuckDB is the reproducible form and what the gate
review should use.
