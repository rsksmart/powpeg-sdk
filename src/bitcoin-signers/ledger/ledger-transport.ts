import type Transport from '@ledgerhq/hw-transport'

type QueueItem<T> = {
  resolve: (value: T) => void
  reject: (reason: Error) => void
  operation: () => Promise<T>
}

export class LedgerTransportService {
  private readonly queue: QueueItem<unknown>[] = []
  private isProcessing = false

  constructor(private readonly transport: Transport) {}

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0 || this.isDeviceBusy()) {
      return
    }

    this.isProcessing = true
    const item = this.queue.shift()

    if (!item) {
      this.isProcessing = false
      return
    }

    try {
      const result = await item.operation()
      item.resolve(result)
    }
    catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)))
    }
    finally {
      this.isProcessing = false
      this.processQueue()
    }
  }

  async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: Error) => void,
        operation,
      })
      this.processQueue()
    })
  }

  isDeviceBusy(): boolean {
    return Boolean(this.transport._appAPIlock)
  }
}
