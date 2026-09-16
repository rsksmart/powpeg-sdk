import axios, { type AxiosInstance, type AxiosResponse } from 'axios'
import { TxType } from '../types'
import type { BitcoinDataSource, FeeLevel, Utxo, AddressWithDetails, StatusData, Feature } from '../types'
import { type Network } from '../constants'
import { APIError } from '../errors'
import { assertTruthy, ethers } from '@rsksmart/bridges-core-sdk'

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

const maxErrorMessageLength = 300
const maxRequestTimeoutMs = 2_147_483_647

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

function originOf(url?: string): string | undefined {
  if (!url) {
    return undefined
  }
  try {
    return new URL(url).origin
  }
  catch {
    return undefined
  }
}

/** The URL a response was ultimately served from: `responseURL` on the browser adapter, `res.responseUrl` on Node's. */
function finalUrlOf(response: AxiosResponse): string | undefined {
  const request = response.request as { responseURL?: string, res?: { responseUrl?: string } } | undefined
  return request?.responseURL ?? request?.res?.responseUrl
}

/** Bounds a message coming from the API and strips control characters, so it stays safe to print. */
function sanitizeMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = message.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim()
  if (stripped.length <= maxErrorMessageLength) {
    return stripped
  }
  return `${[...stripped].slice(0, maxErrorMessageLength).join('')}…`
}

function getErrorMessage(data: unknown): string {
  const message = firstNonEmptyString([
    (data as { error?: { message?: unknown } })?.error?.message,
    (data as { message?: unknown })?.message,
  ])
  const sanitized = message ? sanitizeMessage(unwrapJsonMessage(message)) : ''
  return sanitized || 'Server error'
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
  private apiOrigin?: string
  private maxResponseBytes = 10 * 1024 * 1024
  private minBroadcastTimeoutMs = 60_000

  constructor(network: Network, apiUrl?: string, private readonly maxFeeRateSatPerByte = 1000, private readonly requestTimeoutMs = 10_000) {
    assertTruthy(Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= maxRequestTimeoutMs, `requestTimeoutMs must be a positive integer no greater than ${maxRequestTimeoutMs}, got ${requestTimeoutMs}.`)
    const baseURL = apiUrl ?? this.apiUrls[network]
    this.apiOrigin = originOf(baseURL)
    this.api = axios.create({
      baseURL,
      timeout: this.requestTimeoutMs,
      maxContentLength: this.maxResponseBytes,
      maxBodyLength: this.maxResponseBytes,
      maxRedirects: 0,
      adapter: ['xhr', 'http', 'fetch'],
      fetchOptions: { redirect: 'error' },
    })
    this.api.interceptors.request.use((config) => {
      config.signal ??= AbortSignal.timeout(config.timeout || this.requestTimeoutMs)
      return config
    })
    this.api.interceptors.response.use(
      (response) => this.assertSameOrigin(response),
      (error: unknown) => {
        if (axios.isAxiosError(error) && error.response) {
          this.assertSameOrigin(error.response)
        }
        throw error
      },
    )
  }

  /**
   * Rejects a response served by a host other than the configured one. `maxRedirects` is only honoured
   * by the Node adapter, so this covers the browser one, which follows redirects on its own and reports
   * the final URL. Requests the Node adapter serves never reach here with a foreign origin, since a 3xx
   * is surfaced as an error before any redirect is followed.
   */
  private assertSameOrigin(response: AxiosResponse): AxiosResponse {
    const responseOrigin = originOf(finalUrlOf(response))
    if (this.apiOrigin && responseOrigin && responseOrigin !== this.apiOrigin) {
      throw new APIError(`The response came from ${responseOrigin}, not the configured ${this.apiOrigin}.`)
    }
    return response
  }

  private handleError(error: unknown): never {
    if (error instanceof APIError) {
      throw error
    }
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const { status, data } = error.response
        if (status >= 300 && status < 400) {
          throw new APIError(`The API responded with a redirect (${status}); apiUrl must point at the final host.`, status, data)
        }
        throw new APIError(getErrorMessage(data), status, data)
      }
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        throw new APIError(`The API did not respond in time: ${error.message}`)
      }
      if (error.code === 'ERR_CANCELED') {
        throw new APIError(`The API did not answer within the ${error.config?.timeout}ms deadline.`)
      }
      if (error.code === 'ERR_BAD_RESPONSE') {
        throw new APIError(`The API response was rejected: ${error.message}`)
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
    const timeout = Math.max(this.requestTimeoutMs, this.minBroadcastTimeoutMs)
    const response = await this.api.post('/broadcast', { data: hexTx }, { timeout }).catch(this.handleError)
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
