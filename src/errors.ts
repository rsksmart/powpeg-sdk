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
