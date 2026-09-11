import {OperationQueue} from './operation-queue.mjs'
import {PaymentJournal} from './payment-journal.mjs'
import {createHash, timingSafeEqual} from 'node:crypto'
import {
  prepareLightningPayment,
  sendLightningPayment,
  findLightningPayment,
  terminalPaymentStatuses,
  decodePayment,
  FundsUnavailableError,
  PaymentPreparationError
} from './lightning.mjs'

const hash = value =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

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

export class PaymentService {
  constructor({
    journal,
    getWallet,
    network,
    fundsWaitMs = 20_000,
    concurrency = 8
  }) {
    this.journal = journal
    this.getWallet = getWallet
    this.network = network
    this.fundsWaitMs = fundsWaitMs
    this.operations = new OperationQueue(concurrency)
    this.historyScans = new Map()
  }

  waitingForFunds(error, record) {
    return (
      error instanceof FundsUnavailableError &&
      (error.recoverable || Date.now() < record.funds_deadline)
    )
  }

  serial(work, key = 'global') {
    return this.operations.run(key, work)
  }

  async lightning(hashValue, data) {
    if (!/^[0-9a-f]{64}$/.test(hashValue))
      throw new Error('Invalid payment hash')
    const id = `ln-${hashValue}`
    const queued = await this.journal.get(id)
    if (!data && ['WAITING_FOR_FUNDS', 'PREPARING'].includes(queued?.status)) {
      // Resume only the durable intent authorized by the original POST.
      data = queued.payment
    }
    if (data) {
      if (typeof data.bolt11 !== 'string' || data.bolt11.length > 4096)
        throw new Error('Invalid invoice')
      integer(data.max_fee_sats, 0, 100_000_000)
      const fingerprint = hash({
        bolt11: data.bolt11,
        max_fee_sats: data.max_fee_sats,
        amount_sats: data.amount_sats
      })
      const previous = await this.journal.get(id)
      if (
        previous &&
        !previous.not_sent &&
        previous.request_hash !== fingerprint
      )
        throw new Error('Conflicting Lightning payment')
      if (
        !previous ||
        previous.not_sent ||
        ['WAITING_FOR_FUNDS', 'PREPARING'].includes(previous.status)
      ) {
        const intent = {
          checking_id: hashValue,
          request_hash: fingerprint,
          status: 'PREPARING',
          payment: {
            bolt11: data.bolt11,
            max_fee_sats: data.max_fee_sats,
            amount_sats: data.amount_sats
          },
          funds_deadline:
            previous && !previous.not_sent
              ? (previous.funds_deadline ?? Date.now() + this.fundsWaitMs)
              : Date.now() + this.fundsWaitMs
        }
        await this.journal.put(id, intent)
        const params = {
          invoice: data.bolt11,
          maxFeeSats: data.max_fee_sats,
          amountSatsToSend: data.amount_sats
        }
        let wallet
        try {
          wallet = await this.getWallet()
          await prepareLightningPayment(wallet, params, this.network)
        } catch (error) {
          const waiting = this.waitingForFunds(error, intent)
          intent.status = waiting
            ? 'WAITING_FOR_FUNDS'
            : 'LIGHTNING_PAYMENT_FAILED'
          intent.not_sent = !waiting
          intent.fee_msat = waiting ? null : 0
          if (!waiting) {
            const failure =
              error instanceof PaymentPreparationError
                ? error
                : new PaymentPreparationError(
                    error instanceof FundsUnavailableError
                      ? 'FUNDS_UNAVAILABLE'
                      : 'WALLET_UNAVAILABLE'
                  )
            intent.failure_code = failure.code
            intent.error_message = failure.message
            // Locally constructed reasons only; never log raw SDK exceptions.
            console.warn(
              `Lightning payment rejected before dispatch: ${failure.code}: ${failure.message}`
            )
          }
          await this.journal.put(id, intent)
          return {
            checking_id: hashValue,
            payment_hash: hashValue,
            status: intent.status,
            fee_msat: intent.fee_msat,
            preimage: null,
            ...(intent.failure_code && {
              failure_code: intent.failure_code,
              error_message: intent.error_message
            })
          }
        }
        intent.status = 'UNKNOWN'
        await this.journal.put(id, intent)
        try {
          const result = await sendLightningPayment(wallet, params)
          if (result) this.updatePayment(intent, result)
        } catch {
          // Reconcile uncertain dispatches against history; never resend them.
        }
        await this.journal.put(id, intent)
      }
    }
    // Also reconcile payments sent before this journal was introduced.
    const record = (await this.journal.get(id)) || {
      checking_id: hashValue,
      status: 'UNKNOWN'
    }
    if (!terminalPaymentStatuses.has(record.status)) {
      try {
        const wallet = await this.getWallet()
        const result = record.request_id
          ? await wallet.getLightningSendRequest(record.request_id)
          : await this.findPayment(wallet, hashValue)
        if (result) {
          this.updatePayment(record, result)
          await this.journal.put(id, record)
        }
      } catch {
        // A lookup outage must not hide a durable send result or trigger a resend.
      }
    }
    return {
      checking_id: hashValue,
      payment_hash: hashValue,
      status: record.status,
      fee_msat: record.fee_msat,
      preimage: record.preimage,
      ...(record.failure_code && {
        failure_code: record.failure_code,
        error_message: record.error_message
      })
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
    // Continue long histories across polls instead of monopolizing a worker.
    try {
      const result = await findLightningPayment(wallet, paymentHash, scan, 2)
      if (scan.complete) scan.retryAt = Date.now() + 5000
      return result
    } catch (error) {
      this.historyScans.delete(paymentHash)
      throw error
    }
  }

  updatePayment(record, result) {
    if (result.id) record.request_id = result.id
    record.status = result.status || record.status
    record.preimage = result.paymentPreimage || record.preimage || null
    record.fee_msat = result.fee ? msats(result.fee) : null
    record.not_sent = result.not_sent === true
  }
}

export async function createPaymentHandler({
  getWallet,
  network,
  apiKey,
  directory,
  waitMs = 0,
  pollMs = 500,
  fundsWaitMs = 20_000,
  concurrency = 8
}) {
  const journal = new PaymentJournal(directory)
  await journal.initialize()
  const service = new PaymentService({
    journal,
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
    const lightning = url.pathname.match(
      /^\/v1\/payments(?:\/([0-9a-f]{64}))?$/i
    )
    if (!lightning) return false
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
    try {
      let result
      if (lightning && req.method === 'POST' && !lightning[1]) {
        const data = await body(req)
        const decodedHash = decodePayment(data.bolt11).hash
        if (
          data.payment_hash &&
          data.payment_hash.toLowerCase() !== decodedHash
        )
          throw new Error('Invoice payment hash mismatch')
        result = await service.serial(
          () => service.lightning(decodedHash, data),
          `ln-${decodedHash}`
        )
        const deadline = Date.now() + Math.max(0, waitMs)
        while (
          !terminalPaymentStatuses.has(result.status) &&
          Date.now() < deadline &&
          !service.closing
        ) {
          await new Promise(resolve =>
            setTimeout(
              resolve,
              Math.min(Math.max(1, pollMs), deadline - Date.now())
            )
          )
          result = await service.serial(
            () => service.lightning(decodedHash),
            `ln-${decodedHash}`
          )
        }
      } else if (lightning && req.method === 'GET' && lightning[1]) {
        result = await service.serial(
          () => service.lightning(lightning[1].toLowerCase()),
          `ln-${lightning[1].toLowerCase()}`
        )
      } else {
        reply(res, 404, {error: 'Not found'})
        return true
      }
      reply(res, 200, result)
    } catch {
      reply(res, 409, {
        error:
          'Operation unavailable; reconcile its recorded state before retrying'
      })
    }
    return true
  }
  handler.journal = journal
  handler.close = async () => {
    service.closing = true
    await service.operations.close()
    await journal.close()
  }
  return handler
}
