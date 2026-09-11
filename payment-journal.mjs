import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'

async function lockFile(handle) {
  // flock locks the shared open-file description. The parent's descriptor keeps
  // the lock after this helper exits; the kernel releases it when Node dies.
  await new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
      env: {PATH: process.env.PATH}
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) return resolve()
      reject(
        Object.assign(new Error('Cannot acquire payment journal lock'), {
          code: code === 1 ? 'EEXIST' : 'ELOCK'
        })
      )
    })
  })
}

async function sameFile(handle, filename) {
  const [opened, named] = await Promise.all([
    handle.stat({bigint: true}),
    fs.stat(filename, {bigint: true})
  ])
  return opened.dev === named.dev && opened.ino === named.ino
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// This journal is financial state, independent of the sidecar's SSE watermark.
// Every intent is fsync'ed before a Spark call, and every result before response.
export class PaymentJournal {
  constructor(directory) {
    this.directory = directory
  }

  async initialize() {
    if (this.lock) throw new Error('Payment journal is already initialized')
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700})
    const lockPath = path.join(this.directory, 'writer.lock')
    // Preserve the existing conservative behavior on non-Linux platforms.
    if (process.platform !== 'linux') {
      this.lock = await fs.open(lockPath, 'wx', 0o600)
      await this.lock.writeFile(String(process.pid))
      await this.lock.sync()
      return
    }
    const guardPath = path.join(this.directory, 'writer.flock')
    const handle = await fs.open(guardPath, 'a+', 0o600)
    let ownsMarker = false
    try {
      await lockFile(handle)
      // Keep this inode permanently: unlinking a flock file can allow two locks
      // on different inodes. Persist its name before creating the legacy marker.
      await handle.sync()
      await syncDirectory(this.directory)
      try {
        await fs.link(guardPath, lockPath)
        ownsMarker = true
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (!(await sameFile(handle, lockPath)))
          throw new Error(
            'Legacy writer.lock exists; verify the old writer has stopped before removing it'
          )
        // A hard link to our locked inode is a marker from this implementation.
        // An acquired kernel lock proves its previous writer no longer holds it.
        ownsMarker = true
      }
      await handle.truncate(0)
      await handle.writeFile(
        JSON.stringify({
          version: 1,
          pid: process.pid,
          nonce: randomUUID(),
          startedAt: Date.now()
        })
      )
      await handle.sync()
      await syncDirectory(this.directory)
      this.lock = handle
    } catch (error) {
      try {
        if (ownsMarker) await fs.unlink(lockPath)
      } finally {
        await handle.close()
      }
      throw error
    }
  }

  async close() {
    const handle = this.lock
    if (!handle) return
    this.lock = undefined
    try {
      const lockPath = path.join(this.directory, 'writer.lock')
      if (!(await sameFile(handle, lockPath)))
        throw new Error('Payment journal lock ownership changed')
      await fs.unlink(lockPath)
      await syncDirectory(this.directory)
    } finally {
      await handle.close()
    }
  }

  async get(id) {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.directory, `${id}.json`), 'utf8')
      )
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error // Corruption must fail closed; never treat it as a new operation.
    }
  }

  async remove(id) {
    const filename = path.join(this.directory, `${id}.json`)
    try {
      await fs.unlink(filename)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const directory = await fs.open(path.dirname(filename), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  async put(id, value) {
    const temporary = path.join(this.directory, `${id}.${randomUUID()}.tmp`)
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, path.join(this.directory, `${id}.json`))
    const directory = await fs.open(path.dirname(temporary), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}
