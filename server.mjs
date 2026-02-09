import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import {SparkWallet, SparkWalletEvent} from '@buildonspark/spark-sdk'

const PORT = parseInt(process.env.SPARK_SIDECAR_PORT || '8765', 10)
const HOST = process.env.SPARK_SIDECAR_HOST || '127.0.0.1'
const API_KEY = process.env.SPARK_SIDECAR_API_KEY || ''
const MNEMONIC = process.env.SPARK_MNEMONIC || ''
const NETWORK = process.env.SPARK_NETWORK || 'MAINNET'
const PAY_WAIT_MS = parseInt(process.env.SPARK_PAY_WAIT_MS || '4000', 10)
const PAY_POLL_MS = parseInt(process.env.SPARK_PAY_POLL_MS || '500', 10)
const STREAM_KEEPALIVE_MS = parseInt(
  process.env.SPARK_STREAM_KEEPALIVE_MS || '15000',
  10
)
const STREAM_HEARTBEAT_MS = parseInt(
  process.env.SPARK_STREAM_HEARTBEAT_MS || '30000',
  10
)
const INVOICE_POLL_MS = parseInt(
  process.env.SPARK_INVOICE_POLL_MS || '2000',
  10
)
const INVOICE_POLL_LIMIT = parseInt(
  process.env.SPARK_INVOICE_POLL_LIMIT || '100',
  10
)
const INVOICE_CACHE_TTL_MS = parseInt(
  process.env.SPARK_INVOICE_CACHE_TTL_MS || '3600000',
  10
)
const TRANSFER_LOOKUP_CONCURRENCY = parseInt(
  process.env.SPARK_TRANSFER_LOOKUP_CONCURRENCY || '20',
  10
)
const TRANSFER_QUEUE_MAX = Math.max(
  1,
  parseInt(process.env.SPARK_TRANSFER_QUEUE_MAX || '5000', 10)
)
const ACCOUNT_NUMBER = process.env.SPARK_ACCOUNT_NUMBER
  ? parseInt(process.env.SPARK_ACCOUNT_NUMBER, 10)
  : undefined
const STATE_PATH =
  process.env.SPARK_SIDECAR_STATE_PATH ||
  path.join(process.cwd(), 'spark-sidecar-state.json')
const STATE_PERSIST_DEBOUNCE_MS = parseInt(
  process.env.SPARK_STATE_PERSIST_DEBOUNCE_MS || '1000',
  10
)

if (!MNEMONIC) {
  console.error('Missing SPARK_MNEMONIC for Spark sidecar.')
  process.exit(1)
}

let walletPromise
let walletInstance
const paymentHashToRequestId = new Map()
const sseClients = new Set()
const sseKeepaliveTimers = new Map()
const sseHeartbeatTimers = new Map()
const pendingTransferIds = new Set()
const transferQueue = []
let activeTransferLookups = 0
let walletListenersAttached = false
let droppedTransfers = 0
let lastDropLog = 0
const emittedInvoiceIds = new Map()
let invoicePollTimer = null
let invoicePollInFlight = false
let lastSeenUpdatedAtMs = 0
let statePersistTimer = null
let baselineInitialized = false
let stateLoaded = false

const DROP_LOG_INTERVAL_MS = 10000

loadState()

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return
    }
    const raw = fs.readFileSync(STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    stateLoaded = true
    if (Number.isFinite(parsed?.lastSeenUpdatedAtMs)) {
      lastSeenUpdatedAtMs = parsed.lastSeenUpdatedAtMs
    }
  } catch (error) {
    console.error('Error loading Spark sidecar state:', error)
  }
}

async function persistState() {
  try {
    await fs.promises.writeFile(
      STATE_PATH,
      JSON.stringify({lastSeenUpdatedAtMs}),
      'utf8'
    )
  } catch (error) {
    console.error('Error persisting Spark sidecar state:', error)
  }
}

function scheduleStatePersist() {
  if (statePersistTimer) {
    return
  }
  statePersistTimer = setTimeout(() => {
    statePersistTimer = null
    void persistState()
  }, Math.max(0, STATE_PERSIST_DEBOUNCE_MS))
}

function getRequestUpdatedAtMs(request) {
  const stamp = request?.updatedAt || request?.createdAt
  if (!stamp) {
    return 0
  }
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? parsed : 0
}

function rememberInvoiceEmitted(requestId, now = Date.now()) {
  if (!requestId) {
    return false
  }
  if (emittedInvoiceIds.has(requestId)) {
    return true
  }
  emittedInvoiceIds.set(requestId, now)
  return false
}

function attachWalletListeners(wallet) {
  if (walletListenersAttached) {
    return
  }
  walletListenersAttached = true

  wallet.on(SparkWalletEvent.TransferClaimed, transferId => {
    if (!transferId) {
      return
    }
    enqueueTransferLookup(transferId)
  })
}

