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
The sidecar persists that proof so spending the leaves later cannot reverse an
invoice's paid status.

Transfer events trigger checks immediately. While a stream client is connected,
polling discovers missed events and retries uncleared receipts. Pending receipts
survive restart; the discovery watermark advances only after they are recorded.
Startup loads a separate durable pending index, without scanning settled receipts.
The availability check reads the pinned SDK's internal leaf registry; review
`incoming.mjs` when upgrading the SDK.

The stream has no LNbits acknowledgement protocol: `notified` records that Node
accepted an event for writing, not that LNbits committed settlement. A crash in
between can lose a notification; invoice status lookups still return its durable
paid status. Blind replay is not enabled because the current LNbits consumer
forwards repeated notifications to extension listeners even for settled invoices.
Reliable replay requires consumer deduplication and an acknowledgement after
settlement is committed.

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

Outgoing payments also check spendable funds including quoted fees before
dispatch. `SPARK_FUNDS_WAIT_MS` (default `20000`) allows time for missing funds to
appear. Tracked incoming or temporarily locked funds keep the payment pending
while they clear. Status polls resume the original recorded intent; this waiting
does not occupy a worker between polls. This grace period does not limit how long
incoming invoices wait for availability.

`SPARK_PAY_WAIT_MS` (default `4000`) controls how long a payment POST polls before
returning its current status; SparkL2 can continue polling pending payments.
`SPARK_PAY_POLL_MS` defaults to `500`. Keep the POST wait below LNbits' request
timeout, allowing time for SDK calls.

Mock burst tests cover hundreds of concurrent requests, bounded overlap and
duplicate suppression. They do not establish live Spark capacity: signing and
operator latency, leaf distribution, wallet liquidity, and journal storage latency
still affect throughput. Use one sidecar writer per wallet and persistent journal
storage; adding sidecar replicas against the same wallet is not supported.

## Powered by LNbits

[LNbits](https://lnbits.com) is a free and open-source lightning accounts system.

[![Visit LNbits Shop](https://img.shields.io/badge/Visit-LNbits%20Shop-7C3AED?logo=shopping-cart&logoColor=white&labelColor=5B21B6)](https://shop.lnbits.com/)
[![Try myLNbits SaaS](https://img.shields.io/badge/Try-myLNbits%20SaaS-2563EB?logo=lightning&logoColor=white&labelColor=1E40AF)](https://my.lnbits.com/login)

## Payment journal

Set `SPARK_PAYMENT_STATE_DIR` to persistent private storage; it defaults to the
`payments` directory beside `SPARK_SIDECAR_STATE_PATH`. For compatibility with the
earlier combined build, `SPARK_ONCHAIN_STATE_DIR` and an existing adjacent `onchain`
directory are still recognized as journal locations. Use the existing journal
when upgrading so pending payment intents are retained.

Lightning send intents and request IDs are persisted before responding. An
ambiguous result is retained and never automatically resent.

Run one writer. Back up its journal with the LNbits databases. Do not delete
operation files to retry payments. On Linux, a kernel `flock` is held for the
writer's lifetime and released automatically on crashes, including `SIGKILL`.
Linux requires the `flock` command from util-linux; Docker and Nix include it.
The permanent `writer.flock` inode must never be removed. `writer.lock` is a hard
link to it, preventing older sidecars from starting against the active journal;
a leftover link from this implementation is recovered automatically. Use local
storage supporting file locks and hard links.

An old PID-only `writer.lock` is deliberately not reclaimed automatically: its
PID cannot establish ownership across containers. For that one-time upgrade
case, verify the previous writer has stopped before removing the old marker.
Non-Linux platforms retain the earlier exclusive-file lock and manual recovery.
Ensure your process supervisor forwards shutdown signals to the sidecar;
a wrapper that backgrounds Node and then replaces itself with LNbits does not do
this. Lightning requests with missing external IDs are looked up in Spark history
by payment hash; only an unambiguous successful settlement can resolve them.
An older failed attempt cannot prove a newer attempt failed. Other missing-ID
results remain pending and are never resent.
Known failures before dispatch return `LIGHTNING_PAYMENT_FAILED`, which SparkL2
recognizes as a failed payment. Keep the journal directory on persistent storage. A payment proven not to have been sent can be retried by POST;
successful or uncertain sends are never dispatched again.

The SDK is pinned to `0.9.0`; review the receive availability check in
`incoming.mjs` before upgrading.

Run `make check` for formatting, static checks, payment/journal tests and localhost
HTTP/SSE integration tests. CI also runs both Node test targets explicitly.
`make test-payments` covers crash recovery, availability, durability, concurrency
and duplicate sends; `make test-server` uses a mocked SDK (no Spark network access
or funds).
Test with the exact deployed Spark SDK and network before using real funds.
The invoice decoder is declared directly and is already a dependency of the Spark SDK.
