import {OperationQueue} from './operation-queue.mjs'
import {refreshBalance} from './lightning.mjs'

export const receiveSuccessStatuses = new Set([
  'LIGHTNING_PAYMENT_RECEIVED',
  'TRANSFER_COMPLETED',
  'PAYMENT_PREIMAGE_RECOVERED'
])

const isIdentityKey = key =>
  typeof key === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(key)

// A wallet-wide balance cannot prove that a particular invoice has cleared.
// Check its exact transfer, including Spark evidence that its leaves were spent.
export async function receivedFundsAvailable(wallet, request) {
  const id = request.transfer?.sparkId
  if (!id) return false
  const transfer = await wallet.getTransfer(id)
  if (
    transfer?.id !== id ||
    transfer.transferDirection !== 'INCOMING' ||
    transfer.status !== 'TRANSFER_STATUS_COMPLETED' ||
    !transfer.leaves?.length
  )
    return false
  // Synchronize the SDK's spendable cache before exposing receipt to LNbits.
  await refreshBalance(wallet)
  return transfer.leaves.every(({leaf}) => {
    if (!leaf?.id) return false
    const localStatus = wallet.leafManager?.leaves?.get(leaf.id)?.status
    if (leaf.status === 'AVAILABLE' && localStatus === 'AVAILABLE') return true
    // These local spending states are reached only after the leaf was available.
    // A later spend/swap can already have locked the operator's copy again.
    if (['LOCAL_LOCKED', 'OUTGOING', 'SWAP_PENDING'].includes(localStatus))
      return true
    if (['SPLITTED', 'AGGREGATED'].includes(leaf.status)) return true
    // getTransfer returns current leaf ownership, not a receipt-time snapshot.
    // SDK optimization sends the original leaves away and removes their cache
    // entries. A COMPLETED incoming transfer followed by a different owner
    // proves that this receipt cleared before the leaf was subsequently spent.
    // Restrict this inference to single-receiver transfers; other receiver legs
    // do not establish this wallet's ownership history.
    // Pinned SDK 0.9.0 maps protobuf receivers to WalletTransfer.receivers;
    // undefined means the protobuf list was empty (legacy transfer).
    return (
      (transfer.receivers?.length || 0) <= 1 &&
      isIdentityKey(transfer.receiverIdentityPublicKey) &&
      isIdentityKey(leaf.ownerIdentityPublicKey) &&
      leaf.ownerIdentityPublicKey.toLowerCase() !==
        transfer.receiverIdentityPublicKey.toLowerCase()
    )
  })
}

export class IncomingInvoices {
  constructor({getWallet, emit, concurrency = 8, maxEntries = 10_000}) {
    this.getWallet = getWallet
    this.emit = emit
    this.operations = new OperationQueue(concurrency)
    // Disposable stream bookkeeping, never a source of payment status.
    this.pending = new Set()
    this.notified = new Set()
    this.maxEntries = maxEntries
  }

  remember(set, id) {
    set.add(id)
    if (set.size > this.maxEntries) set.delete(set.values().next().value)
  }

  async observe(request, {notify = true} = {}) {
    if (!request?.id) throw new Error('Missing invoice ID')
    const id = request.id
    return this.operations.run(id, async () => {
      const wallet = await this.getWallet()
      if (!request.status) request = await wallet.getLightningReceiveRequest(id)
      if (!request) return null
      if (request.id !== id) throw new Error('Invoice ID mismatch')
      if (!receiveSuccessStatuses.has(request.status)) return request
      let available = false
      try {
        available = await receivedFundsAvailable(wallet, request)
      } catch {
        /* An unavailable lookup must never expose funds as cleared. */
      }
      if (notify && !this.notified.has(id)) {
        if (
          available &&
          this.emit({
            checking_id: id,
            payment_hash: request.invoice?.paymentHash || null,
            status: request.status
          })
        ) {
          this.remember(this.notified, id)
          this.pending.delete(id)
        } else this.remember(this.pending, id)
      }
      return {
        ...request,
        status: available ? request.status : 'WAITING_FOR_FUNDS',
        paymentPreimage: available ? request.paymentPreimage : null
      }
    })
  }

  async retryPending(limit = 100) {
    const ids = [...this.pending].slice(0, limit)
    for (const id of ids) {
      this.pending.delete(id)
      this.pending.add(id)
    }
    await Promise.all(
      ids.map(id =>
        this.observe({id}).catch(() => {
          console.error('Error retrying incoming invoice')
        })
      )
    )
  }

  close() {
    return this.operations.close()
  }
}
