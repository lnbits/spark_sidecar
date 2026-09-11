import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto'

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
    const directory = await fs.open(this.directory, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}

export class OnchainService {
  constructor({journal, getWallet, network}) {
    this.journal = journal
    this.getWallet = getWallet
    this.network = network
    this.queue = Promise.resolve()
  }

  serial(work) {
    if (this.closing) return Promise.reject(new Error('Sidecar is stopping'))
    const result = this.queue.then(work)
    this.queue = result.catch(() => {})
    return result
  }

  async address(id) {
    const prior = await this.journal.get(id)
    if (prior) return prior
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
    if (!record.claim_hash) {
      record.claim_hash = fingerprint
      record.status = 'claiming'
      await this.journal.put(id, record)
      // LNbits verifies confirmations and the returned root input's txid/vout.
      // A lost claim response is NOT permission to claim a second deposit.
      const leaves = await wallet.claimDeposit(data.txid)
      record.leaves = leaves.map(leaf => ({
        id: leaf.id,
        value: integer(leaf.value, 1),
        node_tx: leaf.nodeTx,
        available: leaf.status === 'AVAILABLE'
      }))
      record.status = 'claimed'
      await this.journal.put(id, record)
    }
    if (record.leaves?.some(leaf => !leaf.available)) {
      const available = new Set(
        (await wallet.getLeaves())
          .filter(leaf => leaf.status === 'AVAILABLE')
          .map(leaf => leaf.id)
      )
      for (const leaf of record.leaves) {
        if (available.has(leaf.id)) leaf.available = true
      }
      await this.journal.put(id, record)
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
      return record
    }
    record = {...normalized, request_hash: fingerprint, status: 'quoting'}
    await this.journal.put(id, record)
    const wallet = await this.getWallet()
    let quote
    try {
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
    } catch {
      record.status = 'rejected'
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
    if (data) {
      if (typeof data.bolt11 !== 'string' || data.bolt11.length > 4096)
        throw new Error('Invalid invoice')
      integer(data.max_fee_sats, 0, 100_000_000)
      const fingerprint = hash({
        bolt11: data.bolt11,
        max_fee_sats: data.max_fee_sats
      })
      const previous = await this.journal.get(id)
      if (previous && previous.request_hash !== fingerprint)
        throw new Error('Conflicting Lightning payment')
      if (!previous) {
        const intent = {
          checking_id: hashValue,
          request_hash: fingerprint,
          status: 'UNKNOWN'
        }
        await this.journal.put(id, intent)
        try {
          const result = await (
            await this.getWallet()
          ).payLightningInvoice({
            invoice: data.bolt11,
            maxFeeSats: data.max_fee_sats
          })
          if (result?.id) intent.request_id = result.id
        } catch {
          // An SDK rejection can occur after the external side effect. Keep pending.
        }
        await this.journal.put(id, intent)
      }
    }
    const record = await this.journal.get(id)
    if (!record?.request_id) return {checking_id: hashValue, status: 'UNKNOWN'}
    const result = await (
      await this.getWallet()
    ).getLightningSendRequest(record.request_id)
    if (result) {
      record.status = result.status
      record.fee_msat = result.fee ? msats(result.fee) : null
      record.preimage = result.paymentPreimage || null
      await this.journal.put(id, record)
    }
    return {
      checking_id: hashValue,
      status: record.status,
      fee_msat: record.fee_msat,
      preimage: record.preimage
    }
  }

  async withdrawal(id) {
    const record = await this.journal.get(id)
    if (!record) return {status: 'unknown'}
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
  directory
}) {
  if (!apiKey || apiKey.length < 32)
    throw new Error('Onchain API requires a key of at least 32 characters')
  const journal = new OnchainJournal(directory)
  await journal.initialize()
  const service = new OnchainService({journal, getWallet, network})
  const reply = (res, status, value) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(value))
  }
  const handler = async (req, res, url) => {
    const lightning = url.pathname.match(
      /^\/v1\/payments(?:\/([0-9a-f]{64}))?$/
    )
    if (!url.pathname.startsWith('/v1/onchain/') && !lightning) return false
    const supplied = req.headers['x-api-key']
    if (
      typeof supplied !== 'string' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(apiKey) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(apiKey))
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
        result = await service.serial(() =>
          service.lightning(data.payment_hash, data)
        )
      } else if (lightning && req.method === 'GET' && lightning[1]) {
        result = await service.serial(() => service.lightning(lightning[1]))
      } else if (req.method === 'GET' && url.pathname === '/v1/onchain/info') {
        result = {version: 1, network, required_confirmations: 3}
      } else if (deposit && req.method === 'PUT' && !deposit[2]) {
        result = await service.serial(() => service.address(deposit[1]))
      } else if (deposit && req.method === 'POST' && deposit[2]) {
        const data = await body(req)
        result = await service.serial(() => service.claim(deposit[1], data))
      } else if (withdrawal && req.method === 'PUT') {
        const data = await body(req)
        result = await service.serial(() =>
          service.withdraw(withdrawal[1], data)
        )
      } else if (withdrawal && req.method === 'GET') {
        result = await service.serial(() => service.withdrawal(withdrawal[1]))
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
  handler.close = async () => {
    service.closing = true
    await service.queue
    await journal.close()
  }
  return handler
}
