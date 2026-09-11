import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm} from 'node:fs/promises'
import {IncomingInvoices, receivedFundsAvailable} from './incoming.mjs'
import {PaymentJournal} from './payment-journal.mjs'
import {OperationQueue} from './operation-queue.mjs'
import {refreshBalance} from './lightning.mjs'
import {SparkWallet} from '@buildonspark/spark-sdk'
import {SparkProto} from '@buildonspark/spark-sdk/types'

const invoice = {
  id: 'invoice',
  typename: 'LightningReceiveRequest',
  status: 'LIGHTNING_PAYMENT_RECEIVED',
  invoice: {paymentHash: 'a'.repeat(64)},
  transfer: {sparkId: 'transfer'},
  paymentPreimage: 'preimage'
}
function mockWallet(status = 'AVAILABLE', localStatus = status) {
  const transfer = {
    id: 'transfer',
    receiverIdentityPublicKey: `02${'1'.repeat(64)}`,
    transferDirection: 'INCOMING',
    status: 'TRANSFER_STATUS_COMPLETED',
    leaves: [{leaf: {id: 'leaf', status}}]
  }
  return {
    transfer,
    leafManager: {leaves: new Map([['leaf', {status: localStatus}]])},
    getTransfer: async id => {
      assert.equal(id, 'transfer')
      return transfer
    },
    getBalance: async () => ({balance: 1000000n}),
    getLightningReceiveRequest: async () => invoice
  }
}
async function setup(t, wallet, emit = () => false, concurrency = 8) {
  const directory = await mkdtemp('/tmp/spark-incoming-test-')
  const journal = new PaymentJournal(directory)
  await journal.initialize()
  const options = {journal, getWallet: async () => wallet, emit, concurrency}
  const incoming = new IncomingInvoices(options)
  await incoming.initialize()
  t.after(async () => {
    await incoming.close()
    await journal.close()
    await rm(directory, {recursive: true})
  })
  return {incoming, options}
}

test('received Lightning stays pending until its own leaves and local cache are available', async t => {
  const wallet = mockWallet('CREATING', 'INCOMING')
  const events = []
  const {incoming} = await setup(t, wallet, event => {
    events.push(event)
    return true
  })
  for (const status of [
    'PAYMENT_PREIMAGE_RECOVERED',
    'LIGHTNING_PAYMENT_RECEIVED',
    'TRANSFER_COMPLETED'
  ]) {
    const result = await incoming.observe({...invoice, status})
    assert.equal(result.status, 'WAITING_FOR_FUNDS')
    assert.equal(result.paymentPreimage, null)
  }
  wallet.transfer.leaves[0].leaf.status = 'AVAILABLE'
  assert.equal((await incoming.observe(invoice)).status, 'WAITING_FOR_FUNDS')
  assert.equal(events.length, 0)
  wallet.leafManager.leaves.get('leaf').status = 'AVAILABLE'
  await incoming.retryPending()
  assert.equal(
    (await incoming.observe(invoice)).status,
    'LIGHTNING_PAYMENT_RECEIVED'
  )
  assert.equal(events.length, 1)
})

test('pending receipts recover after restart and retain credit after leaves are spent', async t => {
  const wallet = mockWallet('CREATING', 'INCOMING')
  let emitted = 0
  const {incoming, options} = await setup(t, wallet, () => {
    emitted++
    return true
  })
  await incoming.observe(invoice)
  await incoming.close()
  const restarted = new IncomingInvoices(options)
  await restarted.initialize()
  assert.equal(restarted.pending.size, 1)
  wallet.transfer.leaves[0].leaf.status = 'AVAILABLE'
  wallet.leafManager.leaves.get('leaf').status = 'AVAILABLE'
  await restarted.retryPending()
  assert.equal(emitted, 1)
  await restarted.close()
  wallet.getTransfer = async () => {
    throw new Error('spent leaves / outage')
  }
  const again = new IncomingInvoices(options)
  await again.initialize()
  assert.equal(again.pending.size, 0)
  assert.equal(
    (await again.observe(invoice)).status,
    'LIGHTNING_PAYMENT_RECEIVED'
  )
  assert.equal(emitted, 1)
  await again.close()
})

