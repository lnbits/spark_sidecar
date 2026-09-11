import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import {createPaymentHandler} from './payments.mjs'
import {IncomingInvoices, receiveSuccessStatuses} from './incoming.mjs'
import {refreshBalance} from './lightning.mjs'

import {SparkWallet, SparkWalletEvent} from '@buildonspark/spark-sdk'

const PORT = parseInt(process.env.SPARK_SIDECAR_PORT || '8765', 10)
const HOST = process.env.SPARK_SIDECAR_HOST || '127.0.0.1'
const API_KEY = process.env.SPARK_SIDECAR_API_KEY || ''
let mnemonic = process.env.SPARK_MNEMONIC || ''
const NETWORK = process.env.SPARK_NETWORK || 'MAINNET'
const MULTIPLICITY = parseInt(process.env.SPARK_MULTIPLICITY || '3', 10)
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

let mnemonicReadyResolve
const mnemonicReady = new Promise(resolve => {
  mnemonicReadyResolve = resolve
})
if (mnemonic) {
  mnemonicReadyResolve()
}

let server
let paymentHandler = null
let incomingInvoices
let walletPromise
let privacyPromise
let walletInstance
const sseClients = new Set()
const sseKeepaliveTimers = new Map()
const sseHeartbeatTimers = new Map()
const pendingTransferIds = new Set()
const transferQueue = []
let activeTransferLookups = 0
let walletListenersAttached = false
let droppedTransfers = 0
let lastDropLog = 0
let invoicePollTimer = null
let invoicePollInFlight = false
let lastSeenUpdatedAtMs = Date.now()
let statePersistTimer = null
let invoiceScan = null

const DROP_LOG_INTERVAL_MS = 10000

loadState()

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return
    }
    const raw = fs.readFileSync(STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
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
  statePersistTimer = setTimeout(
    () => {
      statePersistTimer = null
      void persistState()
    },
    Math.max(0, STATE_PERSIST_DEBOUNCE_MS)
  )
}

