import type { TelemetryProvider, LogLevel } from './types'

export class SafeTelemetryProvider implements TelemetryProvider {
  constructor(private readonly wrapped: TelemetryProvider) {}

  captureException(error: Error, context?: Record<string, unknown>): void {
    try {
      this.wrapped.captureException(error, context)
    }
    catch {
      // Telemetry failures must never affect SDK behavior.
    }
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    try {
      this.wrapped.log(level, message, data)
    }
    catch {
      // Telemetry failures must never affect SDK behavior.
    }
  }

  profile<T>(name: string, fn: () => T | Promise<T>): T | Promise<T> {
    let invoked = false
    const wrappedFn = () => {
      invoked = true
      return fn()
    }

    try {
      const result = this.wrapped.profile(name, wrappedFn)
      if (result instanceof Promise) {
        return result.catch((error) => {
          if (invoked) {
            throw error
          }
          return wrappedFn()
        })
      }
      return result
    }
    catch (error) {
      if (invoked) {
        throw error
      }
      return wrappedFn()
    }
  }
}