test('a crash between indexing and recording a receipt recovers the invoice by ID', async t => {
  let emitted = 0
  const {incoming, options} = await setup(t, mockWallet(), () => {
    emitted++
    return true
  })
  const put = options.journal.put.bind(options.journal)
  options.journal.put = async (key, value) => {
    if (key.startsWith('receive-'))
      throw new Error('simulated receipt write failure')
    return put(key, value)
  }
  await assert.rejects(incoming.observe(invoice), /write failure/)
  assert.equal(emitted, 0)
  options.journal.put = put
  await incoming.close()
  const restarted = new IncomingInvoices(options)
  await restarted.initialize()
  assert.equal(restarted.pending.size, 1)
  await restarted.retryPending()
  assert.equal(emitted, 1)
  assert.equal(restarted.pending.size, 0)
  await restarted.close()
})

test('a crash before pending-index cleanup does not notify a settled receipt again', async t => {
  let emitted = 0
  const {incoming, options} = await setup(t, mockWallet(), () => {
    emitted++
    return true
  })
  const remove = options.journal.remove.bind(options.journal)
  options.journal.remove = async () => {
    throw new Error('simulated index cleanup failure')
  }
  await assert.rejects(incoming.observe(invoice), /cleanup failure/)
  assert.equal(emitted, 1)
  options.journal.remove = remove
  await incoming.close()
  const restarted = new IncomingInvoices(options)
  await restarted.initialize()
  await restarted.retryPending()
  assert.equal(emitted, 1)
  assert.equal(restarted.pending.size, 0)
  await restarted.close()
})

test('missing transfer, partial availability, wrong direction and outages never credit early', async t => {
  const wallet = mockWallet()
  const {incoming} = await setup(t, wallet, () =>
    assert.fail('must not notify')
  )
  wallet.getLightningReceiveRequest = async () => ({
    ...invoice,
    transfer: undefined
  })
  assert.equal(
    (await incoming.observe({...invoice, transfer: undefined})).status,
    'WAITING_FOR_FUNDS'
  )
  wallet.transfer.leaves.push({leaf: {id: 'second', status: 'CREATING'}})
  assert.equal((await incoming.observe(invoice)).status, 'WAITING_FOR_FUNDS')
  wallet.transfer.leaves.pop()
  wallet.transfer.transferDirection = 'OUTGOING'
  assert.equal((await incoming.observe(invoice)).status, 'WAITING_FOR_FUNDS')
  wallet.transfer.transferDirection = 'INCOMING'
  wallet.getBalance = async () => {
    throw new Error('unreachable')
  }
  assert.equal((await incoming.observe(invoice)).status, 'WAITING_FOR_FUNDS')
})

test('optimized leaves prove a completed receipt even after they leave the local cache', async () => {
  const wallet = mockWallet('SPLITTED')
  wallet.leafManager.leaves.clear()
  assert.equal(await receivedFundsAvailable(wallet, invoice), true)
  wallet.transfer.status = 'TRANSFER_STATUS_RECEIVER_KEY_TWEAKED'
  assert.equal(await receivedFundsAvailable(wallet, invoice), false)
})

test('completed receipt recovers after its original leaf is swapped to another owner', async t => {
  const wallet = mockWallet('CREATING', 'INCOMING')
  const events = []
  const {incoming, options} = await setup(t, wallet, event => {
    events.push(event)
    return true
  })
  assert.equal((await incoming.observe(invoice)).status, 'WAITING_FOR_FUNDS')
  await incoming.close()
  // Spark returns the leaf's CURRENT owner, even for an old completed transfer.
  // Optimization spends the original leaf and caches different replacement IDs.
  wallet.transfer.leaves[0].leaf.status = 'AVAILABLE'
  wallet.transfer.leaves[0].leaf.ownerIdentityPublicKey = `03${'2'.repeat(64)}`
  wallet.leafManager.leaves.clear()
  wallet.leafManager.leaves.set('replacement', {status: 'AVAILABLE'})
  const restarted = new IncomingInvoices(options)
  await restarted.initialize()
  t.after(() => restarted.close())
  await restarted.retryPending()
  assert.equal(events.length, 1)
  assert.equal(
    (await restarted.observe({id: invoice.id})).status,
    invoice.status
  )
  await restarted.retryPending()
  assert.equal(events.length, 1)
})

