import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'

// This journal is financial state, independent of the sidecar's SSE watermark.
// Every intent is fsync'ed before a Spark call, and every result before response.
export class PaymentJournal {
  constructor(directory) {
    this.directory = directory
  }

  async initialize() {
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700})
    const lockPath = path.join(this.directory, 'writer.lock')
    this.lock = await fs.open(lockPath, 'wx', 0o600)
    await this.lock.writeFile(String(process.pid))
    await this.lock.sync()
  }

  async close() {
    await this.lock?.close()
    await fs.unlink(path.join(this.directory, 'writer.lock'))
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
