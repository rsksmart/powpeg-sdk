/** Thrown when a requested peg-in or peg-out amount is below the SDK's minimum allowed amount. */
export class AmountBelowMinError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AmountBelowMinError'
  }
}

/** Thrown when the available UTXOs (or account balance, for peg-outs) are insufficient to cover the requested amount plus fees. */
export class NotEnoughFundsError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'NotEnoughFundsError'
  }
}

/** Thrown when a call to the bundled 2WP API fails. */
export class APIError extends Error {
  readonly statusCode?: number
  readonly data?: unknown

  /**
   * @param {string} message - The error message.
   * @param {number} statusCode - The HTTP status code returned by the API, if any.
   * @param {unknown} data - The raw response data returned by the API, if any.
   */
  constructor(message: string, statusCode?: number, data?: unknown) {
    super(message)
    this.name = 'APIError'
    this.statusCode = statusCode
    this.data = data
  }
}

/** Thrown when one or more Bitcoin addresses are invalid for the configured network. */
export class InvalidAddressError extends Error {
  readonly invalidAddresses: string[]

  /**
   * @param {string[]} invalidAddresses - The addresses that failed validation.
   * @param {string} message - A custom error message. Defaults to a message listing `invalidAddresses`.
   */
  constructor(invalidAddresses: string[], message?: string) {
    const defaultMessage = `Invalid address${invalidAddresses.length > 1 ? 'es' : ''}: ${invalidAddresses.join(', ')}.`
    super(message || defaultMessage)
    this.name = 'InvalidAddressError'
    this.invalidAddresses = invalidAddresses
  }
}
