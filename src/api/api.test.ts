import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ApiService } from './api'
import { APIError } from '../errors'

const { mockGet, mockPost, mockIsAxiosError, mockCreate, mockUse } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockIsAxiosError: vi.fn(),
  mockCreate: vi.fn(),
  mockUse: vi.fn(),
}))

vi.mock('axios', () => ({
  default: {
    create: (...args: unknown[]) => {
      mockCreate(...args)
      return { get: mockGet, post: mockPost, interceptors: { response: { use: mockUse } } }
    },
    isAxiosError: mockIsAxiosError,
  },
}))

let apiService: ApiService

beforeEach(() => {
  vi.clearAllMocks()
  apiService = new ApiService('TEST')
})

describe('ApiService', () => {
  it('should create the HTTP client with transport limits and redirects disabled', () => {
    new ApiService('TEST')

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://api.2wp.testnet.rootstock.io',
      timeout: 10_000,
      maxContentLength: 10 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
      maxRedirects: 0,
    }))
  })

  it('should throw API Error with status and message from response', async () => {
    const errorResponse = {
      response: {
        status: 400,
        data: { message: 'Bad request' },
      },
    }
    mockIsAxiosError.mockReturnValue(true)
    mockGet.mockRejectedValue(errorResponse)

    await expect(apiService.getFeeRate('fast')).rejects.toThrow(APIError)
    await expect(apiService.getFeeRate('fast')).rejects.toThrow('Bad request')
  })

  it('should throw API Error with the message the 2WP API nests under `error`', async () => {
    const errorResponse = {
      response: {
        status: 400,
        data: { error: { statusCode: 400, name: 'BadRequestError', message: 'Invalid data "abc" for parameter "block".', code: 'INVALID_PARAMETER_VALUE' } },
      },
    }
    mockIsAxiosError.mockReturnValue(true)
    mockGet.mockRejectedValue(errorResponse)

    await expect(apiService.getFeeRate('fast')).rejects.toThrow(APIError)
    await expect(apiService.getFeeRate('fast')).rejects.toThrow('Invalid data "abc" for parameter "block".')
  })

  it('should fall back to a generic message when the error body carries no message string', async () => {
    const errorResponse = {
      response: {
        status: 500,
        data: { error: { code: 7 } },
      },
    }
    mockIsAxiosError.mockReturnValue(true)
    mockGet.mockRejectedValue(errorResponse)

    await expect(apiService.getFeeRate('fast')).rejects.toThrow('Server error')
    await expect(apiService.getFeeRate('fast')).rejects.not.toThrow('[object Object]')
  })

  it('should unwrap a message that carries a serialized JSON document', async () => {
    const errorResponse = {
      response: {
        status: 400,
        data: { error: { statusCode: 400, name: 'Error', message: '{"error":"Transaction \'aaaa\' not found"}' } },
      },
    }
    mockIsAxiosError.mockReturnValue(true)
    mockGet.mockRejectedValue(errorResponse)

    await expect(apiService.getFeeRate('fast')).rejects.toThrow(/^Transaction 'aaaa' not found$/)
  })

  it('should keep a message that only looks like JSON as it came', async () => {
    const errorResponse = {
      response: {
        status: 400,
        data: { error: { message: '{not really json' } },
      },
    }
    mockIsAxiosError.mockReturnValue(true)
    mockGet.mockRejectedValue(errorResponse)

    await expect(apiService.getFeeRate('fast')).rejects.toThrow('{not really json')
  })

  it('should name the redirect when the API answers with one', async () => {
    const errorResponse = {
      response: {
        status: 302,
        data: '',
      },
    }
    mockIsAxiosError.mockReturnValue(true)
    mockGet.mockRejectedValue(errorResponse)

    await expect(apiService.getFeeRate('fast')).rejects.toThrow('responded with a redirect (302)')
    await expect(apiService.getFeeRate('fast')).rejects.not.toThrow('Server error')
  })

  describe('response origin', () => {
    const interceptor = () => mockUse.mock.calls[0][0] as (response: unknown) => unknown
    const responseFrom = (url?: string) => ({
      status: 200,
      data: { federationAddress: 'whatever' },
      request: url ? { responseURL: url } : undefined,
    })

    it('should pass a response served by the configured host', () => {
      const response = responseFrom('https://api.2wp.testnet.rootstock.io/pegin-configuration')

      expect(interceptor()(response)).toBe(response)
    })

    it('should reject a response served by another host', () => {
      expect(() => interceptor()(responseFrom('https://elsewhere.example/pegin-configuration')))
        .toThrowError(APIError)
      expect(() => interceptor()(responseFrom('https://elsewhere.example/pegin-configuration')))
        .toThrowError('came from https://elsewhere.example')
    })

    it('should pass a response whose final URL cannot be determined', () => {
      const response = responseFrom()

      expect(interceptor()(response)).toBe(response)
    })
  })

  it('should name a timeout instead of reporting it as no response', async () => {
    mockIsAxiosError.mockReturnValue(true)
    mockGet.mockRejectedValue({ code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded', request: {} })

    await expect(apiService.getFeeRate('fast')).rejects.toThrow('The API did not respond in time')
    await expect(apiService.getFeeRate('fast')).rejects.not.toThrow('No response from server')
  })

  it('should use the configured request timeout', () => {
    new ApiService('TEST', undefined, 1000, 2_500)

    expect(mockCreate).toHaveBeenLastCalledWith(expect.objectContaining({ timeout: 2_500 }))
  })

  it('should throw API Error for network errors', async () => {
    const errorRequest = { request: {} }
    mockIsAxiosError.mockReturnValue(true)
    mockGet.mockRejectedValue(errorRequest)

    await expect(apiService.getFeeRate('fast')).rejects.toThrow(APIError)
    await expect(apiService.getFeeRate('fast')).rejects.toThrow('No response from server')
  })

  it('should throw API Error for unexpected errors', async () => {
    mockIsAxiosError.mockReturnValue(false)
    mockGet.mockRejectedValue('Unknown error')

    await expect(apiService.getFeeRate('fast')).rejects.toThrow(APIError)
  })

  describe('getFeeRate', () => {
    it('should round fractional rates up instead of truncating', async () => {
      mockGet.mockResolvedValue({ data: { amount: '0.00001249' } }) // 1.249 sat/B

      await expect(apiService.getFeeRate('fast')).resolves.toBe(2)
    })

    it('should never return a zero rate for a small positive input', async () => {
      mockGet.mockResolvedValue({ data: { amount: '0.00000999' } }) // 0.999 sat/B

      await expect(apiService.getFeeRate('fast')).resolves.toBe(1)
    })

    it('should return whole rates unchanged', async () => {
      mockGet.mockResolvedValue({ data: { amount: '0.00002000' } }) // 2 sat/B

      await expect(apiService.getFeeRate('fast')).resolves.toBe(2)
    })

    it.each(['0', '-0.00001', 'not-a-number', ''])('should throw APIError for invalid rate %s', async (amount) => {
      mockGet.mockResolvedValue({ data: { amount } })

      await expect(apiService.getFeeRate('fast')).rejects.toThrow(APIError)
    })

    it('should throw APIError for an implausibly high rate', async () => {
      mockGet.mockResolvedValue({ data: { amount: '10' } }) // 1,000,000 sat/B

      await expect(apiService.getFeeRate('fast')).rejects.toThrow(APIError)
    })

    it('should honor a custom maxFeeRateSatPerByte passed to the constructor', async () => {
      const customApiService = new ApiService('TEST', undefined, 2000)
      mockGet.mockResolvedValue({ data: { amount: '0.015' } }) // 1500 sat/B

      await expect(customApiService.getFeeRate('fast')).resolves.toBe(1500)
      await expect(apiService.getFeeRate('fast')).rejects.toThrow(APIError)
    })
  })

  describe('getOutputs', () => {
    it('should return the queried address on each UTXO regardless of the address in the response', async () => {
      const queriedAddress = 'tb1qm0f4nu37q8u82txpj0l0cp924836gs2q4m9rdf'
      const responseAddress = 'tb1qattacker0000000000000000000000000000000'
      mockPost.mockResolvedValue({
        data: {
          data: [
            { address: responseAddress, txid: 'tx1', vout: 0, amount: '0.01', satoshis: 1_000_000, height: 1, confirmations: 6 },
            { address: responseAddress, txid: 'tx2', vout: 1, amount: '0.02', satoshis: 2_000_000, height: 1, confirmations: 6 },
          ],
        },
      })

      const utxos = await apiService.getOutputs(queriedAddress)

      expect(utxos).toHaveLength(2)
      utxos.forEach((utxo) => expect(utxo.address).toBe(queriedAddress))
      expect(mockPost).toHaveBeenCalledWith('/utxo', { addressList: [queriedAddress] })
    })
  })

  describe('getAddressDetails', () => {
    it('should return the queried address regardless of the address in the response', async () => {
      const queriedAddress = 'tb1qm0f4nu37q8u82txpj0l0cp924836gs2q4m9rdf'
      const responseAddress = 'tb1qattacker0000000000000000000000000000000'
      mockPost.mockResolvedValue({
        data: {
          addressesInfo: [{ address: responseAddress, balance: 1_000_000, txs: 3 }],
        },
      })

      const details = await apiService.getAddressDetails(queriedAddress)

      expect(details.address).toBe(queriedAddress)
      expect(details.balance).toBe(1_000_000)
      expect(details.txCount).toBe(3)
      expect(mockPost).toHaveBeenCalledWith('/addresses-info', { addressList: [queriedAddress] })
    })
  })

  describe('getPeginConfiguration', () => {
    it('should return the pegin configuration from the API', async () => {
      const configuration = {
        minValue: 500_000,
        maxValue: 4_199_866_190_155_915,
        federationAddress: '3GX89qzyQVaJqUJjq5noZbLJEHuYDvVrHq',
        btcConfirmations: 100,
      }
      mockGet.mockResolvedValue({ data: configuration })

      await expect(apiService.getPeginConfiguration()).resolves.toEqual(configuration)
      expect(mockGet).toHaveBeenCalledWith('/pegin-configuration')
    })

    it('should throw API Error when the request fails', async () => {
      mockIsAxiosError.mockReturnValue(true)
      mockGet.mockRejectedValue({ request: {} })

      await expect(apiService.getPeginConfiguration()).rejects.toThrow(APIError)
    })
  })

  describe('getFeatures', () => {
    const feature = (name: string, value: string) => ({
      name,
      value,
      version: 1,
    })

    it('should return the features exposed by the API', async () => {
      const features = [
        feature('flyover', 'enabled'),
        feature('union_bridge', 'disabled'),
        feature('powpeg', 'enabled'),
        feature('new_provider', 'enabled'),
      ]
      mockGet.mockResolvedValue({ data: features })

      await expect(apiService.getFeatures()).resolves.toEqual(features)
      expect(mockGet).toHaveBeenCalledWith('/features')
    })

    it('should throw API Error when the request fails', async () => {
      mockIsAxiosError.mockReturnValue(true)
      mockGet.mockRejectedValue({ request: {} })

      await expect(apiService.getFeatures()).rejects.toThrow(APIError)
    })
  })
})
