import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm} from 'node:fs/promises'
import {IncomingInvoices, receivedFundsAvailable} from './incoming.mjs'
import {OnchainJournal} from './onchain.mjs'
import {OperationQueue} from './operation-queue.mjs'
import {refreshBalance} from './lightning.mjs'

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
  const journal = new OnchainJournal(directory)
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
