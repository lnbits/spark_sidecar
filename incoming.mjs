import {createHash} from 'node:crypto'
import {mkdir, opendir} from 'node:fs/promises'
import path from 'node:path'
import {OperationQueue} from './operation-queue.mjs'
import {refreshBalance} from './lightning.mjs'

export const receiveSuccessStatuses = new Set([
  'LIGHTNING_PAYMENT_RECEIVED',
  'TRANSFER_COMPLETED',
  'PAYMENT_PREIMAGE_RECOVERED'
])

const receiptId = id =>
  `receive-${createHash('sha256').update(id).digest('hex')}`

const isIdentityKey = key =>
  typeof key === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(key)

// A wallet-wide balance cannot prove that a particular invoice has cleared.
// Check its exact transfer, and retain the proof after its leaves are spent.
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
  constructor({journal, getWallet, emit, concurrency = 8}) {
    this.journal = journal
    this.getWallet = getWallet
    this.emit = emit
    this.operations = new OperationQueue(concurrency)
    this.pending = new Set()
  }

  async initialize() {
    const pendingDirectory = path.join(
      this.journal.directory,
      'incoming-pending'
    )
    await mkdir(pendingDirectory, {recursive: true, mode: 0o700})
    // Sync the parent entry too; future pending files must survive power loss.
    await this.journal.put('incoming-index', {version: 1})
    for await (const entry of await opendir(pendingDirectory)) {
      if (!/^receive-[0-9a-f]{64}\.json$/.test(entry.name)) continue
      const record = await this.journal.get(
        `incoming-pending/${entry.name.slice(0, -5)}`
      )
      if (record) this.pending.add(record.id)
    }
  }

  async observe(request) {
    if (!request?.id) throw new Error('Missing invoice ID')
    return this.operations.run(request.id, async () => {
      const key = receiptId(request.id)
      let record = await this.journal.get(key)
      if (!request.status) {
        request = record?.request || request
        if (!request.transfer?.sparkId && !record?.available)
          request =
            (await (
              await this.getWallet()
            ).getLightningReceiveRequest(request.id)) || record?.request
        if (!request) return null
        if (receiptId(request.id) !== key)
          throw new Error('Invoice ID mismatch')
      }
      if (!record && !receiveSuccessStatuses.has(request.status)) return request
      if (!record) {
        // Index first: a crash before the receipt write can recover by ID.
        await this.journal.put(`incoming-pending/${key}`, {id: request.id})
        this.pending.add(request.id)
        record = {request, available: false, notified: false}
        await this.journal.put(key, record)
      }
      if (!record.notified) this.pending.add(request.id)
      if (!record.available) {
        if (receiveSuccessStatuses.has(request.status)) record.request = request
        try {
          record.available = await receivedFundsAvailable(
            await this.getWallet(),
            record.request
          )
        } catch {
          // Unavailable coordinator/SSP data is pending, never early credit.
        }
        await this.journal.put(key, record)
      }
      if (
        record.available &&
        !record.notified &&
        this.emit({
          checking_id: record.request.id,
          payment_hash: record.request.invoice?.paymentHash || null,
          status: record.request.status
        })
      ) {
        record.notified = true
        await this.journal.put(key, record)
      }
      if (record.notified && this.pending.has(request.id)) {
        // Notification state is durable before removing its pending index.
        await this.journal.remove(`incoming-pending/${key}`)
        this.pending.delete(request.id)
      }
      return {
        ...record.request,
        status: record.available ? record.request.status : 'WAITING_FOR_FUNDS',
        paymentPreimage: record.available
          ? record.request.paymentPreimage
          : null
      }
    })
  }

  async retryPending(limit = 100) {
    const ids = [...this.pending].slice(0, limit)
    // Rotate delayed receipts so they cannot starve later ones.
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
