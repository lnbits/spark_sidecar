import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import {SparkWallet, SparkWalletEvent} from '@buildonspark/spark-sdk'

import {
  BoundedWorkQueue,
  isRateLimitError,
  OperationTimeoutError,
  PaymentMappingStore,
  QueueFullError,
  singleFlight,
  withTimeout
} from './sidecar-runtime.mjs'

class PaymentQueueFullError extends Error {
  constructor() {
    super('Spark payment queue is at capacity')
    this.name = 'PaymentQueueFullError'
  }
}

const PORT = parseInt(process.env.SPARK_SIDECAR_PORT || '8765', 10)
const HOST = process.env.SPARK_SIDECAR_HOST || '127.0.0.1'
const API_KEY = process.env.SPARK_SIDECAR_API_KEY || ''
let mnemonic = process.env.SPARK_MNEMONIC || ''
const NETWORK = process.env.SPARK_NETWORK || 'MAINNET'
const MULTIPLICITY = parseInt(process.env.SPARK_MULTIPLICITY || '3', 10)
const PAY_WAIT_MS = parseInt(process.env.SPARK_PAY_WAIT_MS || '4000', 10)
const PAY_POLL_MS = parseInt(process.env.SPARK_PAY_POLL_MS || '500', 10)
const PAY_WAIT_MAX_MS = Math.max(
  0,
  parseInt(process.env.SPARK_PAY_WAIT_MAX_MS || '30000', 10)
)
const PAY_POLL_MAX_ACTIVE = Math.max(
  0,
  parseInt(process.env.SPARK_PAY_POLL_MAX_ACTIVE || '64', 10)
)
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
  : NETWORK === 'REGTEST'
    ? 0
    : 1
const BALANCE_RECOVERY_POLL_MS = Math.max(
  1,
  parseInt(process.env.SPARK_BALANCE_RECOVERY_POLL_MS || '2000', 10)
)
const BALANCE_RECOVERY_STABLE_READS = Math.max(
  1,
  parseInt(process.env.SPARK_BALANCE_RECOVERY_STABLE_READS || '3', 10)
)
const BALANCE_RECOVERY_TIMEOUT_MS = Math.max(
  0,
  parseInt(process.env.SPARK_BALANCE_RECOVERY_TIMEOUT_MS || '45000', 10)
)
const BALANCE_QUERY_TIMEOUT_MS = Math.max(
  0,
  parseInt(process.env.SPARK_BALANCE_QUERY_TIMEOUT_MS || '10000', 10)
)
const STATE_PATH =
  process.env.SPARK_SIDECAR_STATE_PATH ||
  path.join(process.cwd(), 'spark-sidecar-state.json')
const STATE_PERSIST_DEBOUNCE_MS = parseInt(
  process.env.SPARK_STATE_PERSIST_DEBOUNCE_MS || '1000',
  10
)
const PAYMENT_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.SPARK_PAYMENT_CONCURRENCY || '8', 10)
)
const PAYMENT_QUEUE_MAX = Math.max(
  0,
  parseInt(process.env.SPARK_PAYMENT_QUEUE_MAX || '64', 10)
)
const QUERY_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.SPARK_QUERY_CONCURRENCY || '4', 10)
)
const QUERY_MAX_RPS = Math.max(
  1,
  parseInt(process.env.SPARK_QUERY_MAX_RPS || '10', 10)
)
const QUERY_QUEUE_MAX = Math.max(
  1,
  parseInt(process.env.SPARK_QUERY_QUEUE_MAX || '200', 10)
)
const QUERY_RATE_LIMIT_BACKOFF_MS = Math.max(
  1,
  parseInt(process.env.SPARK_QUERY_RATE_LIMIT_BACKOFF_MS || '5000', 10)
)
const QUERY_RATE_LIMIT_BACKOFF_MAX_MS = Math.max(
  QUERY_RATE_LIMIT_BACKOFF_MS,
  parseInt(process.env.SPARK_QUERY_RATE_LIMIT_BACKOFF_MAX_MS || '60000', 10)
)
const PAYMENT_MAPPING_MAX = Math.max(
  1,
  parseInt(process.env.SPARK_PAYMENT_MAPPING_MAX || '100000', 10)
)
const PAYMENT_JOURNAL_COMPACT_ENTRIES = Math.max(
  1,
  parseInt(process.env.SPARK_PAYMENT_JOURNAL_COMPACT_ENTRIES || '5000', 10)
)
const PAYMENT_JOURNAL_COMPACT_BYTES = Math.max(
  1,
  parseInt(
    process.env.SPARK_PAYMENT_JOURNAL_COMPACT_BYTES || `${4 * 1024 * 1024}`,
    10
  )
)
const PAYMENT_MAPPING_SNAPSHOT_PATH =
  process.env.SPARK_PAYMENT_MAPPING_SNAPSHOT_PATH ||
  `${STATE_PATH}.payments.json`
