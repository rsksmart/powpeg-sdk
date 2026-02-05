import type { TelemetryProvider } from './types'

export class NoOpTelemetryProvider implements TelemetryProvider {
  captureException(): void {}

  log(): void {}

  profile<T>(_name: string, fn: () => T | Promise<T>): T | Promise<T> {
    return fn()
  }
}
