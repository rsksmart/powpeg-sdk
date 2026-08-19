/** Thrown when a requested peg-in or peg-out amount is below the protocol's minimum allowed amount. */
export class AmountBelowMinError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AmountBelowMinError'
  }
}

/** Thrown when the available UTXOs/balance can't cover the requested amount plus fees. */
export class NotEnoughFundsError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'NotEnoughFundsError'
  }
}

/** Thrown when the 2WP API responds with an error, a failed request, or an unexpected failure. */
export class APIError extends Error {
  readonly statusCode?: number
  readonly data?: unknown

  constructor(message: string, statusCode?: number, data?: unknown) {
    super(message)
    this.name = 'APIError'
    this.statusCode = statusCode
    this.data = data
  }
}

/** Thrown when the federation address can't be retrieved from the pegin configuration endpoint or doesn't match the Bridge contract's value. */
export class FederationAddressError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'FederationAddressError'
  }
}

/** Thrown when one or more addresses are invalid: a Bitcoin address that doesn't belong to the SDK's configured network, or a malformed Rootstock recipient address. */
export class InvalidAddressError extends Error {
  readonly invalidAddresses: string[]

  constructor(invalidAddresses: string[], message?: string) {
    const defaultMessage = `Invalid address${invalidAddresses.length > 1 ? 'es' : ''}: ${invalidAddresses.join(', ')}.`
    super(message || defaultMessage)
    this.name = 'InvalidAddressError'
    this.invalidAddresses = invalidAddresses
  }
}