async function getWallet() {
  if (!walletPromise) {
    walletPromise = SparkWallet.initialize({
      mnemonicOrSeed: MNEMONIC,
      accountNumber: ACCOUNT_NUMBER,
      options: {network: NETWORK}
    }).then(({wallet}) => {
      walletInstance = wallet
      attachWalletListeners(wallet)
      return wallet
    })
  }
  const wallet = await walletPromise
  if (wallet && !walletListenersAttached) {
    attachWalletListeners(wallet)
  }
  return wallet
}

async function shutdown() {
  try {
    if (walletPromise) {
      const wallet = await walletPromise
      if (wallet && typeof wallet.cleanupConnections === 'function') {
        await wallet.cleanupConnections()
      } else if (wallet && typeof wallet.cleanup === 'function') {
        wallet.cleanup()
      }
    }
  } catch (error) {
    console.error('Error during Spark sidecar shutdown:', error)
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {'content-type': 'application/json'})
  res.end(JSON.stringify(payload))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  if (chunks.length === 0) {
    return {}
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function feeToMsat(fee) {
  if (!fee || fee.originalValue === undefined || !fee.originalUnit) {
    return null
  }
  const value = Number(fee.originalValue)
  if (!Number.isFinite(value)) {
    return null
  }
  switch (fee.originalUnit) {
    case 'MILLISATOSHI':
      return BigInt(Math.round(value)).toString()
    case 'SATOSHI':
      return BigInt(Math.round(value * 1000)).toString()
    case 'BITCOIN':
      return BigInt(Math.round(value * 100_000_000_000)).toString()
    default:
      return BigInt(Math.round(value * 1000)).toString()
  }
}

const SEND_SUCCESS_STATUSES = new Set([
  'LIGHTNING_PAYMENT_SUCCEEDED',
  'TRANSFER_COMPLETED',
  'PREIMAGE_PROVIDED'
])
const SEND_FAILURE_STATUSES = new Set([
  'LIGHTNING_PAYMENT_FAILED',
  'TRANSFER_FAILED',
  'PREIMAGE_PROVIDING_FAILED',
  'USER_TRANSFER_VALIDATION_FAILED',
  'USER_SWAP_RETURN_FAILED'
])
const RECEIVE_SUCCESS_STATUSES = new Set([
  'LIGHTNING_PAYMENT_RECEIVED',
  'TRANSFER_COMPLETED',
  'PAYMENT_PREIMAGE_RECOVERED'
])

function isSendTerminal(status) {
  return SEND_SUCCESS_STATUSES.has(status) || SEND_FAILURE_STATUSES.has(status)
}

async function waitForSendStatus(wallet, requestId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const payment = await wallet.getLightningSendRequest(requestId)
    if (payment && isSendTerminal(payment.status)) {
      return payment
    }
    await new Promise(resolve => setTimeout(resolve, PAY_POLL_MS))
  }
  return null
}

function enqueueTransferLookup(transferId) {
  if (pendingTransferIds.has(transferId)) {
    return
  }
  pendingTransferIds.add(transferId)
  if (transferQueue.length >= TRANSFER_QUEUE_MAX) {
    const dropped = transferQueue.shift()
    if (dropped) {
      pendingTransferIds.delete(dropped)
      droppedTransfers += 1
      const now = Date.now()
      if (now - lastDropLog > DROP_LOG_INTERVAL_MS) {
        console.warn(
          `Dropping transfer events due to queue pressure: ${droppedTransfers}`
        )
        lastDropLog = now
      }
    }
  }
  transferQueue.push(transferId)
  processTransferQueue()
}

function processTransferQueue() {
  while (
    activeTransferLookups < TRANSFER_LOOKUP_CONCURRENCY &&
    transferQueue.length > 0
  ) {
    const transferId = transferQueue.shift()
    activeTransferLookups += 1
    void handleTransferLookup(transferId).finally(() => {
      activeTransferLookups -= 1
      pendingTransferIds.delete(transferId)
      processTransferQueue()
    })
  }
}

function pruneEmittedInvoiceCache(now) {
  if (INVOICE_CACHE_TTL_MS <= 0) {
    return
  }
  for (const [invoiceId, timestamp] of emittedInvoiceIds) {
    if (now - timestamp > INVOICE_CACHE_TTL_MS) {
      emittedInvoiceIds.delete(invoiceId)
    }
  }
}

async function pollInvoiceUpdates() {
  if (invoicePollInFlight || sseClients.size === 0) {
    return
  }
  invoicePollInFlight = true
  try {
    const now = Date.now()
    pruneEmittedInvoiceCache(now)
    const wallet = walletInstance || (await getWallet())
    let maxSeenUpdatedAtMs = lastSeenUpdatedAtMs
    let hasEntity = false
    let cursor = undefined
    let reachedKnown = false
    let isFirstPage = true
    while (true) {
      const response = await wallet.getUserRequests({
        first: INVOICE_POLL_LIMIT,
        after: cursor,
        types: ['LIGHTNING_RECEIVE'],
        statuses: ['SUCCEEDED']
      })
      const entities = response?.entities || []
      for (const request of entities) {
        if (!request || request.typename !== 'LightningReceiveRequest') {
          continue
        }
        if (!RECEIVE_SUCCESS_STATUSES.has(request.status)) {
          continue
        }
        const updatedAtMs = getRequestUpdatedAtMs(request)
        hasEntity = true
        if (updatedAtMs > maxSeenUpdatedAtMs) {
          maxSeenUpdatedAtMs = updatedAtMs
        }
        if (!baselineInitialized && !stateLoaded && lastSeenUpdatedAtMs === 0) {
          continue
        }
        if (updatedAtMs && updatedAtMs <= lastSeenUpdatedAtMs) {
          reachedKnown = true
          continue
        }
        if (rememberInvoiceEmitted(request.id, now)) {
          continue
        }
        const invoice = request.invoice || {}
        sendSseEvent({
          checking_id: request.id,
          payment_hash: invoice.paymentHash || null,
          status: request.status
        })
      }

      if (
        isFirstPage &&
        !baselineInitialized &&
        !stateLoaded &&
        lastSeenUpdatedAtMs === 0
      ) {
        baselineInitialized = true
        if (hasEntity && maxSeenUpdatedAtMs > lastSeenUpdatedAtMs) {
          lastSeenUpdatedAtMs = maxSeenUpdatedAtMs
          scheduleStatePersist()
        }
        return
      }

      const pageInfo = response?.pageInfo || {}
      cursor = pageInfo.endCursor
      if (!pageInfo.hasNextPage || !cursor || reachedKnown) {
        break
      }
      isFirstPage = false
    }

    if (maxSeenUpdatedAtMs > lastSeenUpdatedAtMs) {
      lastSeenUpdatedAtMs = maxSeenUpdatedAtMs
      scheduleStatePersist()
    }
  } catch (error) {
    console.error('Error polling lightning invoices:', error)
  } finally {
    invoicePollInFlight = false
  }
}

function startInvoicePolling() {
  if (INVOICE_POLL_MS <= 0 || invoicePollTimer) {
    return
  }
  invoicePollTimer = setInterval(() => {
    void pollInvoiceUpdates()
  }, INVOICE_POLL_MS)
  void pollInvoiceUpdates()
}

function stopInvoicePolling() {
  if (!invoicePollTimer) {
    return
  }
  clearInterval(invoicePollTimer)
  invoicePollTimer = null
}

async function handleTransferLookup(transferId) {
  try {
    const wallet = walletInstance || (await getWallet())
    const transfer = await wallet.getTransferFromSsp(transferId)
    const userRequest = transfer?.userRequest
    if (!userRequest || userRequest.typename !== 'LightningReceiveRequest') {
      return
    }
    if (!RECEIVE_SUCCESS_STATUSES.has(userRequest.status)) {
      return
    }
    const updatedAtMs = getRequestUpdatedAtMs(userRequest)
    if (updatedAtMs && updatedAtMs <= lastSeenUpdatedAtMs) {
      return
    }
    if (rememberInvoiceEmitted(userRequest.id)) {
      return
    }
    const invoice = userRequest.invoice || {}
    sendSseEvent({
      checking_id: userRequest.id,
      payment_hash: invoice.paymentHash || null,
      status: userRequest.status
    })
    if (updatedAtMs > lastSeenUpdatedAtMs) {
      lastSeenUpdatedAtMs = updatedAtMs
      scheduleStatePersist()
    }
  } catch (error) {
    console.error('Error handling transfer event:', error)
  }
}

function sendSseEvent(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(data)
    } catch (error) {
      removeSseClient(res)
    }
  }
}

