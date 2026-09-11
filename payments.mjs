import {OperationQueue} from './operation-queue.mjs'
import {createHash, timingSafeEqual} from 'node:crypto'
import {
  prepareLightningPayment,
  sendLightningPayment,
  findLightningPayment,
  terminalPaymentStatuses,
  decodePayment,
  lightningSendPaymentHash,
  FundsUnavailableError,
  PaymentPreparationError
} from './lightning.mjs'

function integer(value, min = 0, max = 100_000_000) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('Invalid amount')
  return value
}

function msats(value) {
  const precision = {SATOSHI: 3, MILLISATOSHI: 0, BITCOIN: 11}[
    value?.originalUnit
  ]
  if (precision === undefined) throw new Error('Unsupported fee unit')
  const [mantissa, exponent = '0'] = String(value.originalValue)
    .toLowerCase()
    .split('e')
  if (!/^\d+(\.\d+)?$/.test(mantissa) || !/^[+-]?\d+$/.test(exponent))
    throw new Error('Invalid fee')
  const [whole, fraction = ''] = mantissa.split('.')
  const scale = Number(exponent) + precision - fraction.length
  if (Math.abs(scale) > 20) throw new Error('Invalid fee precision')
  let amount = BigInt(whole + fraction)
  if (scale >= 0) amount *= 10n ** BigInt(scale)
  else {
    const divisor = 10n ** BigInt(-scale)
    if (amount % divisor !== 0n) throw new Error('Fractional millisatoshi fee')
    amount /= divisor
  }
  return integer(Number(amount), 0, 100_000_000_000)
}

async function body(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 4096) throw new Error('Request too large')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

// Request IDs belong to Spark. No payment records are written locally.
export class PaymentService {
  constructor({getWallet, network, fundsWaitMs = 20_000, concurrency = 8}) {
    this.getWallet = getWallet
    this.network = network
    this.fundsWaitMs = fundsWaitMs
    this.operations = new OperationQueue(concurrency)
    // Disposable pagination cursors only; losing these just restarts a lookup.
    this.historyScans = new Map()
  }

  serial(work, key) {
    return this.operations.run(key, work)
  }

  response(checkingId, result, paymentHash = null) {
    return {
      checking_id: checkingId,
      payment_hash: paymentHash || lightningSendPaymentHash(result),
      status: result?.status || 'UNKNOWN',
      fee_msat: result?.fee ? msats(result.fee) : null,
      preimage: result?.paymentPreimage || null
    }
  }

  async lightning(checkingId, data, signal) {
    if (!data) {
      try {
        const wallet = await this.getWallet()
        const isHash = /^[0-9a-f]{64}$/i.test(checkingId)
        const result = isHash
          ? await this.findPayment(wallet, checkingId.toLowerCase())
          : await wallet.getLightningSendRequest(checkingId)
        if (result && !isHash && result.id !== checkingId)
          throw new Error('Spark request ID mismatch')
        return this.response(checkingId, result, isHash ? checkingId : null)
      } catch {
        // Missing records and lookup outages cannot prove payment failure.
        return this.response(checkingId)
      }
    }
    if (!/^[0-9a-f]{64}$/.test(checkingId))
      throw new Error('Invalid payment hash')
    if (typeof data.bolt11 !== 'string' || data.bolt11.length > 4096)
      throw new Error('Invalid invoice')
    integer(data.max_fee_sats)
    if (data.amount_sats !== undefined) integer(data.amount_sats, 1)
    if (decodePayment(data.bolt11).hash !== checkingId)
      throw new Error('Invoice payment hash mismatch')
    let wallet
    const params = {
      invoice: data.bolt11,
      maxFeeSats: data.max_fee_sats,
      amountSatsToSend: data.amount_sats,
      preferSpark: false,
      // SDK 0.9.0 forwards this to initiate_preimage_swap_v3. Spark stores
      // the deduplicated response, scoped to the authenticated wallet identity.
      // Never vary this key with invoice case, fee allowance, or process lifetime.
      idempotencyKey: createHash('sha256')
        .update(`spark-sidecar:lightning:${this.network}:${checkingId}`)
        .digest('hex')
    }
    try {
      wallet = await this.getWallet()
      // Recover an existing successful/active request before checking liquidity;
      // a previously paid invoice may have consumed the remaining wallet balance.
      const existing = await this.findPayment(wallet, checkingId)
      if (existing) return this.response(existing.id, existing, checkingId)
      // Older attempts did not carry our stable key. If history contains an
      // unresolved match, do not interpret it as permission to start a new one.
      if (this.historyScans.get(checkingId)?.hasMatch)
        return this.response(checkingId, null, checkingId)
    } catch {
      // This read is advisory. Submission still uses Spark's idempotency key.
    }
    try {
      signal?.throwIfAborted()
      if (!wallet) throw new PaymentPreparationError('WALLET_UNAVAILABLE')
      await prepareLightningPayment(wallet, params, this.network, {
        waitMs: this.fundsWaitMs,
        signal
      })
      signal?.throwIfAborted()
    } catch (error) {
      const failure =
        error instanceof PaymentPreparationError
          ? error
          : new PaymentPreparationError(
              error instanceof FundsUnavailableError
                ? 'FUNDS_UNAVAILABLE'
                : signal?.aborted
                  ? 'REQUEST_CANCELLED'
                  : 'WALLET_UNAVAILABLE'
            )
      console.warn(
        `Lightning payment rejected before dispatch: ${failure.code}: ${failure.message}`
      )
      return {
        ...this.response(checkingId),
        payment_hash: checkingId,
        status: 'LIGHTNING_PAYMENT_FAILED',
        fee_msat: 0,
        failure_code: failure.code,
        error_message: failure.message
      }
    }
    try {
      const result = await sendLightningPayment(wallet, params)
      if (result?.not_sent)
        return {
          ...this.response(checkingId, result, checkingId),
          error_message: 'Spark rejected the payment before dispatch'
        }
      if (!result?.id) return this.response(checkingId)
      if (lightningSendPaymentHash(result) !== checkingId)
        throw new Error('Spark payment hash mismatch')
      return this.response(result.id, result, checkingId)
    } catch {
      // Never repeat a send after an uncertain result. LNbits can reconcile
      // this hash through Spark history even after this process is replaced.
      return this.lightning(checkingId)
    }
  }

