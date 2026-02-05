import { describe, expect, it, vi } from 'vitest'
import { SafeTelemetryProvider } from './safe'
import type { TelemetryProvider } from './types'

function createThrowingProvider(): TelemetryProvider {
  return {
    captureException: vi.fn(() => { throw new Error('captureException failed') }),
    log: vi.fn(() => { throw new Error('log failed') }),
    profile: vi.fn(() => { throw new Error('profile failed') }),
  }
}

describe('SafeTelemetryProvider', () => {
  it('does not throw when captureException fails', () => {
    const safe = new SafeTelemetryProvider(createThrowingProvider())

    expect(() => safe.captureException(new Error('boom'))).not.toThrow()
  })

  it('does not throw when log fails', () => {
    const safe = new SafeTelemetryProvider(createThrowingProvider())

    expect(() => safe.log('error', 'boom')).not.toThrow()
  })

  it('executes the provided function when profile fails (sync)', () => {
    const safe = new SafeTelemetryProvider(createThrowingProvider())
    const fn = vi.fn(() => 'ok')
    const result = safe.profile('sync', fn)

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('executes the provided function when profile fails (async)', async () => {
    const safe = new SafeTelemetryProvider(createThrowingProvider())
    const fn = vi.fn(async () => {
      await Promise.resolve()
      return 'ok'
    })
    const result = await safe.profile('async', fn)

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not execute the function twice when wrapped provider throws after invoking it', () => {
    const wrapped = createThrowingProvider()
    vi.mocked(wrapped.profile).mockImplementation((_name, fn) => {
      const result = fn()
      throw new Error('profile failed after fn')
      return result
    })
    const safe = new SafeTelemetryProvider(wrapped)
    const fn = vi.fn(() => 'ok')

    expect(() => safe.profile('sync', fn)).toThrowError('profile failed after fn')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
