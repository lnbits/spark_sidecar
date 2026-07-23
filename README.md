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
SPARK_ACCOUNT_NUMBER=1 \
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

The account number defaults to `1` (`0` on `REGTEST`). Set
`SPARK_ACCOUNT_NUMBER` explicitly when restoring an existing wallet.

**Optional API Key**

```
SPARK_SIDECAR_API_KEY="mykey"
```

An API key is required when `SPARK_SIDECAR_HOST` is not a loopback host.

Set the same key in LNbits as `SPARK_L2_API_KEY`.

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
- `GET /metrics` (Prometheus text format)
- `GET /v1/invoices/stream` (SSE stream of paid Lightning receive requests)
- `GET /v1/invoices/{id}`
- `GET /v1/payments/{id}`

### Invoice Stream

The stream endpoint emits Server-Sent Events when a Lightning invoice is paid.

Example:

```bash
curl -N http://127.0.0.1:8765/v1/invoices/stream
```

Each event payload is a JSON object:

```json
{
  "checking_id": "<receive_request_id>",
  "payment_hash": "<hash>",
  "status": "TRANSFER_COMPLETED"
}
```

Optional tuning:

- `SPARK_STREAM_KEEPALIVE_MS` (default `15000`)
- `SPARK_STREAM_HEARTBEAT_MS` (default `30000`)
- `SPARK_TRANSFER_LOOKUP_CONCURRENCY` (default `20`)
- `SPARK_TRANSFER_QUEUE_MAX` (default `5000`)
- `SPARK_INVOICE_POLL_MS` (default `2000`)
- `SPARK_INVOICE_POLL_LIMIT` (default `100`)
- `SPARK_INVOICE_CACHE_TTL_MS` (default `3600000`)
- `SPARK_BALANCE_RECOVERY_POLL_MS` (default `2000`)
- `SPARK_BALANCE_RECOVERY_STABLE_READS` (default `3`)
- `SPARK_BALANCE_RECOVERY_TIMEOUT_MS` (default `45000`)
- `SPARK_BALANCE_QUERY_TIMEOUT_MS` (default `10000`)

### Throughput and rate limiting

The sidecar bounds concurrent payment submission and routes balance, status,
history, and transfer lookups through one rate-limited query queue. Lower
`SPARK_QUERY_MAX_RPS` if the Spark service applies a tighter limit. Setting a
short payment poll interval cannot bypass this global limit. A detected HTTP
429 or rate-limit error pauses all new queries with exponential backoff.

- `SPARK_PAYMENT_CONCURRENCY` (default `8`)
- `SPARK_PAYMENT_QUEUE_MAX` (default `64`)
- `SPARK_PAY_WAIT_MAX_MS` (default `30000`)
- `SPARK_PAY_POLL_MAX_ACTIVE` (default `64`)
- `SPARK_QUERY_MAX_RPS` (default `10`)
- `SPARK_QUERY_CONCURRENCY` (default `4`)
- `SPARK_QUERY_QUEUE_MAX` (default `200`)
- `SPARK_QUERY_RATE_LIMIT_BACKOFF_MS` (default `5000`)
- `SPARK_QUERY_RATE_LIMIT_BACKOFF_MAX_MS` (default `60000`)
- `SPARK_REQUEST_LOG` (default `false`)

When the payment queue is full, the sidecar returns a structured rejection
that explicitly states the payment was not submitted. LNbits treats every
other submission error as ambiguous and keeps the payment pending.

Payment request mappings are appended in batches rather than rewriting the
complete state after every payment. The journal is periodically compacted into
a bounded snapshot.

- `SPARK_SIDECAR_STATE_PATH` (default `./spark-sidecar-state.json`)
- `SPARK_PAYMENT_MAPPING_SNAPSHOT_PATH` (default
  `<state-path>.payments.json`)
- `SPARK_PAYMENT_MAPPING_JOURNAL_PATH` (default
  `<state-path>.payments.log`)
- `SPARK_STATE_PERSIST_DEBOUNCE_MS` (default `1000`)
- `SPARK_PAYMENT_JOURNAL_COMPACT_ENTRIES` (default `5000`)
- `SPARK_PAYMENT_JOURNAL_COMPACT_BYTES` (default `4194304`)
- `SPARK_PAYMENT_MAPPING_MAX` (default `100000`)

The authenticated `/metrics` endpoint exposes payment/query queue depth,
submission latency, active settlement polls, Spark errors, dropped transfer
events, and state-write latency.

## Powered by LNbits

[LNbits](https://lnbits.com) is a free and open-source lightning accounts system.

[![Visit LNbits Shop](https://img.shields.io/badge/Visit-LNbits%20Shop-7C3AED?logo=shopping-cart&logoColor=white&labelColor=5B21B6)](https://shop.lnbits.com/)
[![Try myLNbits SaaS](https://img.shields.io/badge/Try-myLNbits%20SaaS-2563EB?logo=lightning&logoColor=white&labelColor=1E40AF)](https://my.lnbits.com/login)
