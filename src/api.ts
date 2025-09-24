import axios from 'axios'
import { TxType, type TxStatusResponse } from './types'
import { type Network } from './constants'

export class ApiService {
  private apiUrls: Record<Network, string> = {
    MAIN: 'https://api.2wp.rootstock.io',
    TEST: 'https://api.2wp.testnet.rootstock.io',
  }

  apiUrl: string
  constructor(network: Network, _apiUrl?: string) {
    this.apiUrl = _apiUrl ?? this.apiUrls[network]
  }

  async getTransactionStatus(txHash: string, txType: TxType): Promise<TxStatusResponse> {
    try {
      const response = await axios.get(`${this.apiUrl}/tx-status-by-type/${txHash}/${txType}`)

      if (!response.data) {
        return { result: null, error: new Error('No data was returned') }
      }

      if (!response.data.type) {
        return { result: null, error: new Error('Empty response from server') }
      }

      if (response.data.type !== TxType.PEGIN && response.data.type !== TxType.PEGOUT) {
        return { result: null, error: new Error(`Transaction has invalid type ${response.data.type}`) }
      }

      return { result: response.data, error: null }
    }
    catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
          return { result: null, error: new Error('Network connection failed') }
        }
        if (error.response) {
          return { result: null, error: new Error(`Server error: ${error.response.status} ${error.response.statusText}`) }
        }
        if (error.request) {
          return { result: null, error: new Error('No response from server') }
        }
      }
      return { result: null, error: new Error(`Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`) }
    }
  }
}
