<a href="https://lnbits.com" target="_blank" rel="noopener noreferrer">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://i.imgur.com/QE6SIrs.png">
    <img src="https://i.imgur.com/fyKPgVT.png" alt="LNbits" style="width:280px">
  </picture>
</a>

[![License: MIT](https://img.shields.io/badge/License-MIT-success?logo=open-source-initiative&logoColor=white)](./LICENSE)
[![Built for LNbits](https://img.shields.io/badge/Built%20for-LNbits-4D4DFF?logo=lightning&logoColor=white)](https://github.com/lnbits/lnbits)

# Spark L2 sidecar

This sidecar exposes a small HTTP API for LNbits to talk to the Spark L2 SDK.
https://www.spark.money/

## Install

```
git clone https://github.com/lnbits/spark_sidecar.git
cd spark_sidecar
npm install
```

## Run

```
chmod +x server.mjs

SPARK_MNEMONIC="bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom" \
SPARK_NETWORK=MAINNET \
SPARK_SIDECAR_PORT=8765 \
SPARK_PAY_WAIT_MS=20000 \
node server.mjs
```

**Spark Multiplicity Setting**

Optional multiplicity tuning for [Spark leaf optimization](https://docs.spark.money/api-reference/wallet/initialize#multiplicity-levels)

Default multiplicity is 3

```
SPARK_MULTIPLICITY=3
```

**Optional API Key**

```
SPARK_SIDECAR_API_KEY="mykey"
```

Set the same key in LNbits as `SPARK_L2_EXTERNAL_API_KEY`, and point
`SPARK_L2_EXTERNAL_ENDPOINT` at this sidecar.

If you prefer to provide the mnemonic after startup, omit `SPARK_MNEMONIC` and
POST it to the sidecar:

```bash
curl -X POST http://127.0.0.1:8765/v1/mnemonic \
  -H "Content-Type: application/json" \
  -d '{"mnemonic":"bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom"}'
```

## Nix (flake)

Build:

```
nix build
```

Run:

```
SPARK_MNEMONIC="bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom" \
SPARK_NETWORK=MAINNET \
SPARK_SIDECAR_PORT=8765 \
SPARK_PAY_WAIT_MS=20000 \
nix run
```

Notes:

- The flake includes `flake.nix` and `flake.lock`. Commit both.
- The `result` symlink from `nix build` should not be committed.

## Endpoints

- `POST /v1/mnemonic`
- `POST /v1/balance`
- `POST /v1/invoices`
- `POST /v1/payments`
- `GET /v1/invoices/stream` (SSE stream of paid Lightning receive requests)
- `GET /v1/invoices/{id}`
- `GET /v1/payments/{id}`

### Invoice Stream

The stream endpoint emits Server-Sent Events after the received Spark funds have
cleared. Both invoice status lookups and stream notifications check the invoice's
own incoming transfer and its leaves. A Lightning success status alone is not
enough: uncleared receipts return `WAITING_FOR_FUNDS`, which SparkL2 maps to pending.
The check requires a completed transfer and available leaves registered in the
SDK's local cache. Later spending, completed splits/aggregations, or a subsequent
ownership change on a single-receiver transfer also prove prior availability.
Each lookup reconstructs this evidence from Spark; there is no saved receipt
ledger. A provider outage returns pending/unavailable, never an invented success.
The availability check reads the pinned SDK's internal leaf registry; review
`incoming.mjs` when upgrading the SDK.

Transfer events trigger checks immediately. While a stream client is connected,
polling discovers new updates and retries uncleared receipts using bounded,
in-memory bookkeeping. The discovery cursor starts at process startup. It does
not replay all historic invoices after every restart. LNbits' invoice-ID checks
recover payments made while the sidecar was offline directly from Spark.

SSE delivery is best effort, not an acknowledgement protocol. Disconnects can
lose events, and reconnects can repeat them. Invoice-ID checks are the recovery
path; a GET returns status without emitting an additional SSE notification.

Example:

```bash
curl -N http://127.0.0.1:8765/v1/invoices/stream
```

Each event payload is a JSON object:

```json
{
  "checking_id": "<receive_request_id>",
  "payment_hash": "<hash>",
  "status": "LIGHTNING_PAYMENT_RECEIVED"
}
```

Optional tuning:

- `SPARK_STREAM_KEEPALIVE_MS` (default `15000`)
- `SPARK_STREAM_HEARTBEAT_MS` (default `30000`)
- `SPARK_TRANSFER_LOOKUP_CONCURRENCY` (default `20`)
- `SPARK_TRANSFER_QUEUE_MAX` (default `5000`)
- `SPARK_INVOICE_POLL_MS` (default `2000`)
- `SPARK_INVOICE_POLL_LIMIT` (default `100`)

### Payment concurrency and waiting for funds

`SPARK_OPERATION_CONCURRENCY` (default `8`, positive integer) limits concurrent
outgoing operation workflows. Incoming receipt checks have a separate pool of
the same size. Different operation IDs run concurrently; duplicate requests for
one ID serialize and cannot dispatch it twice. Concurrent balance refreshes share
one SDK call. Long outgoing history scans continue across polls, at most two pages
per lookup. Incoming discovery reads at most four pages per polling pass. Slow
stream clients are disconnected when their write buffers fill.

Outgoing payments check spendable funds including quoted fees before dispatch.
`SPARK_FUNDS_WAIT_MS` (default `20000`) bounds waiting within the original POST.
If funds remain unavailable, the request fails before dispatch. Nothing is queued
for later sending: status GETs only query Spark and never initiate a payment.
This does not limit how long incoming invoices wait to be marked available.

If a send is rejected with `FEE_LIMIT_EXCEEDED`, the Spark quote exceeds the
`max_fee_sats` supplied by LNbits. The rejection message shows both amounts.
In LNbits Admin Settings → Funding, adjust the minimum fee reserve (millisats)
to cover the quote: `5000` millisats permits a 5-sat fee. LNbits defaults to a
2000-millisat minimum, whereas Spark's
[Lightning withdrawal guidance](https://docs.spark.money/wallets/withdraw-to-lightning#fee-recommendations)
recommends a minimum 5-sat budget. Larger payments or routes may require more.
The sidecar never raises the supplied limit itself. Older SparkL2 connectors
ignore `error_message` on failed responses; the sidecar log still shows the reason.

`SPARK_PAY_WAIT_MS` (default `4000`) controls how long a payment POST polls before
returning its current status; SparkL2 can continue polling pending payments.
`SPARK_PAY_POLL_MS` defaults to `500`. Keep the POST wait below LNbits' request
timeout, allowing time for SDK calls.

Mock burst tests cover hundreds of concurrent requests, bounded overlap and
provider idempotency keys. They do not establish live Spark capacity: signing,
operator latency, leaf distribution, and wallet liquidity still affect throughput.
Use one active sidecar per Spark wallet; removing the journal does not establish
support for multiple independently running SDK wallets spending the same leaves.

## Powered by LNbits

[LNbits](https://lnbits.com) is a free and open-source lightning accounts system.

[![Visit LNbits Shop](https://img.shields.io/badge/Visit-LNbits%20Shop-7C3AED?logo=shopping-cart&logoColor=white&labelColor=5B21B6)](https://shop.lnbits.com/)
[![Try myLNbits SaaS](https://img.shields.io/badge/Try-myLNbits%20SaaS-2563EB?logo=lightning&logoColor=white&labelColor=1E40AF)](https://my.lnbits.com/login)

## Payment recovery without local storage

The sidecar does not write a payment journal, lock files, or a polling watermark.
It needs no database, `flock` executable, persistent `/data` mount, or writable
working directory. Old `SPARK_PAYMENT_STATE_DIR`, `SPARK_ONCHAIN_STATE_DIR`,
`SPARK_SIDECAR_STATE_PATH`, and `SPARK_STATE_PERSIST_DEBOUNCE_MS` settings are
ignored. Existing files are left untouched. Temporary queues and stream IDs exist
only in RAM; they are not authoritative payment records.

New outgoing responses use Spark's request ID as `checking_id`. The existing
LNbits SparkL2 connector saves and returns this ID without modification, allowing
a replacement sidecar to call `getLightningSendRequest(id)` directly. Incoming
checks similarly use Spark's invoice request IDs.

For older outgoing checking IDs and lost submission responses, the sidecar
searches Spark's `getUserRequests` history by payment hash. Work is bounded to two
pages per check, continuing across subsequent checks. A hash may refer to several
attempts, so an ambiguous history or an old failed attempt remains pending;
it cannot safely prove that a newer attempt failed. New Spark request IDs avoid
that ambiguity. Missing records and provider outages also stay pending.

Every Lightning submission supplies a stable, network/payment-hash-derived
`idempotencyKey` to the pinned SDK. Spark stores deduplication state, scoped to the
wallet identity. The same invoice keeps the same key across process replacement,
case changes, and fee-limit changes. There are no automatic resubmissions after
an uncertain SDK response. A terminally failed Spark attempt should be retried
with a fresh invoice rather than expecting the same key to create a new attempt.
See [Spark's payment API](https://docs.spark.money/api-reference/wallet/pay-lightning-invoice)
and its [idempotency interceptor](https://github.com/buildonspark/spark/blob/main/spark/so/grpc/idempotency_interceptor.go).

Restart with the same wallet mnemonic, network, and account number. Mnemonic
handling and key derivation are unchanged; the sidecar does not save the mnemonic.
If LNbits supplies it over the API, a funding-source status/balance check must
perform that handshake again after the sidecar restarts. A payment-ID check alone
does not resend the mnemonic.

### Upgrading from v0.1.4

Finish outstanding payments on the old version before replacing it. In particular,
`PREPARING` / `WAITING_FOR_FUNDS` journal entries may represent instructions not yet
submitted to Spark. The new sidecar will not load or resume those instructions.
Payments with a lost request ID or multiple attempts under one hash can also need
reconciliation before upgrading. Keep old files for investigation; this version
neither deletes them nor treats them as payment authority. Do not run old and new
sidecars concurrently against the same wallet during the upgrade.

### Verification

Run `make check` for formatting, static checks, payment tests and localhost HTTP/SSE
tests. CI runs the Node tests on Linux, Windows and macOS. Replacement tests use
fresh working directories, recover status from a mock Spark service, and assert
that no sidecar files were created. Native Windows EXE packaging and live Spark
payments still require their own deployment tests.
