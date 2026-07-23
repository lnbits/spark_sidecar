import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BoundedWorkQueue,
  isRateLimitError,
  PaymentMappingStore,
  QueueFullError,
  singleFlight
} from '../sidecar-runtime.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('bounded work queue limits concurrency and rejects excess work', async () => {
  let active = 0
  let maxActive = 0
  const queue = new BoundedWorkQueue({
    concurrency: 2,
    maxQueue: 1,
    name: 'test'
  })
  const work = () =>
    queue.run(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(20)
      active -= 1
    })

  const first = work()
  const second = work()
  const queued = work()
  await assert.rejects(work(), QueueFullError)
  await Promise.all([first, second, queued])

  assert.equal(maxActive, 2)
  assert.equal(queue.active, 0)
  assert.equal(queue.depth, 0)
})

test('bounded work queue handles a 250-request burst at configured concurrency', async () => {
  let active = 0
  let maxActive = 0
  const queue = new BoundedWorkQueue({
    concurrency: 8,
    maxQueue: 250
  })

  await Promise.all(
    Array.from({length: 250}, () =>
      queue.run(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await delay(1)
        active -= 1
      })
    )
  )

  assert.equal(maxActive, 8)
  assert.equal(queue.depth, 0)
})

test('rate-limited queue spaces task starts globally', async () => {
  const starts = []
  const queue = new BoundedWorkQueue({
    concurrency: 3,
    maxQueue: 10,
    minStartIntervalMs: 25
  })

  await Promise.all(
    Array.from({length: 4}, () =>
      queue.run(async () => {
        starts.push(Date.now())
      })
    )
  )

  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= 20)
  }
})

test('bounded work queue prioritizes settlement lookups', async () => {
  const order = []
  let releaseBlocker
  const queue = new BoundedWorkQueue({concurrency: 1, maxQueue: 10})
  const blocker = queue.run(
    () =>
      new Promise(resolve => {
        releaseBlocker = resolve
      })
  )
  await delay(0)
  const background = queue.run(() => order.push('background'), {priority: -10})
  const settlement = queue.run(() => order.push('settlement'), {priority: 10})

  releaseBlocker()
  await Promise.all([blocker, background, settlement])

  assert.deepEqual(order, ['settlement', 'background'])
})

test('bounded work queue pauses new starts during rate-limit cooldown', async () => {
  const queue = new BoundedWorkQueue({concurrency: 1, maxQueue: 10})
  const startedAt = Date.now()
  queue.pause(30)

  await queue.run(() => {})

  assert.ok(Date.now() - startedAt >= 25)
})

test('rate-limit errors are recognized from status and Spark messages', () => {
  assert.equal(isRateLimitError({status: 429}), true)
  assert.equal(
    isRateLimitError(new Error('Spark query failed: too many requests')),
    true
  )
  assert.equal(isRateLimitError(new Error('temporary network error')), false)
})

test('singleFlight shares one in-flight operation per key', async () => {
  const inFlight = new Map()
  let calls = 0
  const operation = () =>
    singleFlight(inFlight, 'same-key', async () => {
      calls += 1
      await delay(10)
      return 'result'
    })

  const results = await Promise.all([operation(), operation(), operation()])

  assert.deepEqual(results, ['result', 'result', 'result'])
  assert.equal(calls, 1)
  assert.equal(inFlight.size, 0)
})

test('payment mappings are batched, compacted, bounded, and reloadable', async t => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'spark-sidecar-state-test-')
  )
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}))
  const snapshotPath = path.join(directory, 'payments.json')
  const journalPath = path.join(directory, 'payments.log')
  const mappings = new Map()
  const store = new PaymentMappingStore({
    snapshotPath,
    journalPath,
    mappings,
    debounceMs: 1,
    compactEntries: 2,
    compactBytes: 1024,
    maxMappings: 3
  })

  store.remember('a', 'request-a')
  store.remember('b', 'request-b')
  await store.flush()
  store.remember('c', 'request-c')
  store.remember('d', 'request-d')
  await store.flush()

  assert.deepEqual(
    [...mappings],
    [
      ['b', 'request-b'],
      ['c', 'request-c'],
      ['d', 'request-d']
    ]
  )

  const reloaded = new Map()
  new PaymentMappingStore({
    snapshotPath,
    journalPath,
    mappings: reloaded,
    debounceMs: 1,
    compactEntries: 2,
    compactBytes: 1024,
    maxMappings: 3
  }).load()

  assert.deepEqual([...reloaded], [...mappings])
})
