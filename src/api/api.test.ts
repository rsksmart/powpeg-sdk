import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ApiService } from './api'
import { APIError } from '../errors'

const { mockGet, mockIsAxiosError } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockIsAxiosError: vi.fn(),
}))

vi.mock('axios', () => ({
  default: {
    create: () => ({ get: mockGet }),
    isAxiosError: mockIsAxiosError,
  },
}))

let apiService: ApiService

beforeEach(() => {
  vi.clearAllMocks()
  apiService = new ApiService('TEST')
})

describe('ApiService', () => {
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
