import { Psbt } from 'bitcoinjs-lib'

/** Bitcoin network fee rate tier used when estimating/selecting a fee for a transaction. */
export type FeeLevel = 'slow' | 'average' | 'fast'

/**
 * Interface implemented by anything that can derive Bitcoin addresses and sign a transaction
 * on behalf of the SDK — implemented by {@link TrezorSigner} and {@link LedgerSigner}, and
 * accepted as `_bitcoinSigner` by {@link PowPegSDK}.
 */
export interface BitcoinSigner {
  getNonChangeAddresses(bundleSize: number): Promise<string[]>
  getChangeAddresses(bundleSize: number): Promise<string[]>
  signTransaction(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string>
}

/**
 * Interface implemented by anything that can supply Bitcoin chain data (fees, UTXOs, address
 * details, broadcast) to {@link PowPegSDK}. If not provided to the SDK, the bundled API client
 * is used instead.
 */
export interface BitcoinDataSource {
  getFeeRate(level: FeeLevel): Promise<number>
  getTxHex(txId: string): Promise<string>
  getOutputs(address: string): Promise<Utxo[]>
  broadcast(hexTx: string): Promise<string>
  getAddressDetails(address: string): Promise<AddressWithDetails>
}

/** A Bitcoin address along with its current balance and transaction count. */
export interface AddressWithDetails {
  address: string
  balance: number
  txCount: number
}

/** An unspent transaction output (UTXO) available to fund a transaction. */
export interface Utxo {
  address: string
  txid: string
  amount: bigint
  vout: number
}

/** Estimated fees for a peg-out, as returned by {@link PowPegSDK.estimatePegoutFees}. */
export interface PegoutFeeEstimation {
  bitcoinFee: bigint
  rootstockFee: bigint
}

/** Distinguishes a peg-in (BTC -> RSK) from a peg-out (RSK -> BTC) transaction. */
export enum TxType {
  PEGIN = 'PEGIN',
  PEGOUT = 'PEGOUT',
}

/** Possible statuses of a peg-out transaction, as reported by the 2WP API. */
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

/** Possible statuses of a peg-in transaction, as reported by the 2WP API. */
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

/** Maps the bridge contract's numeric rejection codes to a human-readable reason. */
export const RejectedPegoutReasons = {
  1: 'LOW_AMOUNT',
  2: 'CALLER_CONTRACT',
  3: 'FEE_ABOVE_VALUE',
} as const

/** A human-readable reason a peg-out was rejected by the bridge. See {@link RejectedPegoutReasons}. */
export type RejectedPegoutReason = (typeof RejectedPegoutReasons)[keyof typeof RejectedPegoutReasons]

/** Details of a peg-in transaction, as returned by {@link PowPegSDK.getTransactionStatus}. */
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

/** Details of a peg-out transaction, as returned by {@link PowPegSDK.getTransactionStatus}. */
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

/** A peg-out transaction status result, tagged with its {@link TxType}. */
export interface PegoutStatusData {
  type: TxType.PEGOUT
  txDetails: PegoutTxDetails
}

/** A peg-in transaction status result, tagged with its {@link TxType}. */
export interface PeginStatusData {
  type: TxType.PEGIN
  txDetails: PeginTxDetails
}

/** The result of {@link PowPegSDK.getTransactionStatus}, discriminated by `type`. */
export type StatusData = PegoutStatusData | PeginStatusData

/** A funded but unsigned peg-in PSBT, along with the data needed to sign and broadcast it. */
export interface UnsignedPegin {
  psbt: Psbt
  inputs: Utxo[]
  transactions: string[]
  fee: number
}
