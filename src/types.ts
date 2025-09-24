import { Psbt } from 'bitcoinjs-lib'

export type FeeLevel = 'slow' | 'average' | 'fast'

export interface BitcoinSigner {
  getNonChangeAddresses(bundleSize: number): Promise<string[]>
  getChangeAddresses(bundleSize: number): Promise<string[]>
  signTransaction(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string>
}

export interface BitcoinDataSource {
  getFeeRate(level: FeeLevel): Promise<number>
  getTxHex(txId: string): Promise<string>
  getOutputs(address: string): Promise<Utxo[]>
  broadcast(hexTx: string): Promise<string>
  getAddressDetails(address: string): Promise<AddressWithDetails>
}

export interface AddressWithDetails {
  address: string
  balance: number
  txCount: number
}

export interface Utxo {
  address: string
  txid: string
  amount: bigint
  vout: number
}

export interface PegoutFeeEstimation {
  bitcoinFee: bigint
  rootstockFee: bigint
}

export enum TxType {
  PEGIN = 'PEGIN',
  PEGOUT = 'PEGOUT',
}

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

export const RejectedPegoutReasons = {
  1: 'LOW_AMOUNT',
  2: 'CALLER_CONTRACT',
  3: 'FEE_ABOVE_VALUE',
} as const

export type RejectedPegoutReason = (typeof RejectedPegoutReasons)[keyof typeof RejectedPegoutReasons]

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

export interface PegoutStatusData {
  txDetails: PegoutTxDetails
  type: TxType
}

export interface PeginStatusData {
  txDetails: PeginTxDetails
  type: TxType
}

export interface TxStatusResponse {
  result: PegoutStatusData | PeginStatusData | null
  error: Error | null
}
