import fs from 'node:fs/promises'
import {OperationQueue} from './operation-queue.mjs'
import path from 'node:path'
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto'
import {sparkDeposits, depositReceipt} from './spark-deposits.mjs'
import {
  prepareLightningPayment,
  sendLightningPayment,
  findLightningPayment,
  terminalPaymentStatuses,
  decodePayment,
  FundsUnavailableError,
  requireAvailableFunds
} from './lightning.mjs'

const UUID =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const depositRoute = new RegExp(`^/v1/onchain/deposits/(${UUID})(/claim)?$`)
const withdrawalRoute = new RegExp(
  `^/v1/onchain/withdrawals/(${UUID}-(?:payout|refund))$`
)
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

function sats(value) {
  const amount = msats(value)
  if (amount % 1000 !== 0) throw new Error('Fractional satoshi withdrawal fee')
  return amount / 1000
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

// This journal is financial state, independent of the sidecar's SSE watermark.
// Every intent is fsync'ed before a Spark call, and every result before response.
export class OnchainJournal {
  constructor(directory) {
    this.directory = directory
  }

  async initialize() {
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700})
    const lockPath = path.join(this.directory, 'writer.lock')
    this.lock = await fs.open(lockPath, 'wx', 0o600)
    await this.lock.writeFile(String(process.pid))
    await this.lock.sync()
  }

  async close() {
    await this.lock?.close()
    await fs.unlink(path.join(this.directory, 'writer.lock'))
  }

  async get(id) {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.directory, `${id}.json`), 'utf8')
      )
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error // Corruption must fail closed; never treat it as a new operation.
    }
  }

  async remove(id) {
    const filename = path.join(this.directory, `${id}.json`)
    try {
      await fs.unlink(filename)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const directory = await fs.open(path.dirname(filename), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  async put(id, value) {
    const temporary = path.join(this.directory, `${id}.${randomUUID()}.tmp`)
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, path.join(this.directory, `${id}.json`))
    const directory = await fs.open(path.dirname(temporary), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}

export class OnchainService {
  constructor({
    journal,
    getWallet,
    network,
    deposits = sparkDeposits,
    fundsWaitMs = 20_000,
    concurrency = 8
  }) {
    this.deposits = deposits
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

  async address(id) {
    const prior = await this.journal.get(id)
    if (prior?.address) return prior
    const record = {status: 'creating', address: null}
    await this.journal.put(id, record)
    record.address = await (await this.getWallet()).getSingleUseDepositAddress()
    record.status = 'waiting'
    await this.journal.put(id, record)
    return record
  }

  async claim(id, data) {
    if (!/^[0-9a-f]{64}$/.test(data.txid)) throw new Error('Invalid txid')
    integer(data.vout, 0, 100_000)
    integer(data.amount_sats, 1)
    const record = await this.journal.get(id)
    if (!record?.address) throw new Error('Unknown deposit')
    const fingerprint = hash({
      txid: data.txid,
      vout: data.vout,
      amount_sats: data.amount_sats
    })
    if (record.claim_hash && record.claim_hash !== fingerprint)
      throw new Error('Deposit already bound to another outpoint')
    const wallet = await this.getWallet()
    if (!record.leaves?.length || record.leaves.some(leaf => !leaf.available)) {
      const recovered = await this.deposits.recover(
        wallet,
        data,
        record.leaves,
        record.address
      )
      if (recovered.length) {
        record.leaves = depositReceipt(recovered, data)
        record.claim_hash = fingerprint
        record.status = 'claimed'
        await this.journal.put(id, record)
      } else if (!record.leaves?.length) {
        // Preparation only reads Spark state. Failures remain retryable.
        record.prepared ||= await this.deposits.prepare(
          wallet,
          record.address,
          data
        )
        record.claim_hash = fingerprint
        record.status = 'claiming'
        await this.journal.put(id, record)
        // Every attempt uses the same validated raw transaction and vout.
        // It can never advance to another swap's output after a lost response.
        const leaves = await this.deposits.claim(wallet, record.prepared)
        record.leaves = depositReceipt(leaves, data)
        record.status = 'claimed'
        await this.journal.put(id, record)
      }
    }
    return {
      available: Boolean(
        record.leaves?.length && record.leaves.every(leaf => leaf.available)
      ),
      leaves: record.leaves || []
    }
  }

  async withdraw(id, data) {
    const normalized = {
      address: data.address,
      amount_sats: integer(data.amount_sats, 1),
      max_fee_sats: integer(data.max_fee_sats, 0, 100_000)
    }
    if (
      typeof data.address !== 'string' ||
      data.address.length < 14 ||
      data.address.length > 100
    )
      throw new Error('Invalid address')
    const fingerprint = hash(normalized)
    let record = await this.journal.get(id)
    if (record) {
      if (record.request_hash !== fingerprint)
        throw new Error('Conflicting withdrawal request')
      if (!['WAITING_FOR_FUNDS', 'quoting'].includes(record.status))
        return record
    }
    record = {
      ...record,
      ...normalized,
      request_hash: fingerprint,
      status: 'quoting',
      funds_deadline: record?.funds_deadline ?? Date.now() + this.fundsWaitMs
    }
    await this.journal.put(id, record)
    let wallet, quote
    try {
      wallet = await this.getWallet()
      await requireAvailableFunds(wallet, data.amount_sats)
      quote = await wallet.getWithdrawalFeeQuote({
        amountSats: data.amount_sats,
        withdrawalAddress: data.address
      })
      const fee = sats(quote?.userFeeMedium) + sats(quote?.l1BroadcastFeeMedium)
      if (
        fee > data.max_fee_sats ||
        !(Date.parse(quote.expiresAt) > Date.now())
      )
        throw new Error('Fee quote rejected')
      record.fee_sats = fee
      await requireAvailableFunds(wallet, data.amount_sats + fee)
    } catch (error) {
      record.status = this.waitingForFunds(error, record)
        ? 'WAITING_FOR_FUNDS'
        : 'rejected'
      await this.journal.put(id, record)
      return record
    }
    record.status = 'submitting'
    await this.journal.put(id, record)
    try {
      const result = await wallet.withdraw({
        onchainAddress: data.address,
        amountSats: data.amount_sats,
        exitSpeed: 'MEDIUM',
        // Pass the normalized satoshi amount. Older SDKs recompute from
        // originalValue if feeQuote is supplied, ignoring its currency unit.
        feeQuoteId: quote.id,
        feeAmountSats: record.fee_sats,
        deductFeeFromWithdrawalAmount: false
      })
      if (!result?.id) throw new Error('Missing withdrawal ID')
      record.request_id = result.id
      record.status = result.status
      record.txid = result.coopExitTxid || ''
      record.fee_sats = sats(result.fee) + sats(result.l1BroadcastFee)
    } catch {
      record.status = 'unknown'
    }
    await this.journal.put(id, record)
    return record
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
          await this.journal.put(id, intent)
          return {
            checking_id: hashValue,
            payment_hash: hashValue,
            status: intent.status,
            fee_msat: intent.fee_msat,
            preimage: null
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
      preimage: record.preimage
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

  async withdrawal(id) {
    const record = await this.journal.get(id)
    if (!record) return {status: 'unknown'}
    if (['WAITING_FOR_FUNDS', 'quoting'].includes(record.status))
      return this.withdraw(id, record)
    if (!record.request_id) return record
    const result = await (
      await this.getWallet()
    ).getCoopExitRequest(record.request_id)
    if (result) {
      record.status = result.status
      record.txid = result.coopExitTxid || ''
      record.fee_sats = sats(result.fee) + sats(result.l1BroadcastFee)
      await this.journal.put(id, record)
    }
    return record
  }
}

export async function createOnchainHandler({
  getWallet,
  network,
  apiKey,
  directory,
  onchainEnabled = true,
  waitMs = 0,
  pollMs = 500,
  fundsWaitMs = 20_000,
  concurrency = 8
}) {
  if (onchainEnabled && (!apiKey || apiKey.length < 32))
    throw new Error('Onchain API requires a key of at least 32 characters')
  const journal = new OnchainJournal(directory)
  await journal.initialize()
  const service = new OnchainService({
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
    if (
      (!onchainEnabled || !url.pathname.startsWith('/v1/onchain/')) &&
      !lightning
    )
      return false
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
      const deposit = url.pathname.match(depositRoute)
      const withdrawal = url.pathname.match(withdrawalRoute)
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
      } else if (req.method === 'GET' && url.pathname === '/v1/onchain/info') {
        result = {version: 1, network, required_confirmations: 3}
      } else if (deposit && req.method === 'PUT' && !deposit[2]) {
        result = await service.serial(
          () => service.address(deposit[1]),
          deposit[1]
        )
      } else if (deposit && req.method === 'POST' && deposit[2]) {
        const data = await body(req)
        result = await service.serial(
          () => service.claim(deposit[1], data),
          deposit[1]
        )
      } else if (withdrawal && req.method === 'PUT') {
        const data = await body(req)
        result = await service.serial(
          () => service.withdraw(withdrawal[1], data),
          withdrawal[1]
        )
      } else if (withdrawal && req.method === 'GET') {
        result = await service.serial(
          () => service.withdrawal(withdrawal[1]),
          withdrawal[1]
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
