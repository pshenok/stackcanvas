-- stackcanvas telemetry collector — storage layout + week-2 reopen query.
--
-- NOTE ON STORAGE ENGINE: docs/SPEC.md's Telemetry chapter ("Transport
-- decision — PostHog free tier vs Cloudflare Worker") specifies Workers
-- Analytics Engine + an R2 NDJSON mirror, not D1 — so there is no D1
-- database or CREATE TABLE for this collector. Analytics Engine has no
-- migration step either: the dataset named in wrangler.toml's
-- [[analytics_engine_datasets]] binding is created implicitly by the first
-- `env.EVENTS.writeDataPoint()` call. This file instead documents (a) the
-- fixed-width blob/double column layout src/index.ts's writeAnalytics()
-- writes into that dataset, and (b) the week-2 reopen query in both forms
-- the chapter anticipates: live against Analytics Engine's SQL API, and as
-- a fallback against the R2 NDJSON mirror once AE's ~90-day retention rolls
-- off past the gate window (see docs/SPEC.md, Risks: "Analytics Engine
-- ~90-day retention").
--
-- ============================================================================
-- 1. Analytics Engine row layout (one row per accepted event)
-- ============================================================================
--
-- blob1  = payload.event            ('install' | 'canvas_opened' | 'intent_sent' | 'scan_run' | 'drift_opened')
-- blob2  = anon_id                  (UUIDv4)
-- blob3  = day                      ('YYYY-MM-DD', UTC)
-- blob4  = app_version
-- blob5  = platform                 ('darwin' | 'linux' | 'win32' | 'other')
-- blob6  = payload.nodes_bucket     ('' if the event has no nodes_bucket)
-- blob7  = payload.tf_bin           ('' unless event = 'canvas_opened')
-- blob8  = payload.provider         ('' unless event = 'scan_run')
-- double1 = node_major
-- double2 = payload.add             (0 unless event = 'intent_sent')
-- double3 = payload.modify          (0 unless event = 'intent_sent')
-- double4 = payload.remove          (0 unless event = 'intent_sent')
-- double5 = payload.adopt           (0 unless event = 'intent_sent')
-- double6 = payload.investigate     (0 unless event = 'intent_sent')
-- index1  = payload.event           (sampling index, per AE's one-index limit)
--
-- ============================================================================
-- 2. R2 mirror layout
-- ============================================================================
--
-- One object per accepted event: `events/<day>/<random-uuid>.ndjson`, body =
-- the exact raw envelope JSON + a trailing newline. Concatenating everything
-- under `events/<day>/` yields a valid NDJSON file for that day.
--
-- ============================================================================
-- 3. Week-2 reopen rate — the gate metric
--    "distinct installs with canvas_opened on >=1 day in days 8-14 after
--    install / installs" (docs/SPEC.md, this chapter's Design section, and
--    the client-side note in packages/server/src/telemetry.ts: "Week-2
--    reopen is not a client event — it is derived server-side as distinct
--    anon_ids with a canvas_opened between install.day + 7 and
--    install.day + 14").
-- ============================================================================

-- 3a. Live query, Analytics Engine SQL API
--     (https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
--     Table name = the `dataset` value from wrangler.toml, not the binding
--     name: `stackcanvas_telemetry`. Run via:
--       curl -s "https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql" \
--         -H "Authorization: Bearer <api_token>" --data-binary @this-query.sql
WITH installs AS (
  SELECT blob2 AS anon_id, toDate(blob3) AS install_day
  FROM stackcanvas_telemetry
  WHERE blob1 = 'install'
),
reopens AS (
  SELECT DISTINCT i.anon_id
  FROM stackcanvas_telemetry co
  INNER JOIN installs i ON co.blob2 = i.anon_id
  WHERE co.blob1 = 'canvas_opened'
    AND toDate(co.blob3) BETWEEN i.install_day + 8 AND i.install_day + 14
)
SELECT
  (SELECT count() FROM reopens)                                        AS week2_reopens,
  (SELECT count(DISTINCT anon_id) FROM installs)                       AS total_installs,
  (SELECT count() FROM reopens) * 1.0
    / NULLIF((SELECT count(DISTINCT anon_id) FROM installs), 0)        AS week2_reopen_rate;

-- 3b. Fallback query, DuckDB over the R2 NDJSON mirror
--     (for when the gate window has moved past Analytics Engine's ~90-day
--     retention, or for an offline/local audit). Sync the mirror down first,
--     e.g. `rclone sync r2:stackcanvas-telemetry-mirror ./mirror` with an R2
--     rclone remote, then run this with `duckdb`:
WITH events AS (
  SELECT * FROM read_ndjson_auto('mirror/events/*/*.ndjson')
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
