import axios from 'axios'
import { TxType, type TxStatusResponse } from './types'

export class ApiService {
  apiUrl: string
  constructor(apiUrl: string) {
    this.apiUrl = apiUrl
  }

  async getTransactionStatus(txHash: string, txType: TxType): Promise<TxStatusResponse> {
    const response = await axios.get(`${this.apiUrl}/tx-status-by-type/${txHash}/${txType}`)
    let error = null
    if (!response.data) {
      error = new Error('No data was returned')
    }
    if (!response.data.type) {
      error = new Error('Empty response from server')
    }
    if (response.data.type !== TxType.PEGIN && response.data.type !== TxType.PEGOUT) {
      error = new Error(`Transaction has invalid type ${response.data.type}`)
    }
    return { result: response.data, error }
  }
}
