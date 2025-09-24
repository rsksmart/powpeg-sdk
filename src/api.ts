import axios, { type AxiosInstance } from 'axios'
import { TxType } from './types'
import type { BitcoinDataSource, FeeLevel, Utxo, AddressWithDetails, StatusData } from './types'
import { type Network } from './constants'
import { APIError } from './errors'

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
    return response.data
  }

  async getTxHex(txId: string): Promise<string> {
    const response = await this.api.get(`/tx/${txId}`).catch(this.handleError)
    return response.data
  }

  async getOutputs(address: string): Promise<Utxo[]> {
    const response = await this.api.post('/utxo', { addressList: [address] }).catch(this.handleError)
    return response.data
  }

  async getAddressDetails(address: string): Promise<AddressWithDetails> {
    const response = await this.api.post('/address-info', { addressList: [address] }).catch(this.handleError)
    return response.data
  }

  async broadcast(hexTx: string): Promise<string> {
    const response = await this.api.post('/broadcast', { data: hexTx }).catch(this.handleError)
    return response.data
  }

  async getTransactionStatus(txHash: string, txType: TxType): Promise<StatusData> {
    const response = await this.api.get(`/tx-status-by-type/${txHash}/${txType}`).catch(this.handleError)
    return response.data
  }
}
