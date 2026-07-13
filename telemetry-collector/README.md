# stackcanvas telemetry collector

The receiving end of stackcanvas' opt-in, privacy-credible product
telemetry. Source-in-repo, same as its predecessor; the user-facing
contract (what's sent, when, how to opt out) lives in
[`TELEMETRY.md`](../TELEMETRY.md) at the repo root.

**This replaced the retired `telemetry-worker` Cloudflare Worker** — issue
#35 ported the collector to AWS Lambda. The endpoint URL is unchanged:
**`https://t.stackcanvas.dev/e`**. Nothing in `packages/server/src/telemetry.ts`
(the client) or `TELEMETRY.md`'s validation contract changed; only where the
collector runs and how events are stored changed. See `src/handler.ts`'s
header comment for the one deliberate behavior change (storage failures now
surface as `500` instead of being swallowed into a `204`) and why it's safe.

This package is **deliberately not part of the pnpm workspace** and is never
published to npm — it's a standalone AWS Lambda with its own
`package.json`, installed and tested with plain `npm`, not `pnpm`.

Storage: **Kinesis Data Firehose -> S3**, one gzip NDJSON batch object per
delivery — see [`schema.md`](./schema.md) for the record shape, the S3
layout, and the week-2 reopen query.

## Local development

```bash
npm install
npm run typecheck
npm test          # vitest, no network, no AWS credentials required
```

Tests fake the Firehose client (`FirehoseLike`, see `src/handler.ts`) with a
plain `vi.fn()` spy — no `sam local invoke`, no LocalStack, no real
`@aws-sdk/client-firehose` call ever happens in the test suite. Validation
logic itself (`src/validate.ts`) has zero AWS imports and is tested
independently in `src/validate.test.ts`.

## Founder deploy steps

Everything below is **CLI-provisioned** (no Terraform/CDK stack for this
piece — five moving parts, provisioned once, matching the original worker's
"no CI secret sprawl, founder-run command" philosophy). Two steps are
manual and cannot be scripted, flagged explicitly. Replace
`<account-id>` / `<region>` / `<hosted-zone-id>` with your own throughout.

1. **S3 bucket** (long-term system of record):

   ```bash
   aws s3api create-bucket --bucket stackcanvas-telemetry \
     --region <region> --create-bucket-configuration LocationConstraint=<region>
   ```

2. **IAM role for Firehose** (trust: `firehose.amazonaws.com`; permission:
   `s3:PutObject`/`s3:PutObjectAcl`/`s3:GetBucketLocation`/`s3:ListBucket`
   scoped to `arn:aws:s3:::stackcanvas-telemetry*`) — create via the console
   or `aws iam create-role` + `aws iam put-role-policy` with your usual IAM
   bootstrap process; the exact policy JSON is the standard
   [Firehose S3 destination policy](https://docs.aws.amazon.com/firehose/latest/dev/controlling-access.html#using-iam-s3).

3. **Firehose delivery stream**, targeting the bucket from step 1:

   ```bash
   aws firehose create-delivery-stream \
     --delivery-stream-name stackcanvas-telemetry-stream \
     --delivery-stream-type DirectPut \
     --extended-s3-destination-configuration \
       'RoleARN=arn:aws:iam::<account-id>:role/firehose-stackcanvas-telemetry,BucketARN=arn:aws:s3:::stackcanvas-telemetry,Prefix=events/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/,CompressionFormat=GZIP,BufferingHints={SizeInMBs=5,IntervalInSeconds=300}'
   ```

   **Not provisioned**: dynamic partitioning by the record's own `day`
   field (see `schema.md` §3's caveat on delivery-time vs event-time
   partitioning) — the default timestamp-based prefix above is good enough
   at this volume and avoids the extra per-record JQ processing cost.

4. **IAM role for the Lambda** (trust: `lambda.amazonaws.com`; permissions:
   `firehose:PutRecord` scoped to the stream's ARN, plus the AWS-managed
   `AWSLambdaBasicExecutionRole` for CloudWatch Logs):

   ```bash
   aws iam create-role --role-name stackcanvas-telemetry-lambda \
     --assume-role-policy-document file://trust-lambda.json
   aws iam attach-role-policy --role-name stackcanvas-telemetry-lambda \
     --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
   aws iam put-role-policy --role-name stackcanvas-telemetry-lambda \
     --policy-name put-firehose-record --policy-document file://firehose-put-policy.json
   ```

5. **Build and create the Lambda function**:

   ```bash
   npm run build   # -> dist/lambda.zip (see build.mjs)

   aws lambda create-function \
     --function-name stackcanvas-telemetry \
     --runtime nodejs22.x \
     --handler handler.handler \
     --role arn:aws:iam::<account-id>:role/stackcanvas-telemetry-lambda \
     --zip-file fileb://dist/lambda.zip \
     --environment 'Variables={FIREHOSE_STREAM=stackcanvas-telemetry-stream}' \
     --timeout 5 --memory-size 128
   ```

6. **API Gateway HTTP API** (payload format version 2, the shape
   `src/handler.ts` expects), Lambda proxy integration, both routes, and an
   auto-deploying `$default` stage:

   ```bash
   API_ID=$(aws apigatewayv2 create-api \
     --name stackcanvas-telemetry --protocol-type HTTP \
     --target arn:aws:lambda:<region>:<account-id>:function:stackcanvas-telemetry \
     --query ApiId --output text)

   # `--target` above already wires a $default route + $default stage to the
   # Lambda for a quick start; the explicit routes below make POST /e and
   # GET /health the only two that exist, matching the worker's routing
   # table (everything else falls through to the implicit $default route
   # only if one still exists — delete it if `create-api --target` created
   # one, so unmatched routes 404 from API Gateway itself rather than ever
   # reaching the Lambda):
   aws apigatewayv2 create-route --api-id $API_ID \
     --route-key 'POST /e' --target integrations/$(aws apigatewayv2 get-integrations --api-id $API_ID --query 'Items[0].IntegrationId' --output text)
   aws apigatewayv2 create-route --api-id $API_ID \
     --route-key 'GET /health' --target integrations/$(aws apigatewayv2 get-integrations --api-id $API_ID --query 'Items[0].IntegrationId' --output text)

   aws lambda add-permission \
     --function-name stackcanvas-telemetry --statement-id apigw-invoke \
     --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
     --source-arn "arn:aws:execute-api:<region>:<account-id>:${API_ID}/*/*"
   ```

7. **[MANUAL] ACM certificate for `t.stackcanvas.dev`.** Request a
   DNS-validated public certificate in the **same region as the API**
   (regional custom domains, not edge-optimized):

   ```bash
   aws acm request-certificate --domain-name t.stackcanvas.dev \
     --validation-method DNS --region <region>
   ```

   Add the printed CNAME validation record to the `stackcanvas.dev` zone
   (Route53 or wherever it's hosted) and wait for `aws acm
   describe-certificate` to show `Status: ISSUED` — this step cannot be
   scripted end-to-end because DNS validation requires the zone owner to
   publish a record and DNS propagation isn't instantaneous.

8. **API Gateway custom domain + mapping**, once the cert is issued:

   ```bash
   aws apigatewayv2 create-domain-name --domain-name t.stackcanvas.dev \
     --domain-name-configurations CertificateArn=arn:aws:acm:<region>:<account-id>:certificate/<cert-id>

   aws apigatewayv2 create-api-mapping --domain-name t.stackcanvas.dev \
     --api-id $API_ID --stage '$default'
   ```

   Note the `ApiGatewayDomainName` (a `*.execute-api.<region>.amazonaws.com`
   -style regional target) the first command prints — that's what DNS needs
   to point at, next.

9. **[MANUAL] DNS for `t.stackcanvas.dev`.** In the zone (Route53 or
   wherever `stackcanvas.dev` lives), point `t` at the regional domain name
   from step 8:

   ```bash
   # If the zone is in Route53, an ALIAS A record is preferred (no extra
   # DNS lookup, works at the zone apex too — not relevant here but the
   # right habit):
   aws route53 change-resource-record-sets --hosted-zone-id <hosted-zone-id> \
     --change-batch file://alias-record.json
   ```

   where `alias-record.json` is an `UPSERT` of an `A` record with an
   `AliasTarget` pointing at the API Gateway regional domain name's target
   domain + hosted zone ID (`aws apigatewayv2 get-domain-name` prints both
   under `DomainNameConfigurations[0].{ApiGatewayDomainName,HostedZoneId}`).
   If the zone isn't in Route53, a `CNAME t -> <ApiGatewayDomainName>` at
   whatever DNS provider owns the zone works the same way. This is manual
   for the same reason the old worker's DNS step was: it requires access to
   the zone, which isn't something this repo's CI should ever hold
   credentials for.

## Update path (code changes only — infra above is one-time)

```bash
npm run build && aws lambda update-function-code \
  --function-name stackcanvas-telemetry --zip-file fileb://dist/lambda.zip
```

`npm run build` (see `build.mjs`) bundles `src/handler.ts` — and everything
it imports, including `@aws-sdk/client-firehose` — into a single
`dist/handler.mjs` with esbuild (target `node22`, ESM), then zips it to
`dist/lambda.zip` with `handler.mjs` at the zip root so the Lambda's
`handler.handler` setting keeps resolving.

## Verify

```bash
curl -i https://t.stackcanvas.dev/health
# -> HTTP/1.1 200 OK  {"status":"ok"}

curl -i -X POST https://t.stackcanvas.dev/e \
  -H 'content-type: application/json' \
  -d '{"schema":1,"anon_id":"00000000-0000-4000-8000-000000000000","day":"2026-07-12","app_version":"0.1.0","platform":"darwin","node_major":22,"payload":{"event":"install"}}'
# -> HTTP/1.1 200 OK  {"ok":true}

curl -i -X POST https://t.stackcanvas.dev/e -d 'not json'
# -> HTTP/1.1 400 Bad Request
```

Then confirm the record landed once Firehose's buffer window flushes (see
`schema.md` for the object layout and the week-2 reopen query):

```bash
aws s3 ls s3://stackcanvas-telemetry/events/2026/07/12/
```

## Routes

| Route | Behavior |
|---|---|
| `POST /e` | Validate the envelope against the hard allowlist (`src/validate.ts`: schema version, envelope keys, event name, per-event payload keys, UUID-shaped `anon_id`, `YYYY-MM-DD` `day`, counters capped 0-50) and body size (`>4KB` → `413`). Valid → one `firehose:PutRecord`, respond `200 {ok:true}`. Invalid → `400`/`413`, nothing stored. A Firehose failure → `500` (see `src/handler.ts`'s header comment for why this is safe to surface, unlike the old worker's always-succeed design). |
| `GET /health` | Always `200 {"status":"ok"}` — liveness check, touches no AWS service. |
| everything else | `404` — including `GET /e` (only `POST` is handled) and any CORS preflight `OPTIONS` request. There is no browser client for this endpoint (only stackcanvas' own server-side `TelemetryClient.emit()`), so no CORS headers are ever set and preflights simply hit the unmatched-route case. |

## What's never done here

- No cookies, no reading the caller's source IP into anything stored — the
  handler never puts `event.requestContext.http.sourceIp` into the record.
- No CORS — closed by construction (see routing table above).
- No retries, no queue on the collector side beyond what Firehose itself
  buffers before flushing to S3 — the client
  (`TelemetryClient.emit()` in `packages/server/src/telemetry.ts`) is
  already fire-and-forget with a 3s timeout, so a slow or down collector
  never blocks or breaks stackcanvas itself.
