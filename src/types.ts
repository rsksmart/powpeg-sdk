import { Psbt } from 'bitcoinjs-lib'
import type { ethers } from '@rsksmart/bridges-core-sdk'
import type { Network } from './constants'

/** Configuration for {@link PowPegSDK}. Only `network` is required. */
export interface PowPegSDKOptions {
  /** `'MAIN'` or `'TEST'` — selects the Bitcoin network params, the Rootstock chain id and the default endpoints. */
  network: Network
  /** Signs peg-in transactions and derives the addresses they are funded from. Needed only for operations that sign. */
  bitcoinSigner?: BitcoinSigner
  /** Fee rates, UTXOs, raw transactions, broadcast and transaction status. Defaults to the built-in 2WP API-backed source. */
  bitcoinDataSource?: BitcoinDataSource
  /** Rootstock JSON-RPC endpoint. Defaults to the public node for `network`. */
  rpcProviderUrl?: string
  /** 2WP API endpoint. Defaults to the production API for `network`. */
  apiUrl?: string
  /** Addresses to derive per `BitcoinSigner` call while creating a peg-in. Defaults to 10. */
  maxBundleSize?: number
  /** Change below this many satoshis is dropped into the fee instead of added as an output. Defaults to 2000. */
  burnDustValue?: number
  /** Upper bound, in sat/B, for a fee rate coming from the configured `BitcoinDataSource`. Defaults to 1000. */
  maxFeeRateSatPerByte?: number
  /** Upper bound for the ratio of total fee to peg-in amount. Defaults to 0.5. */
  maxFeeToAmountRatio?: number
  /** Milliseconds before a request to the API is aborted. Defaults to 10000. */
  requestTimeoutMs?: number
}

/** Priority level used to look up a Bitcoin network fee rate. */
export type FeeLevel = 'slow' | 'average' | 'fast'

/**
 * Contract that a Bitcoin signing backend must implement
 * so {@link PowPegSDK} can derive addresses and sign peg-in transactions with it.
 */
