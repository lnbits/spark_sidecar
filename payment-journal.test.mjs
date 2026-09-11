import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import test from 'node:test'
import {PaymentJournal} from './payment-journal.mjs'

const linux = {skip: process.platform !== 'linux'}
async function temporaryJournal(t) {
  const directory = await mkdtemp('/tmp/spark-lock-test-')
  t.after(() => rm(directory, {recursive: true, force: true}))
  return directory
}
function writer(t, directory) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const {PaymentJournal} = await import(process.argv[1]);
      const journal = new PaymentJournal(process.argv[2]);
      try {
        await journal.initialize();
        await journal.put('intent', {status: 'UNKNOWN'});
        process.send('locked');
        setInterval(() => {}, 1000);
      } catch { process.send('blocked'); process.exit(1); }
    `,
      new URL('./payment-journal.mjs', import.meta.url).href,
      directory
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {PATH: process.env.PATH}
    }
  )
  const exited = once(child, 'exit')
  const ready = once(child, 'message').then(([message]) => message)
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    await exited
  })
  return {child, exited, ready}
}

test(
  'kernel lock excludes a live writer and recovers after SIGKILL with journal intact',
  linux,
  async t => {
    const directory = await temporaryJournal(t)
    const running = writer(t, directory)
    assert.equal(await running.ready, 'locked')
    const contender = new PaymentJournal(directory)
    await assert.rejects(contender.initialize(), {code: 'EEXIST'})
    await contender.close() // A failed contender must not remove the owner's lock.
    const inode = (await stat(`${directory}/writer.flock`)).ino
    assert.equal((await stat(`${directory}/writer.lock`)).ino, inode)
    running.child.kill('SIGKILL')
    await running.exited
    const recovered = new PaymentJournal(directory)
    await recovered.initialize()
    try {
      assert.deepEqual(await recovered.get('intent'), {status: 'UNKNOWN'})
      assert.equal((await stat(`${directory}/writer.flock`)).ino, inode)
      const metadata = JSON.parse(
        await readFile(`${directory}/writer.lock`, 'utf8')
      )
      assert.equal(metadata.pid, process.pid)
      assert.equal(typeof metadata.nonce, 'string')
      assert.equal(typeof metadata.startedAt, 'number')
    } finally {
      await recovered.close()
    }
    // Never unlink the kernel-lock inode, including on graceful shutdown.
    assert.equal((await stat(`${directory}/writer.flock`)).ino, inode)
  }
)

test(
  'simultaneous processes cannot both reclaim a crashed writer',
  linux,
  async t => {
    const directory = await temporaryJournal(t)
    const old = writer(t, directory)
    assert.equal(await old.ready, 'locked')
    old.child.kill('SIGKILL')
    await old.exited
    const a = writer(t, directory)
    const b = writer(t, directory)
    assert.deepEqual((await Promise.all([a.ready, b.ready])).sort(), [
      'blocked',
      'locked'
    ])
  }
)

test(
  'recovery does not depend on PID reuse or partially written metadata',
  linux,
  async t => {
    const directory = await temporaryJournal(t)
    const old = writer(t, directory)
    assert.equal(await old.ready, 'locked')
    old.child.kill('SIGKILL')
    await old.exited
    // Simulate interruption while rewriting metadata: the hard-link identity and
    // kernel lock still distinguish this implementation from an old PID-only lock.
    await writeFile(`${directory}/writer.lock`, '{partial')
    const recovered = new PaymentJournal(directory)
    await recovered.initialize()
    await recovered.close()
  }
)

test(
  'legacy PID-only locks are never stolen based on PID guesses',
  linux,
  async t => {
    const directory = await temporaryJournal(t)
    await writeFile(`${directory}/writer.lock`, '99999999')
    const journal = new PaymentJournal(directory)
    await assert.rejects(journal.initialize(), /Legacy writer.lock/)
    await journal.close()
    assert.equal(await readFile(`${directory}/writer.lock`, 'utf8'), '99999999')
  }
)
