import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {
  mkdtemp,
  readFile,
  readdir,
  chmod,
  writeFile,
  rename,
  rm
} from 'node:fs/promises'
import net from 'node:net'
import test from 'node:test'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {invoice as sendInvoice} from './test/invoice.mjs'
import {decodePayment} from './lightning.mjs'

async function testReceiptRecovery(t, optimized) {
  const directory = await mkdtemp(path.join(tmpdir(), 'spark-server-test-'))
  const fixturePath = `${directory}/fixture.json`
  const key = 'test-only-key'
  const secret = 'LEAKCANARY'
  const workingDirectories = []
  let data = {
    operatorStatus: 'CREATING',
    localStatus: 'INCOMING',
    updatedAt: new Date().toISOString(),
    sendHash: decodePayment(sendInvoice).hash
  }
  const save = async updates => {
    data = {
      ...JSON.parse(
        await readFile(fixturePath, 'utf8').catch(() => JSON.stringify(data))
      ),
      ...updates
    }
    await writeFile(`${fixturePath}.tmp`, JSON.stringify(data))
    await rename(`${fixturePath}.tmp`, fixturePath)
  }
  await save({})
  let child,
    exited,
    base,
    logs = ''
  const stop = async (signal = 'SIGTERM') => {
    if (!child) return
    child.kill(signal)
    await exited
    child = null
  }
  t.after(async () => {
    await stop()
    for (const cwd of workingDirectories) await chmod(cwd, 0o700)
    await rm(directory, {recursive: true})
    assert(!logs.includes(secret), 'Mnemonic reached process logs')
  })
  const start = async () => {
    const socket = net.createServer()
    socket.listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    base = `http://127.0.0.1:${port}`
    const cwd = await mkdtemp(path.join(directory, 'empty-cwd-'))
    workingDirectories.push(cwd)
    if (process.platform !== 'win32') await chmod(cwd, 0o555)
    child = spawn(
      process.execPath,
      [
        '--loader',
        new URL('./test/fixture-loader.mjs', import.meta.url).href,
        fileURLToPath(new URL('./server.mjs', import.meta.url))
      ],
      {
        cwd,
        env: {
          ...process.env,
          SPARK_MNEMONIC: secret,
          SPARK_SIDECAR_PORT: String(port),
          SPARK_SIDECAR_HOST: '127.0.0.1',
          SPARK_SIDECAR_API_KEY: key,
          SPARK_ONCHAIN_ENABLED: 'false',
          SPARK_PAYMENT_STATE_DIR: `${cwd}/must-not-create-journal`,
          SPARK_ONCHAIN_STATE_DIR: `${cwd}/must-not-create-onchain`,
          SPARK_SIDECAR_STATE_PATH: `${cwd}/must-not-create-state.json`,
          SPARK_PAY_WAIT_MS: '0',
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
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
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
  await t.test(
    'request parsing and SDK failures do not expose mnemonic text',
    async () => {
      const headers = {'x-api-key': key, 'content-type': 'application/json'}
      const malformed = await fetch(`${base}/v1/mnemonic`, {
        method: 'POST',
        headers,
        body: secret
      })
      assert.equal(malformed.status, 500)
      assert(
        !(await malformed.text()).includes(secret),
        'Parser echoed secret input'
      )
      const supplied = await fetch(`${base}/v1/mnemonic`, {
        method: 'POST',
        headers,
        body: JSON.stringify({mnemonic: secret})
      })
      assert.deepEqual(await supplied.json(), {status: 'already_set'})
      await save({balanceError: true})
      try {
        const failed = await fetch(`${base}/v1/balance`, {
          method: 'POST',
          headers
        })
        assert.equal(failed.status, 500)
        assert(
          !(await failed.text()).includes(secret),
          'SDK error exposed mnemonic'
        )
      } finally {
        await save({balanceError: false})
      }
    }
  )
  await save({updatedAt: new Date().toISOString()})
  let connection = await stream()
  // The event path must not trust success status before AVAILABLE either.
  await save({event: 1})
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal((await status()).status, 'WAITING_FOR_FUNDS')
  assert.equal(connection.events.length, 0)
  await connection.close()
  await stop()
  await start()
  connection = await stream()
  await save({operatorStatus: 'AVAILABLE'})
  assert.equal((await status()).status, 'WAITING_FOR_FUNDS')
  await save({localStatus: 'AVAILABLE', optimized})
  // The GET above recovered this old receipt directly from Spark. Streaming
  // must also find new updates from Spark without a disk watermark.
  await save({updatedAt: new Date().toISOString()})
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
    outage: false
  })
  await start()
  assert.equal((await status()).status, 'LIGHTNING_PAYMENT_RECEIVED')
  await stop()
  // Outgoing checks also survive a fresh process and working directory.
  await start()
  const sent = await (
    await fetch(`${base}/v1/payments`, {
      method: 'POST',
      headers: {'x-api-key': key, 'content-type': 'application/json'},
      body: JSON.stringify({bolt11: sendInvoice, max_fee_sats: 5})
    })
  ).json()
  assert.equal(sent.checking_id, 'spark-send-request')
  assert.equal(sent.status, 'CREATED')
  await stop('SIGKILL')
  const provider = JSON.parse(await readFile(fixturePath, 'utf8'))
  await save({
    sendRequest: {
      ...provider.sendRequest,
      status: 'LIGHTNING_PAYMENT_SUCCEEDED',
      paymentPreimage: 'send-proof'
    }
  })
  await start()
  const outgoing = async id =>
    (
      await fetch(`${base}/v1/payments/${id}`, {headers: {'x-api-key': key}})
    ).json()
  assert.equal(
    (await outgoing(sent.checking_id)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  assert.equal(
    (await outgoing(data.sendHash)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  await save({outage: true})
  assert.equal((await outgoing(sent.checking_id)).status, 'UNKNOWN')
  assert.equal(
    (
      await fetch(`${base}/v1/invoices/receive-test`, {
        headers: {'x-api-key': key}
      })
    ).status,
    500
  )
  await stop()
  assert.equal(JSON.parse(await readFile(fixturePath, 'utf8')).submissions, 1)
  for (const cwd of workingDirectories) assert.deepEqual(await readdir(cwd), [])
}

for (const optimized of [false, true]) {
  test(`HTTP status and SSE work after replacement without any local files (optimized: ${optimized})`, t =>
    testReceiptRecovery(t, optimized))
}