const PAYMENT_MAPPING_JOURNAL_PATH =
  process.env.SPARK_PAYMENT_MAPPING_JOURNAL_PATH || `${STATE_PATH}.payments.log`
const REQUEST_LOG_ENABLED = process.env.SPARK_REQUEST_LOG === 'true'

if (
  !API_KEY &&
  HOST !== '127.0.0.1' &&
  HOST !== '::1' &&
  HOST !== 'localhost'
) {
  throw new Error(
    'SPARK_SIDECAR_API_KEY is required when binding to a non-loopback host.'
  )
}

let mnemonicReadyResolve
const mnemonicReady = new Promise(resolve => {
  mnemonicReadyResolve = resolve
})
if (mnemonic) {
  mnemonicReadyResolve()
}

let walletPromise
let walletInstance
let walletRecoveryPromise
let walletRecoveryStatus = 'initializing'
let lastKnownBalance = {available: 0n, owned: 0n, incoming: 0n}
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
let statePersistPromise = Promise.resolve()
let baselineInitialized = false
let stateLoaded = false
let legacyPaymentMappingsLoaded = false
let privacyConfigured = false
let privacyPromise = null
let activePaymentPolls = 0
let queryRateLimitBackoffMs = QUERY_RATE_LIMIT_BACKOFF_MS
let lastQueryRateLimitAt = 0
const paymentSubmissionsInFlight = new Map()
const sendRequestLookupsInFlight = new Map()
const idempotencyLookupsInFlight = new Map()
const balanceLookupsInFlight = new Map()
const receiveRequestLookupsInFlight = new Map()
const transferLookupsInFlight = new Map()
const pendingPaymentRequestIds = new Set()
const PAYMENT_HASH_PATTERN = /^[0-9a-f]{64}$/i
const RECEIVE_REQUEST_MAPPING_PREFIX = 'receive:'
const metrics = {
  paymentQueueDepth: 0,
  paymentActive: 0,
  paymentSubmitted: 0,
  paymentRejected: 0,
  paymentSubmissionErrors: 0,
  paymentSubmissionDurationMsTotal: 0,
  paymentSubmissionDurationMsLast: 0,
  paymentSubmissionDurationMsMax: 0,
  queryQueueDepth: 0,
  queryActive: 0,
  queryRejected: 0,
  queryStarted: 0,
  queryRateLimits: 0,
  activePaymentPolls: 0,
  paymentPollsSkipped: 0,
  sparkErrors: 0,
  stateWrites: 0,
  stateWriteErrors: 0,
  stateWriteDurationMsTotal: 0,
  stateWriteDurationMsLast: 0,
  stateWriteDurationMsMax: 0
}

const DROP_LOG_INTERVAL_MS = 10000

loadState()

