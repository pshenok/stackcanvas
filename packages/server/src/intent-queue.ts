import type { Intent } from '@stackcanvas/core'

export class IntentQueue {
  private queue: Intent[] = []
  private waiters: Array<(i: Intent) => void> = []

  push(intent: Intent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(intent)
    else this.queue.push(intent)
  }

  take(timeoutMs: number): Promise<Intent | null> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter)
        resolve(null)
      }, timeoutMs)
      const waiter = (i: Intent) => { clearTimeout(timer); resolve(i) }
      this.waiters.push(waiter)
    })
  }
}
