export class AmountBelowMinError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AmountBelowMinError'
  }
}

export class NotEnoughFundsError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'NotEnoughFundsError'
  }
}

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

export class InvalidAddressError extends Error {
  readonly invalidAddresses: string[]

  constructor(invalidAddresses: string[], message?: string) {
    const defaultMessage = `Invalid address${invalidAddresses.length > 1 ? 'es' : ''}: ${invalidAddresses.join(', ')}.`
    super(message || defaultMessage)
    this.name = 'InvalidAddressError'
    this.invalidAddresses = invalidAddresses
  }
}