test('later spending must not make a completed receipt pending again', async () => {
  for (const localStatus of ['LOCAL_LOCKED', 'OUTGOING', 'SWAP_PENDING']) {
    const wallet = mockWallet('TRANSFER_LOCKED', localStatus)
    assert.equal(await receivedFundsAvailable(wallet, invoice), true)
  }
  const wallet = mockWallet('TRANSFER_LOCKED')
  wallet.leafManager.leaves.clear()
  wallet.transfer.leaves[0].leaf.ownerIdentityPublicKey = `03${'2'.repeat(64)}`
  assert.equal(await receivedFundsAvailable(wallet, invoice), true)
  wallet.transfer.status = 'TRANSFER_STATUS_RECEIVER_KEY_TWEAKED'
  assert.equal(await receivedFundsAvailable(wallet, invoice), false)
})

test('missing cache entries and unrelated balance alone do not prove clearing', async () => {
  assert.equal(
    await receivedFundsAvailable(mockWallet('CREATING', 'AVAILABLE'), invoice),
    false
  )
  const wallet = mockWallet()
  wallet.leafManager.leaves.clear()
  for (const owner of [
    undefined,
    '',
    'invalid',
    wallet.transfer.receiverIdentityPublicKey
  ]) {
    wallet.transfer.leaves[0].leaf.ownerIdentityPublicKey = owner
    assert.equal(await receivedFundsAvailable(wallet, invoice), false)
  }
  wallet.transfer.leaves[0].leaf.ownerIdentityPublicKey = `03${'2'.repeat(64)}`
  // Do not infer ownership history from another leg of a multi-receiver transfer.
  wallet.transfer.receivers = [{}, {}]
  assert.equal(await receivedFundsAvailable(wallet, invoice), false)
})

test('SDK 0.9.0 getTransfer preserves receiver legs and blocks multi-receiver ownership inference', async () => {
  const ownKey = Buffer.from(`02${'1'.repeat(64)}`, 'hex')
  const otherKey = Buffer.from(`03${'2'.repeat(64)}`, 'hex')
  const laterOwner = Buffer.from(`02${'3'.repeat(64)}`, 'hex')
  const receiver = (id, identityPublicKey) => ({
    id,
    identityPublicKey,
    amountSats: 100,
    status: SparkProto.TransferReceiverStatus.TRANSFER_RECEIVER_STATUS_COMPLETED
  })
  const proto = SparkProto.Transfer.fromPartial({
    id: 'transfer',
    status: SparkProto.TransferStatus.TRANSFER_STATUS_COMPLETED,
    receiverIdentityPublicKey: ownKey,
    totalValue: 100,
    leaves: [
      {
        leaf: {
          id: 'leaf',
          status: 'AVAILABLE',
          ownerIdentityPublicKey: laterOwner
        }
      }
    ]
  })
  // Use the actual SDK getTransfer + mapping code, without initializing a wallet,
  // keys, connections or a signer. Only the RPC response and identity are fixtures.
  const wallet = Object.create(SparkWallet.prototype)
  wallet.config = {signer: {getIdentityPublicKey: async () => ownKey}}
  wallet.transferService = {queryTransfer: async () => proto}
  wallet.leafManager = {leaves: new Map()}
  wallet.getBalance = async () => ({balance: 100n})

  // Legacy transfers: the protobuf defaults to [], which the SDK maps to undefined.
  assert.deepEqual(proto.receivers, [])
  assert.equal((await wallet.getTransfer('transfer')).receivers, undefined)
  assert.equal(await receivedFundsAvailable(wallet, invoice), true)

  proto.receivers = [receiver('own', ownKey)]
  const single = await wallet.getTransfer('transfer')
  assert.deepEqual(single.receivers, [
    {
      identityPublicKey: ownKey.toString('hex'),
      amountSats: 100,
      status: 'TRANSFER_RECEIVER_STATUS_COMPLETED'
    }
  ])
  assert.equal(await receivedFundsAvailable(wallet, invoice), true)

  // This wallet is the secondary receiver. Its own leaf is locally available;
  // another receiver's subsequently spent leaf must not count as its receipt.
  proto.receiverIdentityPublicKey = otherKey
  proto.receivers = [receiver('other', otherKey), receiver('own', ownKey)]
  proto.totalValue = 200
  proto.leaves.push(
    SparkProto.TransferLeaf.fromPartial({
      transferReceiverId: 'own',
      leaf: {
        id: 'own-leaf',
        status: 'AVAILABLE',
        ownerIdentityPublicKey: ownKey
      }
    })
  )
  wallet.leafManager.leaves.set('own-leaf', {status: 'AVAILABLE'})
  const multi = await wallet.getTransfer('transfer')
  assert.equal(multi.transferDirection, 'INCOMING')
  assert.equal(multi.receivers.length, 2)
  assert.equal(multi.receivers[1].identityPublicKey, ownKey.toString('hex'))
  assert.equal(await receivedFundsAvailable(wallet, invoice), false)
})

