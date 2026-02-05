import type { SeverityLevel } from '@sentry/browser'
import type { TelemetryProvider, LogLevel } from './types'

const logLevelToSeverity: Record<LogLevel, SeverityLevel> = {
  info: 'info',
  warn: 'warning',
  error: 'error',
}

export class SentryTelemetryProvider implements TelemetryProvider {
  private constructor(private sentry: typeof import('@sentry/browser')) {}

  /**
   * Creates and initializes a SentryTelemetryProvider.
   * @param dsn - Sentry DSN
   * @param options - Sentry BrowserOptions (optional overrides, excluding 'dsn')
   * @note Profiling requires the server to return `Document-Policy: js-profiling` header.
   * @see https://docs.sentry.io/platforms/javascript/profiling/
   */
  static async create(dsn: string, options?: Record<string, unknown>): Promise<SentryTelemetryProvider> {
    const Sentry = await import('@sentry/browser')
    Sentry.init({
      dsn,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.browserProfilingIntegration(),
      ],
      tracesSampleRate: 1.0,
      profileSessionSampleRate: 1.0,
      profileLifecycle: 'trace',
      ...options,
    })
    return new SentryTelemetryProvider(Sentry)
  }

  captureException(error: Error, context?: Record<string, unknown>): void {
    this.sentry.captureException(error, { extra: context })
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.sentry.captureMessage(message, {
      level: logLevelToSeverity[level],
      extra: data,
    })
  }

  profile<T>(name: string, fn: () => T | Promise<T>): T | Promise<T> {
    return this.sentry.startSpan({ name, op: 'function' }, () => fn())
  }
}
