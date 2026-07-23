import fs from 'node:fs'

export class QueueFullError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QueueFullError'
  }
}

export class OperationTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OperationTimeoutError'
  }
}

export function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise
  }

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new OperationTimeoutError(message)),
      timeoutMs
    )
  })

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer)
  })
}

export class BoundedWorkQueue {
  constructor({
    concurrency,
    maxQueue,
    minStartIntervalMs = 0,
    name = 'work',
    onChange = () => {}
  }) {
    this.concurrency = Math.max(1, concurrency)
    this.maxQueue = Math.max(0, maxQueue)
    this.minStartIntervalMs = Math.max(0, minStartIntervalMs)
    this.name = name
    this.onChange = onChange
    this.active = 0
    this.queue = []
    this.lastStartedAt = 0
    this.pausedUntil = 0
    this.timer = null
  }

  get depth() {
    return this.queue.length
  }

  run(task, {priority = 0} = {}) {
    const canStartImmediately =
      this.active < this.concurrency &&
      this.queue.length === 0 &&
      this._startDelayMs() === 0
    if (!canStartImmediately && this.queue.length >= this.maxQueue) {
      return Promise.reject(
        new QueueFullError(`${this.name} queue is at capacity`)
      )
    }

    return new Promise((resolve, reject) => {
      const item = {task, resolve, reject, priority}
      const insertionIndex = this.queue.findIndex(
        queued => queued.priority < priority
      )
      if (insertionIndex === -1) {
        this.queue.push(item)
      } else {
        this.queue.splice(insertionIndex, 0, item)
      }
      this._changed()
      this._drain()
    })
  }

  pause(durationMs) {
    this.pausedUntil = Math.max(
      this.pausedUntil,
      Date.now() + Math.max(0, durationMs)
    )
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this._drain()
  }

  _startDelayMs() {
    const now = Date.now()
    const rateLimitDelay =
      !this.lastStartedAt || this.minStartIntervalMs === 0
        ? 0
        : this.lastStartedAt + this.minStartIntervalMs - now
    return Math.max(0, rateLimitDelay, this.pausedUntil - now)
  }

  _drain() {
    if (this.timer || this.queue.length === 0) {
      return
    }

    while (this.active < this.concurrency && this.queue.length > 0) {
      const delayMs = this._startDelayMs()
      if (delayMs > 0) {
        this.timer = setTimeout(() => {
          this.timer = null
          this._drain()
        }, delayMs)
        return
      }

      const item = this.queue.shift()
      this.active += 1
      this.lastStartedAt = Date.now()
      this._changed()
      void Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1
          this._changed()
          this._drain()
        })

      if (this.minStartIntervalMs > 0) {
        const nextDelayMs = this._startDelayMs()
        this.timer = setTimeout(() => {
          this.timer = null
          this._drain()
        }, nextDelayMs)
        return
      }
    }
  }

  _changed() {
    this.onChange({active: this.active, depth: this.depth})
  }
}

export function singleFlight(inFlight, key, task) {
  if (!key) {
    return task()
  }
  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }
  const promise = Promise.resolve().then(task)
  inFlight.set(key, promise)
  void promise.then(
    () => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key)
      }
    },
    () => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key)
      }
    }
  )
  return promise
}

export function isRateLimitError(error) {
  const status =
    error?.status ??
    error?.statusCode ??
    error?.response?.status ??
    error?.cause?.status ??
    error?.cause?.statusCode
  if (Number(status) === 429) {
    return true
  }
  const message = [error?.message, error?.initialMessage, error?.cause?.message]
    .filter(Boolean)
    .join(' ')
  return /\b429\b|too many requests|rate.?limit/i.test(message)
}

export class PaymentMappingStore {
  constructor({
    snapshotPath,
    journalPath,
    mappings,
    debounceMs,
    compactEntries,
    compactBytes,
    maxMappings,
    onWrite = () => {},
    onError = () => {}
  }) {
    this.snapshotPath = snapshotPath
    this.journalPath = journalPath
    this.mappings = mappings
    this.debounceMs = Math.max(0, debounceMs)
    this.compactEntries = Math.max(1, compactEntries)
    this.compactBytes = Math.max(1, compactBytes)
    this.maxMappings = Math.max(1, maxMappings)
    this.onWrite = onWrite
    this.onError = onError
    this.pending = new Map()
    this.journalEntries = 0
    this.journalBytes = 0
    this.flushTimer = null
    this.writePromise = Promise.resolve()
  }