function getRequestUpdatedAtMs(request) {
  const stamp = request?.updatedAt || request?.createdAt
  if (!stamp) {
    return 0
  }
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? parsed : 0
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
  await mnemonicReady
  if (!walletPromise) {
    console.log('Initializing Spark wallet...')
    walletPromise = SparkWallet.initialize({
      mnemonicOrSeed: mnemonic,
      accountNumber: ACCOUNT_NUMBER,
      options: {
        network: NETWORK,
        optimizationOptions: {
          auto: true,
          multiplicity: MULTIPLICITY
        }
      }
    }).then(({wallet}) => {
      attachWalletListeners(wallet)
      console.log('Spark wallet initialized.')
      return wallet
    })
  }
  const wallet = await walletPromise
  privacyPromise ||= wallet.setPrivacyEnabled(true).catch(error => {
    privacyPromise = null
    throw error
  })
  await privacyPromise
  walletInstance = wallet

  if (wallet && !walletListenersAttached) {
    attachWalletListeners(wallet)
  }
  return wallet
}

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  server?.close()
  try {
    stopInvoicePolling()
    await incomingInvoices?.close()
    await paymentHandler?.close()
    console.log('Shutting down Spark sidecar...')
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

function setMnemonic(nextMnemonic) {
  if (!nextMnemonic) {
    return {status: 'missing'}
  }
  if (mnemonic) {
    if (mnemonic === nextMnemonic) {
      return {status: 'already_set'}
    }
    return {status: 'conflict'}
  }
  mnemonic = nextMnemonic
  mnemonicReadyResolve()
  return {status: 'set'}
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

async function pollInvoiceUpdates() {
  if (invoicePollInFlight || sseClients.size === 0 || stopping) return
  invoicePollInFlight = true
  try {
    await incomingInvoices.retryPending(INVOICE_POLL_LIMIT)
    const wallet = walletInstance || (await getWallet())
    invoiceScan ||= {
      cursor: undefined,
      maxSeen: lastSeenUpdatedAtMs,
      threshold: lastSeenUpdatedAtMs
    }
    // Bound each pass; retain the cursor to catch up across ticks under load.
    for (let page = 0; page < 4; page++) {
      const response = await wallet.getUserRequests({
        first: INVOICE_POLL_LIMIT,
        after: invoiceScan.cursor,
        types: ['LIGHTNING_RECEIVE'],
        statuses: ['SUCCEEDED']
      })
      const entities = response?.entities || []
      let reachedKnown = false
      const observations = []
      for (const request of entities) {
        if (
          request?.typename !== 'LightningReceiveRequest' ||
          !receiveSuccessStatuses.has(request.status)
        )
          continue
        const stamp = getRequestUpdatedAtMs(request)
        if (stamp && stamp < invoiceScan.threshold) {
          reachedKnown = true
          continue
        }
        invoiceScan.maxSeen = Math.max(invoiceScan.maxSeen, stamp)
        observations.push(incomingInvoices.observe(request))
      }
      // Every candidate is durable before advancing the discovery watermark.
      const results = await Promise.allSettled(observations)
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
      const info = response?.pageInfo || {}
      if (!info.hasNextPage || reachedKnown) {
        lastSeenUpdatedAtMs = invoiceScan.maxSeen
        invoiceScan = null
        scheduleStatePersist()
        break
      }
      if (!info.endCursor || info.endCursor === invoiceScan.cursor)
        throw new Error('Invalid invoice pagination')
      invoiceScan.cursor = info.endCursor
    }
  } catch (error) {
    console.error('Error polling lightning invoices:', error)
  } finally {
    invoicePollInFlight = false
  }
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
    if (!receiveSuccessStatuses.has(userRequest.status)) return
    await incomingInvoices.observe(userRequest)
  } catch (error) {
    console.error('Error handling transfer event:', error)
  }
}

function sendSseEvent(payload) {
  if (sseClients.size === 0) return false
  let sent = false
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try {
      if (!res.write(data)) {
        res.destroy()
        removeSseClient(res)
      } else sent = true
    } catch (error) {
      removeSseClient(res)
    }
  }
  return sent
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
  if (!invoicePollTimer) {
    invoicePollTimer = setInterval(
      () => void pollInvoiceUpdates(),
      Math.max(1, INVOICE_POLL_MS)
    )
    void pollInvoiceUpdates()
  }

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

paymentHandler = await createPaymentHandler({
  getWallet,
  network: NETWORK,
  apiKey: API_KEY,
  waitMs: PAY_WAIT_MS,
  pollMs: PAY_POLL_MS,
  concurrency: Number(process.env.SPARK_OPERATION_CONCURRENCY || 8),
  fundsWaitMs: Math.max(
    0,
    parseInt(process.env.SPARK_FUNDS_WAIT_MS || '20000', 10)
  ),
  directory:
    process.env.SPARK_PAYMENT_STATE_DIR ||
    // Reuse journals from the earlier combined build; never lose send intents.
    process.env.SPARK_ONCHAIN_STATE_DIR ||
    (fs.existsSync(path.join(path.dirname(STATE_PATH), 'onchain'))
      ? path.join(path.dirname(STATE_PATH), 'onchain')
      : path.join(path.dirname(STATE_PATH), 'payments'))
})

incomingInvoices = new IncomingInvoices({
  journal: paymentHandler.journal,
  getWallet,
  emit: sendSseEvent,
  concurrency: Number(process.env.SPARK_OPERATION_CONCURRENCY || 8)
})
await incomingInvoices.initialize()

server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`
  )

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    console.log('Unauthorized request with invalid API key')
    return sendJson(res, 401, {error: 'Unauthorized'})
  }

  console.log(`${req.method} ${url.pathname}`)
  try {
    if (paymentHandler && (await paymentHandler(req, res, url))) return
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {status: 'ok'})
    }

    if (req.method === 'POST' && url.pathname === '/v1/mnemonic') {
      const body = await readJson(req)
      const provided = body.mnemonic || body.mnemonic_or_seed || ''
      const result = setMnemonic(provided)
      if (result.status === 'missing') {
        return sendJson(res, 400, {error: 'Missing mnemonic'})
      }
      if (result.status === 'conflict') {
        return sendJson(res, 409, {error: 'Mnemonic already set'})
      }
      return sendJson(res, 200, {status: result.status})
    }

    if (req.method === 'GET' && url.pathname === '/v1/invoices/stream') {
      await getWallet()
      addSseClient(res)
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/balance') {
      if (!mnemonic) {
        return sendJson(res, 200, {status: 'missing_mnemonic'})
      }
      const wallet = await getWallet()
      const balance = await refreshBalance(wallet)
      const sats = BigInt(balance.balance)
      return sendJson(res, 200, {
        balance_sats: sats.toString(),
        balance_msat: (sats * 1000n).toString(),
        status: 'ok'
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

    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'invoices') {
      const invoice = await incomingInvoices.observe({id: parts[2]})
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
      // Legacy clients may still use an opaque Spark request ID.
      const payment = await wallet.getLightningSendRequest(requestedId)
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
    console.error('Error handling request:', error)
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