const paymentMappingStore = new PaymentMappingStore({
  snapshotPath: PAYMENT_MAPPING_SNAPSHOT_PATH,
  journalPath: PAYMENT_MAPPING_JOURNAL_PATH,
  mappings: paymentHashToRequestId,
  debounceMs: STATE_PERSIST_DEBOUNCE_MS,
  compactEntries: PAYMENT_JOURNAL_COMPACT_ENTRIES,
  compactBytes: PAYMENT_JOURNAL_COMPACT_BYTES,
  maxMappings: PAYMENT_MAPPING_MAX,
  onWrite: (durationMs, error) => {
    metrics.stateWrites += 1
    metrics.stateWriteDurationMsLast = durationMs
    metrics.stateWriteDurationMsTotal += durationMs
    metrics.stateWriteDurationMsMax = Math.max(
      metrics.stateWriteDurationMsMax,
      durationMs
    )
    if (error) {
      metrics.stateWriteErrors += 1
    }
  },
  onError: (operation, error) => {
    console.error(`Error ${operation}:`, error)
  }
})
paymentMappingStore.load()
if (legacyPaymentMappingsLoaded) {
  void paymentMappingStore.compact()
}

const paymentQueue = new BoundedWorkQueue({
  concurrency: PAYMENT_CONCURRENCY,
  maxQueue: PAYMENT_QUEUE_MAX,
  name: 'payment submission',
  onChange: ({active, depth}) => {
    metrics.paymentActive = active
    metrics.paymentQueueDepth = depth
  }
})

const queryQueue = new BoundedWorkQueue({
  concurrency: QUERY_CONCURRENCY,
  maxQueue: QUERY_QUEUE_MAX,
  minStartIntervalMs: Math.ceil(1000 / QUERY_MAX_RPS),
  name: 'Spark query',
  onChange: ({active, depth}) => {
    metrics.queryActive = active
    metrics.queryQueueDepth = depth
  }
})

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return
    }
    const raw = fs.readFileSync(STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    stateLoaded =
      typeof parsed?.invoiceStateInitialized === 'boolean'
        ? parsed.invoiceStateInitialized
        : Number.isFinite(parsed?.lastSeenUpdatedAtMs)
    if (Number.isFinite(parsed?.lastSeenUpdatedAtMs)) {
      lastSeenUpdatedAtMs = parsed.lastSeenUpdatedAtMs
    }
    if (
      parsed?.paymentRequestIds &&
      typeof parsed.paymentRequestIds === 'object'
    ) {
      legacyPaymentMappingsLoaded = true
      for (const [paymentHash, requestId] of Object.entries(
        parsed.paymentRequestIds
      )) {
        if (typeof requestId === 'string') {
          paymentHashToRequestId.set(paymentHash, requestId)
        }
      }
    }
  } catch (error) {
    console.error('Error loading Spark sidecar state:', error)
  }
}

