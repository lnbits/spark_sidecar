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
cd lnbits/wallets/sidecars/spark
npm install
```

## Run

```
SPARK_MNEMONIC="bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom bottom" \
SPARK_NETWORK=MAINNET \
SPARK_SIDECAR_PORT=8765 \
SPARK_PAY_WAIT_MS=20000 \
node server.mjs
```

Optional auth:

```
SPARK_SIDECAR_API_KEY="mykey"
```

Set the same key in LNbits as `SPARK_L2_API_KEY`.

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

- `POST /v1/balance`
- `POST /v1/invoices`
- `POST /v1/payments`
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
- `SPARK_INVOICE_CACHE_TTL_MS` (default `3600000`)

## Powered by LNbits

[LNbits](https://lnbits.com) is a free and open-source lightning accounts system.

[![Visit LNbits Shop](https://img.shields.io/badge/Visit-LNbits%20Shop-7C3AED?logo=shopping-cart&logoColor=white&labelColor=5B21B6)](https://shop.lnbits.com/)
[![Try myLNbits SaaS](https://img.shields.io/badge/Try-myLNbits%20SaaS-2563EB?logo=lightning&logoColor=white&labelColor=1E40AF)](https://my.lnbits.com/login)