function addSseClient(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(':\n\n')
  sseClients.add(res)

  if (STREAM_KEEPALIVE_MS > 0) {
    const timer = setInterval(() => {
      try {
        res.write(':\n\n')
      } catch (error) {
        removeSseClient(res)
      }
    }, STREAM_KEEPALIVE_MS)
    sseKeepaliveTimers.set(res, timer)
  }

  if (STREAM_HEARTBEAT_MS > 0) {
    const timer = setInterval(() => {
      try {
        res.write(
          `data: ${JSON.stringify({type: 'heartbeat', ts: Date.now()})}\n\n`
        )
      } catch (error) {
        removeSseClient(res)
      }
    }, STREAM_HEARTBEAT_MS)
    sseHeartbeatTimers.set(res, timer)
  }

  res.on('close', () => {
    removeSseClient(res)
  })

  startInvoicePolling()
}

function removeSseClient(res) {
  if (!sseClients.has(res)) {
    return
  }
  sseClients.delete(res)
  const timer = sseKeepaliveTimers.get(res)
  if (timer) {
    clearInterval(timer)
  }
  sseKeepaliveTimers.delete(res)
  const heartbeatTimer = sseHeartbeatTimers.get(res)
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
  }
  sseHeartbeatTimers.delete(res)

  if (sseClients.size === 0) {
    stopInvoicePolling()
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`
  )

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return sendJson(res, 401, {error: 'Unauthorized'})
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {status: 'ok'})
    }

    if (req.method === 'GET' && url.pathname === '/v1/invoices/stream') {
      await getWallet()
      addSseClient(res)
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/balance') {
      const wallet = await getWallet()
      const balance = await wallet.getBalance()
      const sats = BigInt(balance.balance)
      return sendJson(res, 200, {
        balance_sats: sats.toString(),
        balance_msat: (sats * 1000n).toString()
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/invoices') {
      const wallet = await getWallet()
      const body = await readJson(req)
      const amountSats = Number(body.amount_sats)
      if (!Number.isFinite(amountSats) || amountSats < 0) {
        return sendJson(res, 400, {error: 'Invalid amount_sats'})
      }
      const invoice = await wallet.createLightningInvoice({
        amountSats,
        memo: body.memo || undefined,
        descriptionHash: body.description_hash || undefined,
        expirySeconds: body.expiry_seconds || undefined
      })
      return sendJson(res, 200, {
        checking_id: invoice.id,
        payment_request: invoice.invoice.encodedInvoice,
        payment_hash: invoice.invoice.paymentHash,
        status: invoice.status,
        preimage: invoice.paymentPreimage || null
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/payments') {
      const wallet = await getWallet()
      const body = await readJson(req)
      const bolt11 = body.bolt11
      if (!bolt11) {
        return sendJson(res, 400, {error: 'Missing bolt11'})
      }
      const maxFeeSats = Number(body.max_fee_sats || 0)
      const amountSatsToSend = body.amount_sats
        ? Number(body.amount_sats)
        : undefined
      const paymentHash = body.payment_hash || null
      try {
        let payment = await wallet.payLightningInvoice({
          invoice: bolt11,
          maxFeeSats,
          amountSatsToSend
        })
        if (
          PAY_WAIT_MS > 0 &&
          payment &&
          payment.id &&
          !isSendTerminal(payment.status)
        ) {
          const refreshed = await waitForSendStatus(
            wallet,
            payment.id,
            PAY_WAIT_MS
          )
          if (refreshed) {
            payment = refreshed
          }
        }
        if (paymentHash && payment?.id) {
          paymentHashToRequestId.set(paymentHash, payment.id)
        }
        return sendJson(res, 200, {
          checking_id: paymentHash || payment.id,
          status: payment.status,
          fee_msat: feeToMsat(payment.fee),
          preimage: payment.paymentPreimage || null
        })
      } catch (error) {
        console.error('Error processing payment:', error)
        const message =
          error && typeof error === 'object' && 'initialMessage' in error
            ? error.initialMessage
            : error instanceof Error
            ? error.message
            : String(error)
        message == '' && (message = 'Payment failed')

        return sendJson(res, 500, {error: message})
      }
    }

    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'invoices') {
      const wallet = await getWallet()
      const invoice = await wallet.getLightningReceiveRequest(parts[2])
      if (!invoice) {
        return sendJson(res, 404, {error: 'Not found'})
      }
      return sendJson(res, 200, {
        checking_id: invoice.id,
        status: invoice.status,
        payment_hash: invoice.invoice.paymentHash,
        preimage: invoice.paymentPreimage || null
      })
    }

    if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'payments') {
      const wallet = await getWallet()
      const requestedId = parts[2]
      const lookupId = paymentHashToRequestId.get(requestedId) || requestedId
      const payment = await wallet.getLightningSendRequest(lookupId)
      if (!payment) {
        return sendJson(res, 404, {error: 'Not found'})
      }
      return sendJson(res, 200, {
        checking_id: requestedId,
        status: payment.status,
        fee_msat: feeToMsat(payment.fee),
        preimage: payment.paymentPreimage || null
      })
    }

    return sendJson(res, 404, {error: 'Not found'})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return sendJson(res, 500, {error: message})
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Spark sidecar listening on ${HOST}:${PORT}`)
})

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Spark sidecar port ${HOST}:${PORT} already in use.`)
    process.exit(1)
  }
  throw err
})
