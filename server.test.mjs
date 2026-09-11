import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, writeFile, rename, rm} from 'node:fs/promises'
import net from 'node:net'
import test from 'node:test'

async function testReceiptRecovery(t, optimized) {
  const directory = await mkdtemp('/tmp/spark-server-test-')
  const fixturePath = `${directory}/fixture.json`
  const key = 'test-only-key'
  let legacyLocation = true
  let data = {
    operatorStatus: 'CREATING',
    localStatus: 'INCOMING',
    updatedAt: new Date().toISOString()
  }
  const save = async updates => {
    data = {...data, ...updates}
    await writeFile(`${fixturePath}.tmp`, JSON.stringify(data))
    await rename(`${fixturePath}.tmp`, fixturePath)
  }
  await save({})
  let child,
    exited,
    base,
    logs = ''
  const stop = async () => {
    if (!child) return
    child.kill('SIGTERM')
    await exited
    child = null
  }
  t.after(async () => {
    await stop()
    await rm(directory, {recursive: true})
  })
  const start = async () => {
    const socket = net.createServer()
    socket.listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    base = `http://127.0.0.1:${port}`
    child = spawn(
      process.execPath,
      ['--loader', './test/fixture-loader.mjs', 'server.mjs'],
      {
        cwd: import.meta.dirname || new URL('.', import.meta.url).pathname,
        env: {
          ...process.env,
          SPARK_MNEMONIC: 'mock-only',
          SPARK_SIDECAR_PORT: String(port),
          SPARK_SIDECAR_HOST: '127.0.0.1',
          SPARK_SIDECAR_API_KEY: key,
          SPARK_ONCHAIN_ENABLED: 'false',
          SPARK_PAYMENT_STATE_DIR: legacyLocation ? '' : `${directory}/journal`,
          SPARK_ONCHAIN_STATE_DIR: legacyLocation ? `${directory}/journal` : '',
          SPARK_SIDECAR_STATE_PATH: `${directory}/state.json`,
          SPARK_TEST_STATE: fixturePath,
          SPARK_INVOICE_POLL_MS: '40',
          SPARK_STREAM_HEARTBEAT_MS: '0',
          SPARK_STATE_PERSIST_DEBOUNCE_MS: '0'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout.on('data', chunk => {
      logs += chunk
    })
    child.stderr.on('data', chunk => {
      logs += chunk
    })
    exited = once(child, 'exit')
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/health`, {headers: {'x-api-key': key}})).ok)
          return
      } catch {}
      if (child.exitCode !== null) throw new Error(logs)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error(`Server did not start: ${logs}`)
  }
  const status = async () =>
    (
      await fetch(`${base}/v1/invoices/receive-test`, {
        headers: {'x-api-key': key}
      })
    ).json()
  const stream = async () => {
    const abort = new AbortController()
    const response = await fetch(`${base}/v1/invoices/stream`, {
      headers: {'x-api-key': key},
      signal: abort.signal
    })
    assert.equal(response.status, 200)
    const events = []
    const reading = (async () => {
      let pending = ''
      for await (const chunk of response.body) {
        pending += Buffer.from(chunk).toString()
        let end
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, end)
          pending = pending.slice(end + 2)
          if (event.startsWith('data: '))
            events.push(JSON.parse(event.slice(6)))
        }
      }
    })().catch(() => {})
    return {
      events,
      close: async () => {
        abort.abort()
        await reading
      }
    }
  }
  await start()
  await save({updatedAt: new Date().toISOString()})
  let connection = await stream()
  // The event path must not trust success status before AVAILABLE either.
  await save({event: 1})
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal((await status()).status, 'WAITING_FOR_FUNDS')
  assert.equal(connection.events.length, 0)
  await connection.close()
  await stop()
  legacyLocation = false
  await start()
  connection = await stream()
  await save({operatorStatus: 'AVAILABLE'})
  assert.equal((await status()).status, 'WAITING_FOR_FUNDS')
  await save({localStatus: 'AVAILABLE', optimized})
  // No new event: the actual server's poller must recover the durable receipt.
  for (let i = 0; i < 100 && !connection.events.length; i++)
    await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(connection.events.length, 1, logs)
  assert.equal(connection.events[0].checking_id, 'receive-test')
  assert.equal((await status()).status, 'LIGHTNING_PAYMENT_RECEIVED')
  await connection.close()
  await stop()
  await save({
    operatorStatus: 'TRANSFER_LOCKED',
    localStatus: 'OUTGOING',
    outage: true
  })
  await start()
  assert.equal((await status()).status, 'LIGHTNING_PAYMENT_RECEIVED')
}

for (const optimized of [false, true]) {
  test(`HTTP status and SSE recover receipts after restart (optimized: ${optimized})`, t =>
    testReceiptRecovery(t, optimized))
}
