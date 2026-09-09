import axios, { type AxiosInstance } from 'axios'
import { TxType } from '../types'
import type { BitcoinDataSource, FeeLevel, Utxo, AddressWithDetails, StatusData, Feature } from '../types'
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

function firstNonEmptyString(candidates: unknown[]): string | undefined {
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
}

/** Some endpoints answer with a JSON document serialized into the message field; one level is unwrapped so the message reads as text. */
function unwrapJsonMessage(message: string): string {
  if (!message.startsWith('{')) {
    return message
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  }
  catch {
    return message
  }
  return firstNonEmptyString([
    (parsed as { error?: unknown })?.error,
    (parsed as { message?: unknown })?.message,
  ]) ?? message
}

function getErrorMessage(data: unknown): string {
  const message = firstNonEmptyString([
    (data as { error?: { message?: unknown } })?.error?.message,
    (data as { message?: unknown })?.message,
  ])
  return message ? unwrapJsonMessage(message) : 'Server error'
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
  private requestTimeoutMs = 10_000
  private maxResponseBytes = 10 * 1024 * 1024

  constructor(network: Network, apiUrl?: string, private readonly maxFeeRateSatPerByte = 1000) {
    this.api = axios.create({
      baseURL: apiUrl ?? this.apiUrls[network],
      timeout: this.requestTimeoutMs,
      maxContentLength: this.maxResponseBytes,
      maxBodyLength: this.maxResponseBytes,
      maxRedirects: 0,
    })
  }

  private handleError(error: unknown): never {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const { status, data } = error.response
        if (status >= 300 && status < 400) {
          throw new APIError(`The API responded with a redirect (${status}); apiUrl must point at the final host.`, status, data)
        }
        throw new APIError(getErrorMessage(data), status, data)
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
    let satoshisPerKb: ethers.BigNumber
    try {
      satoshisPerKb = ethers.utils.parseUnits(String(response.data.amount), 8)
    }
    catch {
      throw new APIError(`Invalid fee rate received: ${response.data.amount}`)
    }
    if (satoshisPerKb.lte(0)) {
      throw new APIError(`Invalid fee rate received: ${response.data.amount}`)
    }
    if (satoshisPerKb.gt(this.maxFeeRateSatPerByte * 1000)) {
      throw new APIError(`Fee rate out of bounds: ${response.data.amount}`)
    }
    // BTC/kB -> sat/B, rounded up
    return satoshisPerKb.add(999).div(1000).toNumber()
  }

  async getTxHex(txId: string): Promise<string> {
    const response = await this.api.get(`/tx?tx=${txId}`).catch(this.handleError)
    return response.data.hex
  }

  async getOutputs(address: string): Promise<Utxo[]> {
    const response = await this.api.post<UtxoResponse2WP>('/utxo', { addressList: [address] }).catch(this.handleError)
    const { data: utxos } = response.data
    return utxos.map(({ txid, vout, satoshis }) => ({
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
      address,
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

  async getPeginConfiguration(): Promise<{ minValue: number, maxValue: number, federationAddress: string, btcConfirmations: number }> {
    const response = await this.api.get('/pegin-configuration').catch(this.handleError)
    return response.data
  }

  async getFeatures(): Promise<Feature[]> {
    const response = await this.api.get<Feature[]>('/features').catch(this.handleError)
    return response.data
  }
}