  async findPayment(wallet, paymentHash) {
    let scan = this.historyScans.get(paymentHash)
    if (scan?.complete && Date.now() < scan.retryAt) return null
    if (!scan || scan.complete) scan = {}
    this.historyScans.delete(paymentHash)
    this.historyScans.set(paymentHash, scan)
    if (this.historyScans.size > 1024)
      this.historyScans.delete(this.historyScans.keys().next().value)
    try {
      const result = await findLightningPayment(wallet, paymentHash, scan, 2)
      if (scan.complete) scan.retryAt = Date.now() + 1000
      // Do not cache a completed scan's result as authoritative payment state.
      if (result) this.historyScans.delete(paymentHash)
      return result
    } catch (error) {
      this.historyScans.delete(paymentHash)
      throw error
    }
  }
}

export async function createPaymentHandler({
  getWallet,
  network,
  apiKey,
  waitMs = 0,
  pollMs = 500,
  fundsWaitMs = 20_000,
  concurrency = 8
}) {
  const service = new PaymentService({
    getWallet,
    network,
    fundsWaitMs,
    concurrency
  })
  const reply = (res, status, value) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(value))
  }
  const handler = async (req, res, url) => {
    const route = url.pathname.match(/^\/v1\/payments(?:\/(.+))?$/)
    if (!route) return false
    const supplied = req.headers['x-api-key']
    if (
      apiKey &&
      (typeof supplied !== 'string' ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(apiKey) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(apiKey)))
    ) {
      reply(res, 401, {error: 'Unauthorized'})
      return true
    }
    const abort = new AbortController()
    const disconnected = () => {
      if (!res.writableEnded) abort.abort()
    }
    res.once?.('close', disconnected)
    try {
      let result
      if (req.method === 'POST' && !route[1]) {
        const data = await body(req)
        const decodedHash = decodePayment(data.bolt11).hash
        if (
          data.payment_hash &&
          data.payment_hash.toLowerCase() !== decodedHash
        )
          throw new Error('Invoice payment hash mismatch')
        result = await service.serial(
          () => service.lightning(decodedHash, data, abort.signal),
          decodedHash
        )
        const deadline = Date.now() + Math.max(0, waitMs)
        while (
          !terminalPaymentStatuses.has(result.status) &&
          Date.now() < deadline &&
          !service.closing &&
          !abort.signal.aborted
        ) {
          await new Promise(resolve =>
            setTimeout(
              resolve,
              Math.min(Math.max(1, pollMs), deadline - Date.now())
            )
          )
          result = await service.serial(
            () => service.lightning(result.checking_id),
            result.checking_id
          )
        }
      } else if (req.method === 'GET' && route[1]) {
        const id = decodeURIComponent(route[1])
        if (!id || id.length > 512 || /[\x00-\x20]/.test(id))
          throw new Error('Invalid checking ID')
        result = await service.serial(() => service.lightning(id), id)
      } else {
        reply(res, 404, {error: 'Not found'})
        return true
      }
      reply(res, 200, result)
    } catch {
      reply(res, 409, {
        error: 'Operation unavailable; check its status before retrying'
      })
    } finally {
      res.removeListener?.('close', disconnected)
    }
    return true
  }
  handler.close = async () => {
    service.closing = true
    await service.operations.close()
  }
  return handler
}
