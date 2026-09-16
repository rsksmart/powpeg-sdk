import type { ethers } from '@rsksmart/bridges-core-sdk'

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

/** Thrown when the configured BitcoinSigner doesn't return what the SDK asked it for: no derived addresses, or no signed transaction to broadcast. */
export class SigningError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'SigningError'
  }
}

/** Thrown when a fee rate from the configured BitcoinDataSource is missing, non-numeric, non-positive, exceeds the configured bound, or produces a fee disproportionate to the amount being sent. */
export class InvalidFeeRateError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'InvalidFeeRateError'
  }
}

/** Thrown when the signer's chain doesn't match the network the SDK was configured for. */
export class WrongNetworkError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'WrongNetworkError'
  }
}

/**
 * Thrown when the peg-out transaction was mined but the Bridge rejected the release request instead of
 * queueing it. `reason` carries the Bridge's own code: 1 the amount was below its minimum, 2 the caller
 * is a contract, 3 the fee would exceed the amount. Reasons 1 and 3 refund the amount; **reason 2 does
 * not** — the Bridge keeps it. `txHash` is the mined transaction, kept on the error because it is the
 * only handle to an on-chain transaction the caller has already paid for.
 */
export class PegoutRejectedError extends Error {
  readonly reason: number
  readonly txHash: string
  readonly amount: bigint

  constructor(reason: number, txHash: string, amount: bigint, message?: string) {
    super(message)
    this.name = 'PegoutRejectedError'
    this.reason = reason
    this.txHash = txHash
    this.amount = amount
  }
}

/**
 * Thrown when the account asked to send a peg-out cannot receive BTC for it. The Bridge only releases
 * BTC for release requests that arrive from an externally owned account, so a contract account is
 * refused before any value is sent.
 */
export class UnsupportedSenderError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'UnsupportedSenderError'
  }
}

/**
 * Thrown when the peg-out transaction was mined but reverted, so the Bridge never recorded a release
 * request and no BTC will be released. This is distinct from {@link PegoutRejectedError}, which the
 * Bridge raises from a transaction that succeeded. `txHash` and `receipt` are kept on the error because
 * the caller has already paid the gas and needs both to account for it without a second round trip.
 */
export class TransactionRevertedError extends Error {
  readonly txHash: string
  readonly receipt: ethers.providers.TransactionReceipt

  constructor(txHash: string, receipt: ethers.providers.TransactionReceipt, message?: string) {
    super(message)
    this.name = 'TransactionRevertedError'
    this.txHash = txHash
    this.receipt = receipt
  }
}

/**
 * Thrown when a UTXO is held by an address whose type the SDK cannot build a signable PSBT input for.
 * A P2SH input needs a redeem script derived from the public key behind the address, and `BitcoinSigner`
 * exposes addresses only.
 */
export class UnsupportedAddressTypeError extends Error {
  readonly address: string

  constructor(address: string, message?: string) {
    super(message)
    this.name = 'UnsupportedAddressTypeError'
    this.address = address
  }
}
