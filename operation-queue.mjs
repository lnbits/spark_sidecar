// Serialize duplicate operations while letting independent work overlap.
export class OperationQueue {
  constructor(concurrency = 8) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new Error('Operation concurrency must be a positive integer')
    this.concurrency = concurrency
    this.active = 0
    this.waiters = []
    this.keys = new Map()
    this.closing = false
  }

  run(key, work) {
    if (this.closing) return Promise.reject(new Error('Sidecar is stopping'))
    const prior = this.keys.get(key) || Promise.resolve()
    const result = prior.then(async () => {
      if (this.active >= this.concurrency)
        await new Promise(resolve => this.waiters.push(resolve))
      else this.active++
      try {
        return await work()
      } finally {
        const next = this.waiters.shift()
        if (next) next()
        else this.active--
      }
    })
    const settled = result.then(
      () => {},
      () => {}
    )
    this.keys.set(key, settled)
    void settled.then(() => {
      if (this.keys.get(key) === settled) this.keys.delete(key)
    })
    return result
  }

  async close() {
    this.closing = true
    await Promise.all(this.keys.values())
  }
}
