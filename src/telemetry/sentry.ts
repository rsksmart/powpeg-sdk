import type { SeverityLevel } from '@sentry/browser'
import type { TelemetryProvider, LogLevel } from './types'

const logLevelToSeverity: Record<LogLevel, SeverityLevel> = {
  info: 'info',
  warn: 'warning',
  error: 'error',
}

interface SentryLike {
  withScope: (callback: (scope: ScopeLike) => void) => void
  captureException: (error: unknown) => void
  captureMessage: (message: string, options?: { level?: SeverityLevel }) => void
  startSpan: <T>(options: { name: string, op: string }, callback: () => T) => T
}

interface ScopeLike {
  setTag: (key: string, value: string) => void
  setContext: (name: string, context: Record<string, unknown> | null) => void
}

export class SentryTelemetryProvider implements TelemetryProvider {
  private constructor(
    private sentry: SentryLike,
    private tag: string,
  ) {}

  /**
   * Creates and initializes a SentryTelemetryProvider.
   * @param dsn - Sentry DSN
   * @param options - Sentry BrowserOptions (optional overrides, excluding 'dsn')
   * @note Profiling requires the server to return `Document-Policy: js-profiling` header.
   * @see https://docs.sentry.io/platforms/javascript/profiling/
   */
  static async create(
    dsn: string,
    options?: Record<string, unknown>,
    tag = 'powpeg-sdk',
  ): Promise<SentryTelemetryProvider> {
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
    return new SentryTelemetryProvider(Sentry, tag)
  }

  captureException(error: Error, context?: Record<string, unknown>): void {
    this.sentry.withScope((scope) => {
      scope.setTag('source', this.tag)
      if (context) {
        scope.setContext('powpeg', context)
      }
      this.sentry.captureException(error)
    })
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.sentry.withScope((scope) => {
      scope.setTag('source', this.tag)
      if (data) {
        scope.setContext('powpeg', data)
      }
      this.sentry.captureMessage(message, {
        level: logLevelToSeverity[level],
      })
    })
  }

  profile<T>(name: string, fn: () => T | Promise<T>): T | Promise<T> {
    return this.sentry.startSpan({ name, op: 'function' }, () => fn())
  }

  static fromInstance(
    sentry: SentryLike,
    tag = 'powpeg-sdk',
  ): SentryTelemetryProvider {
    return new SentryTelemetryProvider(sentry, tag)
  }
}