test('receipts discovered without an SSE client are notified when a client connects', async t => {
  let connected = false,
    count = 0
  const {incoming} = await setup(t, mockWallet(), () => {
    if (!connected) return false
    count++
    return true
  })
  assert.equal(
    (await incoming.observe(invoice)).status,
    'LIGHTNING_PAYMENT_RECEIVED'
  )
  assert.equal(count, 0)
  connected = true
  await incoming.retryPending()
  await incoming.retryPending()
  assert.equal(count, 1)
})

test('concurrent balance refreshes share one request and retry after an outage', async () => {
  let calls = 0
  const wallet = {
    getBalance: async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 10))
      if (calls === 1) throw new Error('temporary')
      return {balance: 1n}
    }
  }
  const results = await Promise.allSettled(
    Array.from({length: 100}, () => refreshBalance(wallet))
  )
  assert(results.every(result => result.status === 'rejected'))
  assert.equal(calls, 1)
  assert.equal((await refreshBalance(wallet)).balance, 1n)
  assert.equal(calls, 2)
})

test('bounded workers drain admitted operations and serialize duplicate keys', async () => {
  const queue = new OperationQueue(4)
  let active = 0,
    peak = 0,
    completed = 0
  const keys = new Set()
  const jobs = Array.from({length: 100}, (_, i) =>
    queue.run(i % 20, async () => {
      assert(!keys.has(i % 20))
      keys.add(i % 20)
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 5))
      keys.delete(i % 20)
      active--
      completed++
      if (i === 0) throw new Error('one job fails')
    })
  )
  const results = Promise.allSettled(jobs)
  await queue.close()
  assert.equal(peak, 4)
  assert.equal(completed, 100)
  assert.equal(
    (await results).filter(result => result.status === 'rejected').length,
    1
  )
  await assert.rejects(
    queue.run('new', () => {}),
    /stopping/
  )
})

test('200 incoming receipts overlap within the limit and duplicate notifications emit once', async t => {
  const wallet = mockWallet()
  let active = 0,
    peak = 0
  wallet.getTransfer = async () => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 20))
    active--
    return wallet.transfer
  }
  const events = new Set()
  const {incoming} = await setup(
    t,
    wallet,
    event => {
      assert(!events.has(event.checking_id))
      events.add(event.checking_id)
      return true
    },
    8
  )
  const start = performance.now()
  await Promise.all(
    Array.from({length: 400}, (_, i) =>
      incoming.observe({...invoice, id: `invoice-${i % 200}`})
    )
  )
  const elapsed = performance.now() - start
  assert.equal(events.size, 200)
  assert.equal(peak, 8)
  t.diagnostic(
    `Mock receive burst: 200 receipts / ${elapsed.toFixed(0)} ms (${(200000 / elapsed).toFixed(1)}/s), peak ${peak}, 20 ms transfer latency; not live Spark throughput`
  )
})
