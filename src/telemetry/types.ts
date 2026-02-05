export type LogLevel = 'info' | 'warn' | 'error'

export interface TelemetryProvider {
  captureException(error: Error, context?: Record<string, unknown>): void
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void
  profile<T>(name: string, fn: () => T): T
  profile<T>(name: string, fn: () => Promise<T>): Promise<T>
}
