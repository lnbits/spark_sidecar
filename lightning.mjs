import {SparkValidationError} from '@buildonspark/spark-sdk'
import {decode} from 'light-bolt11-decoder'

export const terminalPaymentStatuses = new Set([
  'LIGHTNING_PAYMENT_SUCCEEDED',
  'TRANSFER_COMPLETED',
  'PREIMAGE_PROVIDED',
  'LIGHTNING_PAYMENT_FAILED',
  'TRANSFER_FAILED',
  'PREIMAGE_PROVIDING_FAILED',
  'USER_TRANSFER_VALIDATION_FAILED',
  'USER_SWAP_RETURN_FAILED'
])

// These validations occur before payment dispatch in SDK 0.9.0. Do not
// classify all SparkValidationErrors as failed: some occur after sending.
function rejectedBeforeSend(error) {
  if (!(error instanceof SparkValidationError)) return false
  const message = error.initialMessage || ''
  return (
    message.startsWith('Invoice network:') ||
    message.startsWith('Invalid amount.') ||
    message === 'Invalid amount' ||
    message === 'maxFeeSats does not cover fee estimate'
  )
}

export function decodePayment(invoice) {
  const sections = decode(invoice).sections
  return {
    hash: sections.find(section => section.name === 'payment_hash')?.value,
    amountMsat: sections.find(section => section.name === 'amount')?.value,
    network: sections.find(section => section.name === 'coin_network')?.letters
  }
}

export class FundsUnavailableError extends Error {
  constructor(recoverable) {
    super('Waiting for spendable Spark funds')
    this.recoverable = recoverable
  }
}

const balanceRefreshes = new WeakMap()

export async function refreshBalance(wallet) {
  let pending = balanceRefreshes.get(wallet)
  if (!pending) {
    pending = Promise.resolve().then(() => wallet.getBalance())
    balanceRefreshes.set(wallet, pending)
    const clear = () => balanceRefreshes.delete(wallet)
    void pending.then(clear, clear)
  }
  return pending
}

export async function requireAvailableFunds(wallet, amountSats) {
  const fresh = await refreshBalance(wallet)
  // The fresh coordinator balance can include locally locked leaves. The
  // cache accounts for outgoing transfers and optimization locks as well.
  const local =
    typeof wallet.getCachedBalance === 'function'
      ? await wallet.getCachedBalance()
      : fresh
  const available = BigInt(local.satsBalance?.available ?? local.balance)
  const required = BigInt(amountSats)
  if (available >= required) return
  const owned = BigInt(local.satsBalance?.owned ?? available)
  const incoming = BigInt(local.satsBalance?.incoming ?? 0)
  throw new FundsUnavailableError(owned + incoming >= required)
}

export async function prepareLightningPayment(wallet, params, network) {
  // Any failure here is safe to report as failed: payLightningInvoice has
  // not been called. This includes unavailable quotes.
  const invoice = decodePayment(params.invoice)
  const expectedNetwork = {
    MAINNET: 'bc',
    TESTNET: 'tb',
    SIGNET: 'sb',
    REGTEST: 'bcrt',
    LOCAL: 'bcrt'
  }[network]
  if (expectedNetwork && invoice.network !== expectedNetwork)
    throw new Error('Invoice network does not match wallet network')
  const amount = invoice.amountMsat
    ? Math.ceil(Number(invoice.amountMsat) / 1000)
    : params.amountSatsToSend
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error('Invalid Lightning amount')
  if (invoice.amountMsat && params.amountSatsToSend !== undefined)
    throw new Error('Only amountless invoices accept amount_sats')
  const fee = await wallet.getLightningSendFeeEstimate({
    encodedInvoice: params.invoice,
    amountSats: params.amountSatsToSend
  })
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > params.maxFeeSats)
    throw new Error('Lightning fee exceeds the limit')
  await requireAvailableFunds(wallet, amount + fee)
}

export async function sendLightningPayment(wallet, params) {
  try {
    return await wallet.payLightningInvoice(params)
  } catch (error) {
    if (rejectedBeforeSend(error))
      return {status: 'LIGHTNING_PAYMENT_FAILED', fee: null, not_sent: true}
    throw error
  }
}

export async function findLightningPayment(
  wallet,
  paymentHash,
  scan = {},
  maxPages = Infinity
) {
  let {after, match} = scan
  const cursors = (scan.cursors ||= new Set())
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await wallet.getUserRequests({
      first: 100,
      after,
      types: ['LIGHTNING_SEND']
    })
    for (const request of page.entities || []) {
      if (
        request.typename === 'LightningSendRequest' &&
        request.invoice?.paymentHash?.toLowerCase() === paymentHash
      ) {
        if (match && match.id !== request.id) {
          scan.complete = true
          return null
        }
        match = request
      }
    }
    if (!page.pageInfo?.hasNextPage) {
      scan.complete = true
      // A hash identifies an invoice, not a particular attempt. Without the
      // dispatch's request ID, an old failed/pending attempt cannot prove the
      // outcome of a newer send. Only successful settlement of this invoice
      // is safe to recover from history; otherwise keep the send uncertain.
      return match &&
        [
          'LIGHTNING_PAYMENT_SUCCEEDED',
          'TRANSFER_COMPLETED',
          'PREIMAGE_PROVIDED'
        ].includes(match.status)
        ? match
        : null
    }
    after = page.pageInfo.endCursor
    if (!after || cursors.has(after))
      throw new Error('Invalid Spark pagination')
    cursors.add(after)
    Object.assign(scan, {after, match})
  }
  return null
}
