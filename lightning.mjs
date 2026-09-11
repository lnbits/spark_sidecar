import {SparkValidationError} from '@buildonspark/spark-sdk'
import {decode} from 'light-bolt11-decoder'
import {setTimeout as delay} from 'node:timers/promises'

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

const preparationErrors = {
  INVALID_INVOICE: 'Invalid Lightning invoice',
  NETWORK_MISMATCH: 'Invoice network does not match wallet network',
  INVALID_AMOUNT: 'Invalid Lightning amount',
  AMOUNT_OVERRIDE: 'Only amountless invoices accept amount_sats',
  FEE_QUOTE_UNAVAILABLE: 'Spark Lightning fee quote unavailable',
  INVALID_FEE_QUOTE: 'Spark returned an invalid Lightning fee quote',
  FEE_LIMIT_EXCEEDED: 'Lightning fee exceeds the limit',
  BALANCE_UNAVAILABLE: 'Spark spendable balance check unavailable',
  FUNDS_UNAVAILABLE: 'Insufficient spendable Spark funds',
  REQUEST_CANCELLED: 'Payment request disconnected before dispatch',
  WALLET_UNAVAILABLE: 'Spark wallet unavailable before payment dispatch'
}

export class PaymentPreparationError extends Error {
  constructor(code) {
    super(preparationErrors[code])
    this.code = code
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

export async function prepareLightningPayment(
  wallet,
  params,
  network,
  {waitMs = 0, signal} = {}
) {
  // Any failure here is safe to report as failed: payLightningInvoice has
  // not been called. This includes unavailable quotes.
  let invoice
  try {
    invoice = decodePayment(params.invoice)
  } catch {
    throw new PaymentPreparationError('INVALID_INVOICE')
  }
  const expectedNetwork = {
    MAINNET: 'bc',
    TESTNET: 'tb',
    SIGNET: 'sb',
    REGTEST: 'bcrt',
    LOCAL: 'bcrt'
  }[network]
  if (expectedNetwork && invoice.network !== expectedNetwork)
    throw new PaymentPreparationError('NETWORK_MISMATCH')
  const amount = invoice.amountMsat
    ? Math.ceil(Number(invoice.amountMsat) / 1000)
    : params.amountSatsToSend
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new PaymentPreparationError('INVALID_AMOUNT')
  if (invoice.amountMsat && params.amountSatsToSend !== undefined)
    throw new PaymentPreparationError('AMOUNT_OVERRIDE')
  let fee
  try {
    fee = await wallet.getLightningSendFeeEstimate({
      // SDK 0.9.0 payLightningInvoice normalizes before requesting its quote.
      // The standalone quote method does not; preserve that behavior here too.
      encodedInvoice: params.invoice.toLowerCase(),
      amountSats: params.amountSatsToSend
    })
  } catch {
    throw new PaymentPreparationError('FEE_QUOTE_UNAVAILABLE')
  }
  if (!Number.isSafeInteger(fee) || fee < 0)
    throw new PaymentPreparationError('INVALID_FEE_QUOTE')
  if (fee > params.maxFeeSats) {
    const error = new PaymentPreparationError('FEE_LIMIT_EXCEEDED')
    error.message = `Spark fee quote (${fee} sats) exceeds the payment fee limit (${params.maxFeeSats} sats)`
    throw error
  }
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    signal?.throwIfAborted()
    try {
      await requireAvailableFunds(wallet, amount + fee)
      return
    } catch (error) {
      if (!(error instanceof FundsUnavailableError))
        throw new PaymentPreparationError('BALANCE_UNAVAILABLE')
      if (Date.now() >= deadline) throw error
      await delay(Math.min(250, deadline - Date.now()), undefined, {signal})
    }
  }
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
    if (
      !Array.isArray(page?.entities) ||
      typeof page?.pageInfo?.hasNextPage !== 'boolean'
    )
      throw new Error('Invalid Spark history response')
    for (const request of page.entities || []) {
      if (
        request.typename === 'LightningSendRequest' &&
        typeof request.id === 'string' &&
        request.id.length > 0 &&
        request.invoice?.paymentHash?.toLowerCase() === paymentHash
      ) {
        scan.hasMatch = true
        if (match && match.id !== request.id) {
          scan.complete = true
          return null
        }
        match = request
      }
    }
    if (!page.pageInfo?.hasNextPage) {
      scan.complete = true
      // A hash identifies an invoice, not an attempt. An old failure must not
      // fail a newer uncertain attempt. Pending requests may still be checked;
      // only explicit success can settle the invoice through a legacy hash.
      return match &&
        typeof match.status === 'string' &&
        (!terminalPaymentStatuses.has(match.status) ||
          [
            'LIGHTNING_PAYMENT_SUCCEEDED',
            'TRANSFER_COMPLETED',
            'PREIMAGE_PROVIDED'
          ].includes(match.status))
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