  load() {
    this._loadSnapshot()
    this._loadJournal()
    this._trimMappings()
  }

  remember(paymentHash, requestId) {
    if (!paymentHash || !requestId) {
      return
    }
    this.mappings.delete(paymentHash)
    this.mappings.set(paymentHash, requestId)
    this._trimMappings()
    this.pending.delete(paymentHash)
    this.pending.set(paymentHash, requestId)
    while (this.pending.size > this.maxMappings) {
      this.pending.delete(this.pending.keys().next().value)
    }
    this._scheduleFlush()
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this._enqueuePending()
    await this.writePromise
  }

  compact() {
    this.writePromise = this.writePromise.then(async () => {
      const startedAt = performance.now()
      try {
        await this._compact()
        this.onWrite(performance.now() - startedAt, null)
      } catch (error) {
        this.onWrite(performance.now() - startedAt, error)
        this.onError('compacting payment mappings', error)
      }
    })
    return this.writePromise
  }

  _loadSnapshot() {
    try {
      if (!fs.existsSync(this.snapshotPath)) {
        return
      }
      const parsed = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'))
      const entries = parsed?.paymentRequestIds
      if (!entries || typeof entries !== 'object') {
        return
      }
      for (const [paymentHash, requestId] of Object.entries(entries)) {
        if (typeof requestId === 'string') {
          this.mappings.delete(paymentHash)
          this.mappings.set(paymentHash, requestId)
        }
      }
    } catch (error) {
      this.onError('loading payment mapping snapshot', error)
    }
  }

  _loadJournal() {
    try {
      if (!fs.existsSync(this.journalPath)) {
        return
      }
      const raw = fs.readFileSync(this.journalPath, 'utf8')
      this.journalBytes = Buffer.byteLength(raw)
      for (const line of raw.split('\n')) {
        if (!line) {
          continue
        }
        try {
          const [paymentHash, requestId] = JSON.parse(line)
          if (
            typeof paymentHash === 'string' &&
            typeof requestId === 'string'
          ) {
            this.mappings.delete(paymentHash)
            this.mappings.set(paymentHash, requestId)
            this.journalEntries += 1
          }
        } catch (error) {
          this.onError('loading a payment mapping journal entry', error)
        }
      }
    } catch (error) {
      this.onError('loading payment mapping journal', error)
    }
  }

  _scheduleFlush() {
    if (this.flushTimer) {
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this._enqueuePending()
    }, this.debounceMs)
  }

  _enqueuePending() {
    if (this.pending.size === 0) {
      return
    }
    const batch = [...this.pending]
    this.pending.clear()
    const body = `${batch.map(entry => JSON.stringify(entry)).join('\n')}\n`
    this.writePromise = this.writePromise.then(async () => {
      const startedAt = performance.now()
      try {
        await fs.promises.appendFile(this.journalPath, body, 'utf8')
        this.journalEntries += batch.length
        this.journalBytes += Buffer.byteLength(body)
        if (
          this.journalEntries >= this.compactEntries ||
          this.journalBytes >= this.compactBytes
        ) {
          await this._compact()
        }
        this.onWrite(performance.now() - startedAt, null)
      } catch (error) {
        const newer = [...this.pending]
        this.pending.clear()
        for (const [paymentHash, requestId] of batch) {
          this.pending.set(paymentHash, requestId)
        }
        for (const [paymentHash, requestId] of newer) {
          this.pending.delete(paymentHash)
          this.pending.set(paymentHash, requestId)
        }
        while (this.pending.size > this.maxMappings) {
          this.pending.delete(this.pending.keys().next().value)
        }
        this.onWrite(performance.now() - startedAt, error)
        this.onError('persisting payment mappings', error)
        this._scheduleFlush()
      }
    })
  }

  async _compact() {
    const temporaryPath = `${this.snapshotPath}.${process.pid}.tmp`
    const snapshot = JSON.stringify({
      paymentRequestIds: Object.fromEntries(this.mappings)
    })
    await fs.promises.writeFile(temporaryPath, snapshot, 'utf8')
    await fs.promises.rename(temporaryPath, this.snapshotPath)
    await fs.promises.writeFile(this.journalPath, '', 'utf8')
    this.journalEntries = 0
    this.journalBytes = 0
  }

  _trimMappings() {
    while (this.mappings.size > this.maxMappings) {
      const oldest = this.mappings.keys().next().value
      this.mappings.delete(oldest)
    }
  }
}
