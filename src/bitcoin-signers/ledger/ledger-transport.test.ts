import { LedgerTransportService } from './ledger-transport'
import type Transport from '@ledgerhq/hw-transport'
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('LedgerTransportService', () => {
  let transport: { _appAPIlock: string }
  let service: LedgerTransportService

  beforeEach(() => {
    transport = {
      _appAPIlock: '',
    }
    service = new LedgerTransportService(transport as unknown as Transport)
  })

  it('should enqueue and process operations', async () => {
    const op = vi.fn().mockResolvedValue(1)
    const result = await service.enqueue(op)
    expect(result).toBe(1)
    expect(op).toHaveBeenCalled()
  })

  it('should execute operations in order', async () => {
    const op1 = vi.fn().mockResolvedValue(1)
    const op2 = vi.fn().mockResolvedValue(2)

    const promise1 = service.enqueue(op1)
    const promise2 = service.enqueue(op2)

    const [result1, result2] = await Promise.all([promise1, promise2])

    expect(result1).toBe(1)
    expect(result2).toBe(2)
    expect(op1).toHaveBeenCalledBefore(op2)
  })

  it('should queue operations when device is busy', async () => {
    transport._appAPIlock = 'TransportLocked'
    const op1 = vi.fn().mockResolvedValue(1)
    const op2 = vi.fn().mockResolvedValue(2)

    const promise1 = service.enqueue(op1)
    const promise2 = service.enqueue(op2)

    expect(op1).not.toHaveBeenCalled()
    expect(op2).not.toHaveBeenCalled()

    transport._appAPIlock = ''
    await service.enqueue(vi.fn().mockResolvedValue(0))

    const [result1, result2] = await Promise.all([promise1, promise2])

    expect(result1).toBe(1)
    expect(result2).toBe(2)
    expect(op1).toHaveBeenCalledBefore(op2)
  })

  it('should handle multiple operations queued while device is busy', async () => {
    transport._appAPIlock = 'TransportLocked'
    const operations = Array.from({ length: 5 }, (_, i) =>
      vi.fn().mockResolvedValue(i + 1),
    )

    const promises = operations.map((op) => service.enqueue(op))

    operations.forEach((op) => expect(op).not.toHaveBeenCalled())

    transport._appAPIlock = ''
    await service.enqueue(vi.fn().mockResolvedValue(0))

    const results = await Promise.all(promises)

    results.forEach((result, i) => {
      expect(result).toBe(i + 1)
    })

    for (let i = 1; i < operations.length; i++) {
      expect(operations[i - 1]).toHaveBeenCalledBefore(operations[i])
    }
  })
})