function persistState() {
  const state = JSON.stringify({
    invoiceStateInitialized: stateLoaded || baselineInitialized,
    lastSeenUpdatedAtMs
  })
  statePersistPromise = statePersistPromise.then(async () => {
    const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`
    try {
      await fs.promises.writeFile(temporaryPath, state, 'utf8')
      await fs.promises.rename(temporaryPath, STATE_PATH)
    } catch (error) {
      console.error('Error persisting Spark sidecar state:', error)
    }
  })
  return statePersistPromise
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

function rememberPaymentRequestId(paymentHash, requestId) {
  paymentMappingStore.remember(paymentHash, requestId)
}

function isPaymentHash(value) {
  return typeof value === 'string' && PAYMENT_HASH_PATTERN.test(value)
}

function receiveRequestMappingKey(paymentHash) {
  return `${RECEIVE_REQUEST_MAPPING_PREFIX}${paymentHash.toLowerCase()}`
}

function rememberReceiveRequestId(paymentHash, requestId) {
  if (isPaymentHash(paymentHash)) {
    rememberPaymentRequestId(receiveRequestMappingKey(paymentHash), requestId)
  }
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

function getSatsBalance(balance) {
  const available = BigInt(
    balance?.satsBalance?.available ?? balance?.balance ?? 0
  )
  return {
    available,
    owned: BigInt(balance?.satsBalance?.owned ?? available),
    incoming: BigInt(balance?.satsBalance?.incoming ?? 0)
  }
}

function observeBalance(balance) {
  lastKnownBalance = balance
  return balance
}

async function getSatsBalanceWithTimeout(wallet) {
  return observeBalance(
    getSatsBalance(
      await withTimeout(
        getSparkBalance(wallet),
        BALANCE_QUERY_TIMEOUT_MS,
        `Spark balance query timed out after ${BALANCE_QUERY_TIMEOUT_MS}ms`
      )
    )
  )
}

function sendBalanceResponse(res, balance) {
  return sendJson(res, 200, {
    balance_sats: balance.available.toString(),
    balance_msat: (balance.available * 1000n).toString(),
    available_sats: balance.available.toString(),
    owned_sats: balance.owned.toString(),
    incoming_sats: balance.incoming.toString(),
    status: walletRecoveryStatus
  })
}

function markWalletRecovering(wallet) {
  walletRecoveryStatus = 'recovering'
  if (wallet && !walletRecoveryPromise) {
    void startWalletRecovery(wallet)
  }
}

async function waitForStableBalance(wallet) {
  const deadline = Date.now() + BALANCE_RECOVERY_TIMEOUT_MS
  let previousAvailable
  let stableReads = 0

  do {
    const balance = await getSatsBalanceWithTimeout(wallet)

    if (balance.incoming === 0n && balance.available === previousAvailable) {
      stableReads += 1
      if (stableReads >= BALANCE_RECOVERY_STABLE_READS) {
        return
      }
    } else {
      stableReads = 0
    }

    previousAvailable = balance.available
    if (Date.now() >= deadline) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, BALANCE_RECOVERY_POLL_MS))
  } while (Date.now() < deadline)

  throw new Error(
    `Spark wallet balance did not settle within ${BALANCE_RECOVERY_TIMEOUT_MS}ms`
  )
}

function startWalletRecovery(wallet) {
  if (walletRecoveryStatus === 'ready' || walletRecoveryPromise) {
    return walletRecoveryPromise
  }

  walletRecoveryStatus = 'recovering'
  walletRecoveryPromise = waitForStableBalance(wallet)
    .then(() => {
      walletRecoveryStatus = 'ready'
      console.log('Spark wallet balance recovery completed.')
    })
    .catch(error => {
      console.error('Spark wallet balance recovery incomplete:', error)
    })
    .finally(() => {
      walletRecoveryPromise = null
    })
  return walletRecoveryPromise
}

async function configurePrivacy(wallet) {
  if (privacyConfigured) {
    return
  }
  if (!privacyPromise) {
    privacyPromise = wallet
      .setPrivacyEnabled(true)
      .then(() => {
        privacyConfigured = true
      })
      .finally(() => {
        privacyPromise = null
      })
  }
  await privacyPromise
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
      walletInstance = wallet
      attachWalletListeners(wallet)
      console.log('Spark wallet initialized.')
      return wallet
    })
  }
  const wallet = await walletPromise

  await configurePrivacy(wallet)
  void startWalletRecovery(wallet)

  if (wallet && !walletListenersAttached) {
    attachWalletListeners(wallet)
  }
  return wallet
}

async function shutdown() {
  try {
    console.log('Shutting down Spark sidecar...')
    if (statePersistTimer) {
      clearTimeout(statePersistTimer)
      statePersistTimer = null
      await persistState()
    } else {
      await statePersistPromise
    }
    await paymentMappingStore.flush()
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

function metricLine(name, value, help, type = 'gauge') {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`
}

function sendMetrics(res) {
  const submissionAverage =
    metrics.paymentSubmitted > 0
      ? metrics.paymentSubmissionDurationMsTotal / metrics.paymentSubmitted
      : 0
  const stateWriteAverage =
    metrics.stateWrites > 0
      ? metrics.stateWriteDurationMsTotal / metrics.stateWrites
      : 0
  const lines = [
    metricLine(
      'spark_sidecar_payment_queue_depth',
      metrics.paymentQueueDepth,
      'Payment submissions waiting for a concurrency slot.'
    ),
    metricLine(
      'spark_sidecar_payment_active',
      metrics.paymentActive,
      'Payment submissions currently using a concurrency slot.'
    ),
    metricLine(
      'spark_sidecar_payment_submitted_total',
      metrics.paymentSubmitted,
      'Payment submissions started against Spark.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_payment_rejected_total',
      metrics.paymentRejected,
      'Payment submissions rejected before submission due to backpressure.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_payment_submission_errors_total',
      metrics.paymentSubmissionErrors,
      'Payment submission calls that returned an error.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_payment_submission_duration_ms',
      metrics.paymentSubmissionDurationMsLast,
      'Most recent payment submission duration including queue time.'
    ),
    metricLine(
      'spark_sidecar_payment_submission_duration_ms_avg',
      submissionAverage,
      'Average payment submission duration including queue time.'
    ),
    metricLine(
      'spark_sidecar_payment_submission_duration_ms_max',
      metrics.paymentSubmissionDurationMsMax,
      'Maximum payment submission duration including queue time.'
    ),
    metricLine(
      'spark_sidecar_payment_polls_active',
      metrics.activePaymentPolls,
      'Payments currently waiting for a terminal Spark status.'
    ),
    metricLine(
      'spark_sidecar_payment_polls_skipped_total',
      metrics.paymentPollsSkipped,
      'Active settlement waits skipped because the local poll limit was reached.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_payments_pending',
      pendingPaymentRequestIds.size,
      'Observed Spark payments whose latest status is not terminal.'
    ),
    metricLine(
      'spark_sidecar_query_queue_depth',
      metrics.queryQueueDepth,
      'Spark status and history queries waiting for the shared rate limiter.'
    ),
    metricLine(
      'spark_sidecar_query_active',
      metrics.queryActive,
      'Spark status and history queries currently active.'
    ),
    metricLine(
      'spark_sidecar_query_started_total',
      metrics.queryStarted,
      'Rate-limited Spark status and history queries started.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_query_rejected_total',
      metrics.queryRejected,
      'Spark queries rejected because the local query queue was full.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_query_rate_limits_total',
      metrics.queryRateLimits,
      'Spark query rate-limit responses that triggered local backoff.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_query_cooldown_seconds',
      Math.max(0, (queryQueue.pausedUntil - Date.now()) / 1000),
      'Remaining local query cooldown after a Spark rate-limit response.'
    ),
    metricLine(
      'spark_sidecar_spark_errors_total',
      metrics.sparkErrors,
      'Errors returned by Spark submission and query operations.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_state_write_duration_ms',
      metrics.stateWriteDurationMsLast,
      'Most recent payment mapping journal write duration.'
    ),
    metricLine(
      'spark_sidecar_state_write_duration_ms_avg',
      stateWriteAverage,
      'Average payment mapping journal write duration.'
    ),
    metricLine(
      'spark_sidecar_state_write_duration_ms_max',
      metrics.stateWriteDurationMsMax,
      'Maximum payment mapping journal write duration.'
    ),
    metricLine(
      'spark_sidecar_state_write_errors_total',
      metrics.stateWriteErrors,
      'Payment mapping journal write failures.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_payment_mappings',
      paymentHashToRequestId.size,
      'Payment hash to Spark request mappings held in memory.'
    ),
    metricLine(
      'spark_sidecar_transfer_queue_depth',
      transferQueue.length,
      'Incoming transfer events waiting for lookup.'
    ),
    metricLine(
      'spark_sidecar_transfer_events_dropped_total',
      droppedTransfers,
      'Incoming transfer events dropped from the bounded queue.',
      'counter'
    ),
    metricLine(
      'spark_sidecar_privacy_configured',
      privacyConfigured ? 1 : 0,
      'Whether wallet privacy was configured during initialization.'
    )
  ]
  res.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8'
  })
  res.end(`${lines.join('\n')}\n`)
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
      return null
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

const SEND_SUCCESS_STATUSES = new Set(['TRANSFER_COMPLETED'])
const SEND_FAILURE_STATUSES = new Set(['TRANSFER_FAILED'])
const RECEIVE_SUCCESS_STATUSES = new Set(['TRANSFER_COMPLETED'])

function isSendTerminal(status) {
  return SEND_SUCCESS_STATUSES.has(status) || SEND_FAILURE_STATUSES.has(status)
}

function observePaymentStatus(payment) {
  if (!payment?.id) {
    return
  }
  if (isSendTerminal(payment.status)) {
    pendingPaymentRequestIds.delete(payment.id)
  } else {
    pendingPaymentRequestIds.delete(payment.id)
    pendingPaymentRequestIds.add(payment.id)
    while (pendingPaymentRequestIds.size > PAYMENT_MAPPING_MAX) {
      pendingPaymentRequestIds.delete(
        pendingPaymentRequestIds.values().next().value
      )
    }
  }
}

function applyQueryRateLimitBackoff() {
  lastQueryRateLimitAt = Date.now()
  metrics.queryRateLimits += 1
  queryQueue.pause(queryRateLimitBackoffMs)
  queryRateLimitBackoffMs = Math.min(
    QUERY_RATE_LIMIT_BACKOFF_MAX_MS,
    queryRateLimitBackoffMs * 2
  )
}

async function runSparkQuery(task, priority = 0) {
  try {
    return await queryQueue.run(
      async () => {
        metrics.queryStarted += 1
        try {
          const result = await task()
          if (
            lastQueryRateLimitAt > 0 &&
            Date.now() - lastQueryRateLimitAt >= QUERY_RATE_LIMIT_BACKOFF_MS
          ) {
            queryRateLimitBackoffMs = QUERY_RATE_LIMIT_BACKOFF_MS
          }
          return result
        } catch (error) {
          metrics.sparkErrors += 1
          if (isRateLimitError(error)) {
            applyQueryRateLimitBackoff()
          }
          throw error
        }
      },
      {priority}
    )
  } catch (error) {
    if (error instanceof QueueFullError) {
      metrics.queryRejected += 1
    }
    throw error
  }
}

function getSparkBalance(wallet) {
  return singleFlight(balanceLookupsInFlight, 'balance', () =>
    runSparkQuery(() => wallet.getBalance())
  )
}

function getLightningReceiveRequest(wallet, requestId) {
  return singleFlight(receiveRequestLookupsInFlight, requestId, () =>
    runSparkQuery(() => wallet.getLightningReceiveRequest(requestId), 5)
  )
}

async function resolveLightningReceiveRequest(wallet, requestedId) {
  if (!isPaymentHash(requestedId)) {
    return await getLightningReceiveRequest(wallet, requestedId)
  }

  const mappedId = paymentHashToRequestId.get(
    receiveRequestMappingKey(requestedId)
  )
  if (!mappedId) {
    return {
      id: requestedId,
      status: 'PENDING',
      invoice: {paymentHash: requestedId},
      paymentPreimage: null
    }
  }

  return await getLightningReceiveRequest(wallet, mappedId)
}

function getTransferFromSsp(wallet, transferId) {
  return singleFlight(transferLookupsInFlight, transferId, () =>
    runSparkQuery(() => wallet.getTransferFromSsp(transferId), 5)
  )
}

function getLightningSendRequest(wallet, requestId) {
  return singleFlight(sendRequestLookupsInFlight, requestId, () =>
    runSparkQuery(() => wallet.getLightningSendRequest(requestId), 10)
  )
}

function submitLightningPayment(wallet, params, paymentHash) {
  return singleFlight(paymentSubmissionsInFlight, paymentHash, async () => {
    const startedAt = performance.now()
    try {
      return await paymentQueue.run(async () => {
        metrics.paymentSubmitted += 1
        return await wallet.payLightningInvoice(params)
      })
    } catch (error) {
      if (error instanceof QueueFullError) {
        metrics.paymentRejected += 1
        throw new PaymentQueueFullError()
      } else {
        metrics.paymentSubmissionErrors += 1
        metrics.sparkErrors += 1
      }
      throw error
    } finally {
      const durationMs = performance.now() - startedAt
      metrics.paymentSubmissionDurationMsLast = durationMs
      metrics.paymentSubmissionDurationMsTotal += durationMs
      metrics.paymentSubmissionDurationMsMax = Math.max(
        metrics.paymentSubmissionDurationMsMax,
        durationMs
      )
    }
  })
}

async function waitForSendStatus(
  wallet,
  requestId,
  timeoutMs,
  pollMs = PAY_POLL_MS
) {
  if (activePaymentPolls >= PAY_POLL_MAX_ACTIVE) {
    metrics.paymentPollsSkipped += 1
    return null
  }
  const deadline = Date.now() + timeoutMs
  activePaymentPolls += 1
  metrics.activePaymentPolls = activePaymentPolls
  try {
    while (Date.now() < deadline) {
      const payment = await getLightningSendRequest(wallet, requestId)
      if (payment && isSendTerminal(payment.status)) {
        return payment
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        break
      }
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(Math.max(1, pollMs), remainingMs))
      )
    }
    return null
  } finally {
    activePaymentPolls -= 1
    metrics.activePaymentPolls = activePaymentPolls
  }
}