export interface BitcoinSigner {
  getNonChangeAddresses(bundleSize: number): Promise<string[]>
  getChangeAddresses(bundleSize: number): Promise<string[]>
  signTransaction(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string>
}

/**
 * Contract for a Bitcoin data provider (fee rates, UTXOs, raw transactions, broadcasting).
 * {@link PowPegSDK} falls back to its built-in 2WP API-backed implementation when none is supplied.
 */
export interface BitcoinDataSource {
  /** Fee rate in sat/B. Must be a positive integer: a fractional rate is rejected as implausible. */
  getFeeRate(level: FeeLevel): Promise<number>
  getTxHex(txId: string): Promise<string>
  getOutputs(address: string): Promise<Utxo[]>
  broadcast(hexTx: string): Promise<string>
  getAddressDetails(address: string): Promise<AddressWithDetails>
}

/** A Bitcoin address together with its current balance and transaction count. */
export interface AddressWithDetails {
  address: string
  balance: number
  txCount: number
}

/** A spendable Bitcoin unspent transaction output. */
export interface Utxo {
  address: string
  txid: string
  amount: bigint
  vout: number
}

/** Estimated Bitcoin and Rootstock fees for a peg-out. */
export interface PegoutFeeEstimation {
  bitcoinFee: bigint
  rootstockFee: bigint
}

/** Browser support flags for a feature, as reported by the 2WP API. */
export interface SupportedBrowsers {
  chrome: boolean
  firefox: boolean
  safari: boolean
  edge: boolean
  brave: boolean
  chromium: boolean
  opera: boolean
}

/** A feature flag entry returned by the 2WP API `/features` endpoint. */
export interface Feature {
  name: string
  value: string
  version: number
  supportedBrowsers?: SupportedBrowsers
}

/** Distinguishes a peg-in (BTC -> RBTC) from a peg-out (RBTC -> BTC) transaction. */
export enum TxType {
  PEGIN = 'PEGIN',
  PEGOUT = 'PEGOUT',
}

/** Lifecycle status of a peg-out transaction, as reported by the 2WP API. */
export enum PegoutStatuses {
  RECEIVED = 'RECEIVED',
  REJECTED = 'REJECTED',
  WAITING_FOR_CONFIRMATION = 'WAITING_FOR_CONFIRMATION',
  WAITING_FOR_SIGNATURE = 'WAITING_FOR_SIGNATURE',
  SIGNED = 'SIGNED',
  NOT_FOUND = 'NOT_FOUND',
  PENDING = 'PENDING',
  NOT_PEGOUT_TX = 'NOT_PEGOUT_TX',
  RELEASE_BTC = 'RELEASE_BTC',
}

/** Lifecycle status of a peg-in transaction, as reported by the 2WP API. */
export enum PeginStatuses {
  NOT_IN_BTC_YET = 'NOT_IN_BTC_YET',
  WAITING_CONFIRMATIONS = 'WAITING_CONFIRMATIONS',
  NOT_IN_RSK_YET = 'NOT_IN_RSK_YET',
  CONFIRMED = 'CONFIRMED',
  REJECTED_NO_REFUND = 'REJECTED_NO_REFUND',
  REJECTED_REFUND = 'REJECTED_REFUND',
  ERROR_NOT_A_PEGIN = 'ERROR_NOT_A_PEGIN',
  ERROR_BELOW_MIN = 'ERROR_BELOW_MIN',
  ERROR_UNEXPECTED = 'ERROR_UNEXPECTED',
}

/** Maps the bridge's numeric rejection codes to a human-readable peg-out rejection reason. */
export const RejectedPegoutReasons = {
  1: 'LOW_AMOUNT',
  2: 'CALLER_CONTRACT',
  3: 'FEE_ABOVE_VALUE',
} as const

/** A human-readable reason a peg-out was rejected, as reported by the 2WP API. */
export type RejectedPegoutReason = (typeof RejectedPegoutReasons)[keyof typeof RejectedPegoutReasons]

/** Bitcoin and Rootstock-side details of a peg-in transaction. */
export interface PeginTxDetails {
  btc: {
    txId: string
    creationDate: string
    federationAddress: string
    amountTransferred: number
    fees: number
    refundAddress: string
    confirmations: number
    requiredConfirmation: number
    btcWTxId: string
    senderAddress: string
  }
  rsk: {
    recipientAddress: string
  }
  status: PeginStatuses
}

/** Details of a peg-out transaction, including its Bitcoin release once processed. */
export interface PegoutTxDetails {
  originatingRskTxHash: string
  rskTxHash: string
  rskSenderAddress: string
  btcRecipientAddress: string
  valueRequestedInSatoshis: number
  valueInSatoshisToBeReceived: number
  feeInSatoshisToBePaid: number
  status: PegoutStatuses
  btcRawTransaction: string
  reason?: RejectedPegoutReason
}

/** Status payload for a peg-out transaction, as returned by {@link PowPegSDK.getTransactionStatus}. */
export interface PegoutStatusData {
  type: TxType.PEGOUT
  txDetails: PegoutTxDetails
}

/** Status payload for a peg-in transaction, as returned by {@link PowPegSDK.getTransactionStatus}. */
export interface PeginStatusData {
  type: TxType.PEGIN
  txDetails: PeginTxDetails
}

/** Discriminated union of the two possible {@link PowPegSDK.getTransactionStatus} payloads. */
export type StatusData = PegoutStatusData | PeginStatusData

/**
 * An unsigned peg-out transaction request, as returned by {@link PowPegSDK.createPegout}.
 * Extends ethers' own request type, so gas, nonce and fee fields a caller sets are carried through to the
 * signer. `customData` and `ccipReadEnabled` are excluded because neither survives ethers' own transaction
 * serialization, on either signer type.
 */
export interface UnsignedPegout extends Omit<ethers.providers.TransactionRequest, 'customData' | 'ccipReadEnabled'> {
  from: string
  to: string
  value: string
  /** Chain the request targets. Filled in with the SDK's configured chain when omitted, and rejected when it names another chain. */
  chainId?: number
}

/** An unsigned, fee-funded peg-in PSBT ready to be signed, as returned by {@link PowPegSDK.createAndFundPegin}. */
export interface UnsignedPegin {
  psbt: Psbt
  inputs: Utxo[]
  transactions: string[]
  fee: number
}
