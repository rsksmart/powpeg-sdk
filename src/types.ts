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