async function findPaymentByIdempotencyKey(wallet, idempotencyKey) {
  return singleFlight(idempotencyLookupsInFlight, idempotencyKey, async () => {
    let cursor
    do {
      const response = await runSparkQuery(
        () =>
          wallet.getUserRequests({
            first: 100,
            after: cursor,
            types: ['LIGHTNING_SEND']
          }),
        10
      )
      const payment = response?.entities?.find(
        request =>
          request?.typename === 'LightningSendRequest' &&
          request.idempotencyKey === idempotencyKey
      )
      if (payment) {
        return payment
      }
      cursor = response?.pageInfo?.hasNextPage
        ? response.pageInfo.endCursor
        : undefined
    } while (cursor)
    return null
  })
}

function sendPaymentResponse(res, checkingId, payment) {
  observePaymentStatus(payment)
  return sendJson(res, 200, {
    checking_id: checkingId,
    status: payment.status,
    fee_msat: feeToMsat(payment.fee),
    preimage: payment.paymentPreimage || null
  })
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
      const response = await runSparkQuery(
        () =>
          wallet.getUserRequests({
            first: INVOICE_POLL_LIMIT,
            after: cursor,
            types: ['LIGHTNING_RECEIVE'],
            statuses: ['SUCCEEDED']
          }),
        -10
      )
      const entities = response?.entities || []
      if (REQUEST_LOG_ENABLED) {
        console.log(
          `Polled ${entities.length} lightning receive requests (cursor: ${cursor})`
        )
      }
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
        rememberReceiveRequestId(invoice.paymentHash, request.id)
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
    const transfer = await getTransferFromSsp(wallet, transferId)
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
    rememberReceiveRequestId(invoice.paymentHash, userRequest.id)
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
  if (REQUEST_LOG_ENABLED) {
    console.log('Sending SSE event')
  }
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
    console.log('Unauthorized request with invalid API key')
    return sendJson(res, 401, {error: 'Unauthorized'})
  }

  if (REQUEST_LOG_ENABLED) {
    console.log(`${req.method} ${url.pathname}`)
  }
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        wallet_status: mnemonic ? walletRecoveryStatus : 'missing_mnemonic'
      })
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      return sendMetrics(res)
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
      void startWalletRecovery(wallet)
      try {
        return sendBalanceResponse(res, await getSatsBalanceWithTimeout(wallet))
      } catch (error) {
        if (!(error instanceof OperationTimeoutError)) {
          console.warn(
            'Spark wallet balance unavailable; keeping wallet recovering:',
            error instanceof Error ? error.message : String(error)
          )
        }
        markWalletRecovering(wallet)
        return sendBalanceResponse(res, lastKnownBalance)
      }
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
      rememberReceiveRequestId(invoice.invoice.paymentHash, invoice.id)
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
      const payWaitMs = Number.isFinite(Number(body.wait_ms))
        ? Math.min(
            PAY_WAIT_MAX_MS,
            Math.max(0, Math.trunc(Number(body.wait_ms)))
          )
        : Math.min(PAY_WAIT_MS, PAY_WAIT_MAX_MS)
      const payPollMs = Number.isFinite(Number(body.poll_ms))
        ? Math.max(1, Math.trunc(Number(body.poll_ms)))
        : PAY_POLL_MS
      const amountSatsToSend = body.amount_sats
        ? Number(body.amount_sats)
        : undefined
      const paymentHash = body.payment_hash || null
      try {
        let payment = await submitLightningPayment(
          wallet,
          {
            invoice: bolt11,
            maxFeeSats,
            amountSatsToSend,
            idempotencyKey: paymentHash || undefined
          },
          paymentHash
        )
        observePaymentStatus(payment)
        if (paymentHash && payment?.id) {
          rememberPaymentRequestId(paymentHash, payment.id)
        }
        if (
          payWaitMs > 0 &&
          payment &&
          payment.id &&
          !isSendTerminal(payment.status)
        ) {
          const refreshed = await waitForSendStatus(
            wallet,
            payment.id,
            payWaitMs,
            payPollMs
          )
          if (refreshed) {
            payment = refreshed
          }
        }
        return sendPaymentResponse(res, paymentHash || payment.id, payment)
      } catch (error) {
        if (error instanceof PaymentQueueFullError) {
          res.setHeader('retry-after', '1')
          return sendJson(res, 503, {
            error: error.message,
            payment_submitted: false
          })
        }
        console.error('Error processing payment:', error)
        let message =
          error && typeof error === 'object' && 'initialMessage' in error
            ? error.initialMessage
            : error instanceof Error
              ? error.message
              : String(error)
        if (!message) {
          message = 'Payment result is unknown'
        }

        if (paymentHash) {
          try {
            const payment = await findPaymentByIdempotencyKey(
              wallet,
              paymentHash
            )
            if (payment) {
              rememberPaymentRequestId(paymentHash, payment.id)
              return sendPaymentResponse(res, paymentHash, payment)
            }
          } catch (lookupError) {
            console.error('Error recovering ambiguous payment:', lookupError)
          }
        }

        return sendJson(res, 500, {error: message})
      }
    }

    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'invoices') {
      const wallet = await getWallet()
      const invoice = await resolveLightningReceiveRequest(wallet, parts[2])
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
      const lookupId = paymentHashToRequestId.get(requestedId)
      let payment = lookupId
        ? await getLightningSendRequest(wallet, lookupId)
        : null
      if (!payment && isPaymentHash(requestedId)) {
        payment = await findPaymentByIdempotencyKey(wallet, requestedId)
        if (payment) {
          rememberPaymentRequestId(requestedId, payment.id)
        }
      }
      if (!payment && !lookupId && !/^[0-9a-f]{64}$/i.test(requestedId)) {
        payment = await getLightningSendRequest(wallet, requestedId)
      }
      if (!payment) {
        return sendJson(res, 404, {error: 'Not found'})
      }
      return sendPaymentResponse(res, requestedId, payment)
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
