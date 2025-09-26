import axios, { type AxiosInstance } from 'axios'
import { TxType } from '../types'
import type { BitcoinDataSource, FeeLevel, Utxo, AddressWithDetails, StatusData } from '../types'
import { type Network } from '../constants'
import { APIError } from '../errors'
import { ethers } from '@rsksmart/bridges-core-sdk'

type UtxoResponse2WP = {
  data: {
    address: string
    txid: string
    vout: number
    amount: string
    satoshis: number
    height: number
    confirmations: number
  }[]
}

export class ApiService implements BitcoinDataSource {
  private apiUrls: Record<Network, string> = {
    MAIN: 'https://api.2wp.rootstock.io',
    TEST: 'https://api.2wp.testnet.rootstock.io',
  }
  private feeLevelBlocks = {
    slow: 5,
    average: 3,
    fast: 1,
  }
  private api: AxiosInstance

  constructor(network: Network, apiUrl?: string) {
    this.api = axios.create({ baseURL: apiUrl ?? this.apiUrls[network] })
  }

  private handleError(error: unknown): never {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const { status, data } = error.response
        const message = data?.message || 'Server error'
        throw new APIError(message, status, data)
      }
      if (error.request) {
        throw new APIError('No response from server')
      }
    }
    if (error instanceof Error) {
      throw new APIError(error.message)
    }
    throw new APIError('Unexpected error')
  }

  async getFeeRate(level: FeeLevel): Promise<number> {
    const blocks = this.feeLevelBlocks[level]
    const response = await this.api.get(`/estimate-fee/${blocks}`).catch(this.handleError)
    // BTC/kB -> sat/B
    const rate = ethers.utils.parseUnits(response.data.amount, 8).div(1000).toNumber()
    return rate
  }

  async getTxHex(txId: string): Promise<string> {
    const response = await this.api.get(`/tx?tx=${txId}`).catch(this.handleError)
    return response.data.hex
  }

  async getOutputs(address: string): Promise<Utxo[]> {
    const response = await this.api.post<UtxoResponse2WP>('/utxo', { addressList: [address] }).catch(this.handleError)
    const { data: utxos } = response.data
    return utxos.map(({ address, txid, vout, satoshis }) => ({
      address,
      txid,
      amount: BigInt(satoshis),
      vout,
    }))
  }

  async getAddressDetails(address: string): Promise<AddressWithDetails> {
    const response = await this.api.post('/addresses-info', { addressList: [address] }).catch(this.handleError)
    const [details] = response.data.addressesInfo
    return {
      address: details.address,
      balance: details.balance,
      txCount: details.txs,
    }
  }

  async broadcast(hexTx: string): Promise<string> {
    const response = await this.api.post('/broadcast', { data: hexTx }).catch(this.handleError)
    return response.data.txId
  }

  async getTransactionStatus<T extends TxType>(txHash: string, txType: T): Promise<Extract<StatusData, { type: T }>> {
    const response = await this.api.get(`/tx-status-by-type/${txHash}/${txType}`).catch(this.handleError)
    return response.data
  }
}
