import { describe, expect, it, vi, beforeEach } from 'vitest'
import { PowPegSDK } from './powpeg'
import type { BitcoinSigner, BitcoinDataSource } from '../types'
import { AmountBelowMinError, NotEnoughFundsError } from '../errors'
import { ethers } from '@rsksmart/bridges-core-sdk'
import { TxType, PegoutStatuses, PeginStatuses } from '../types'

const btcAddresses = [
  'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
  'n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi',
  'mgnucj8nYqdrPFh2JfZSB1NmUThUGnmsqe',
  '2N7eSt5myGSXoiAnqpzu856EwgA8SHg53Lg',
  'tb1qm0f4nu37q8u82txpj0l0cp924836gs2q4m9rdf',
]

const rskAddresses = [
  '0x8c2f0abf2b1c4d4f7f5b6e3c3f2a6b7f7c7c1d9d',
]

const mockValues = {
  federationAddress: '2MskK2P1Qw9QbeZ6MG5jmeWMX2d4MFANgkD',
  estimatedFeeForNextPegOut: ethers.BigNumber.from(45_500n),
  queuedPegoutsCount: ethers.BigNumber.from(2n),
  highBalance: ethers.BigNumber.from(1_000_000_000_000_000_000n),
  mediumBalance: ethers.BigNumber.from(100_000_000_000_000n),
  lowBalance: ethers.BigNumber.from(95_020_024_416_166n),
  estimatedGas: ethers.BigNumber.from(50_000n),
  gasPrice: ethers.BigNumber.from(6_000_123n),
  bitcoinFeeRate: 1,
}

const createMockProvider = (balance = mockValues.highBalance) => ({
  ...Object.create(ethers.providers.JsonRpcProvider.prototype),
  getBalance: vi.fn().mockResolvedValue(balance),
  estimateGas: vi.fn().mockResolvedValue(mockValues.estimatedGas),
  getGasPrice: vi.fn().mockResolvedValue(mockValues.gasPrice),
})

const mockProvider = createMockProvider()

const mockApiService = {
  getTransactionStatus: vi.fn(),
}

vi.mock('../api/api', async () => {
  const { TxType, PegoutStatuses, PeginStatuses } = await import('../types')
  return {
    ApiService: vi.fn().mockImplementation(() => mockApiService),
    TxType,
    PegoutStatuses,
    PeginStatuses,
  }
})

vi.mock('@rsksmart/bridges-core-sdk', async () => {
  const original = await vi.importActual<typeof import('@rsksmart/bridges-core-sdk')>('@rsksmart/bridges-core-sdk')
  return {
    ...original,
    ethers: {
      ...original.ethers,
      Contract: vi.fn(() => ({
        ...ethers.Contract.prototype,
        getFederationAddress: vi.fn().mockResolvedValue(mockValues.federationAddress),
        getEstimatedFeesForNextPegOutEvent: vi.fn().mockResolvedValue(mockValues.estimatedFeeForNextPegOut),
        getQueuedPegoutsCount: vi.fn().mockResolvedValue(mockValues.queuedPegoutsCount),
      })),
      providers: {
        JsonRpcProvider: vi.fn().mockImplementation(() => mockProvider),
      },
    },
  }
})

describe('sdk', () => {
  const mockedSigner = {
    getChangeAddresses: vi.fn().mockReturnValue(btcAddresses.slice(0, 1)),
    getNonChangeAddresses: vi.fn().mockReturnValue(btcAddresses.slice(1)),
    signTransaction: vi.fn(),
  } satisfies BitcoinSigner

  const mockedDataSource = {
    getAddressDetails: vi.fn().mockImplementation((address) => ({ address, balance: 0, txCount: 0 })),
    getFeeRate: vi.fn().mockReturnValue(mockValues.bitcoinFeeRate),
    getOutputs: vi.fn(),
    getTxHex: vi.fn(),
    broadcast: vi.fn(),
  } satisfies BitcoinDataSource

  const sdk = new PowPegSDK(mockedSigner, mockedDataSource, 'TEST')

  it('should create a peg-in', async () => {
    const bridgeSpy = vi.spyOn(sdk['bridge'], 'getFederationAddress')
    const amount = 100_000n
    const psbt = await sdk.createPegin(amount, rskAddresses[0])

    expect(bridgeSpy).toHaveBeenCalled()
    expect(psbt.txOutputs).toHaveLength(2)
    expect(psbt.txOutputs[0].value).toBe(0)
    expect(psbt.txOutputs[1].value).toBe(Number(amount))
  })
  it('should fail to fund a peg-in with an amount below the minimum', async () => {
    const psbt = await sdk.createPegin(100_000n, rskAddresses[0])

    await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrowError(AmountBelowMinError)
  })
  it('should fail to fund a peg-in if user has not enough funds', async () => {
    const psbt = await sdk.createPegin(1_000_000n, rskAddresses[0])

    await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrowError(NotEnoughFundsError)
  })
  it('should fund a peg-in with an allowed amount and enough funds', async () => {
    mockedDataSource.getAddressDetails
      .mockResolvedValueOnce({ address: btcAddresses[1], balance: 1_000_000, txCount: 1 })
      .mockResolvedValueOnce({ address: btcAddresses[2], balance: 0, txCount: 1 })
    mockedDataSource.getOutputs.mockResolvedValue([{ address: btcAddresses[1], amount: 1_000_000n, txid: '7309875224b1630ec4470b4d808243022f295a5595a1f32b1eb640cb2fea773e', vout: 0 }])
    mockedDataSource.getTxHex.mockResolvedValue('0200000001a2399abede23d11581f898eaa3b900b5fe09b8e7366bfb362e42173123fdb188000000006b483045022100836f7eb5a993d86fab93397c3cbd000b5d05fccbfa0921e5e3262b810f0085f00220123a465b2abfb73a6d555087312482b8292c5d170e087244b1130084b1be623c0121033b0017bbeced25a65c3f4e18ac49183fbbef9a2c8215a6f48ca59809cd7fd085ffffffff02af195203000000001976a9141f36d1d36d0bf2d279311db70c5b17faca75e0bb88ac0000000000000000536a4c5048454d4901007084170022b6d196534385ea12387b7e0bcfe929911662add4acf95b048323eb3c0dc549f6f233c90333424e8250a29d4f23eb51b6b0a9d01f11b067b0419aa8ad235794fc699814950d1a063a00')
    const psbt = await sdk.createPegin(500_000n, rskAddresses[0])
    const fundedPsbt = await sdk.fundPegin(psbt, 'average')

    expect(fundedPsbt).toBeDefined()
  })
  it('should fail to create a peg-out with an amount below the minimum', async () => {
    await expect(sdk.createPegout('0.001', rskAddresses[0])).rejects.toThrowError(AmountBelowMinError)
  })
  it('should fail to create a peg-out if user has not enough funds', async () => {
    mockProvider.getBalance.mockResolvedValueOnce(mockValues.lowBalance)

    await expect(sdk.createPegout('0.006', rskAddresses[0])).rejects.toThrowError(NotEnoughFundsError)
  })
  it('should create a peg-out with an allowed amount and enough funds', async () => {
    const pegout = await sdk.createPegout('0.005', rskAddresses[0])

    expect(pegout).toBeDefined()
  })
  it('should estimate peg-out fees', async () => {
    const fees = await sdk.estimatePegoutFees('0.005', rskAddresses[0])

    expect(fees.bitcoinFee).toBe(15_166n)
    expect(fees.rootstockFee).toBe(300_006_150_000n)
  })

  describe('getTransactionStatus', () => {
    const mockTxHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('should get transaction status for PEGIN transaction with CONFIRMED status', async () => {
      const mockResponse = {
        txDetails: {
          btc: {
            txId: 'btc_tx_hash_123',
            creationDate: '2024-01-15T10:30:00Z',
            federationAddress: '2MskK2P1Qw9QbeZ6MG5jmeWMX2d4MFANgkD',
            amountTransferred: 100000,
            fees: 1000,
            refundAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
            confirmations: 6,
            requiredConfirmation: 6,
            btcWTxId: 'btc_wtx_hash_123',
            senderAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
          },
          rsk: {
            recipientAddress: rskAddresses[0],
          },
          status: PeginStatuses.CONFIRMED,
        },
        type: TxType.PEGIN,
      }

      mockApiService.getTransactionStatus.mockResolvedValue(mockResponse)

      const result = await sdk.getTransactionStatus(mockTxHash, TxType.PEGIN)

      expect(mockApiService.getTransactionStatus).toHaveBeenCalledWith(mockTxHash, TxType.PEGIN)
      expect(result).toEqual(mockResponse)
      expect(result.txDetails.status).toBe(PeginStatuses.CONFIRMED)
    })

    it('should get transaction status for PEGIN transaction with WAITING_CONFIRMATIONS status', async () => {
      const mockResponse = {
        txDetails: {
          btc: {
            txId: 'btc_tx_hash_456',
            creationDate: '2024-01-15T10:30:00Z',
            federationAddress: '2MskK2P1Qw9QbeZ6MG5jmeWMX2d4MFANgkD',
            amountTransferred: 50000,
            fees: 500,
            refundAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
            confirmations: 2,
            requiredConfirmation: 6,
            btcWTxId: 'btc_wtx_hash_456',
            senderAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
          },
          rsk: {
            recipientAddress: rskAddresses[0],
          },
          status: PeginStatuses.WAITING_CONFIRMATIONS,
        },
        type: TxType.PEGIN,
      }

      mockApiService.getTransactionStatus.mockResolvedValue(mockResponse)

      const result = await sdk.getTransactionStatus(mockTxHash, TxType.PEGIN)

      expect(mockApiService.getTransactionStatus).toHaveBeenCalledWith(mockTxHash, TxType.PEGIN)
      expect(result).toEqual(mockResponse)
      expect(result.txDetails.status).toBe(PeginStatuses.WAITING_CONFIRMATIONS)
    })

    it('should get transaction status for PEGOUT transaction with PENDING status', async () => {
      const mockResponse = {
        txDetails: {
          originatingRskTxHash: 'rsk_tx_hash_123',
          rskTxHash: 'rsk_tx_hash_456',
          rskSenderAddress: rskAddresses[0],
          btcRecipientAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
          valueRequestedInSatoshis: 100000,
          valueInSatoshisToBeReceived: 95000,
          feeInSatoshisToBePaid: 5000,
          status: PegoutStatuses.PENDING,
          btcRawTransaction: 'raw_btc_tx_hex',
        },
        type: TxType.PEGOUT,
      }

      mockApiService.getTransactionStatus.mockResolvedValue(mockResponse)

      const result = await sdk.getTransactionStatus(mockTxHash, TxType.PEGOUT)

      expect(mockApiService.getTransactionStatus).toHaveBeenCalledWith(mockTxHash, TxType.PEGOUT)
      expect(result).toEqual(mockResponse)
      expect(result.txDetails.status).toBe(PegoutStatuses.PENDING)
    })

    it('should get transaction status for PEGOUT transaction with REJECTED status', async () => {
      const mockResponse = {
        txDetails: {
          originatingRskTxHash: 'rsk_tx_hash_789',
          rskTxHash: 'rsk_tx_hash_101',
          rskSenderAddress: rskAddresses[0],
          btcRecipientAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
          valueRequestedInSatoshis: 1000,
          valueInSatoshisToBeReceived: 0,
          feeInSatoshisToBePaid: 0,
          status: PegoutStatuses.REJECTED,
          btcRawTransaction: '',
          reason: 'LOW_AMOUNT',
        },
        type: TxType.PEGOUT,
      }

      mockApiService.getTransactionStatus.mockResolvedValue(mockResponse)

      const result = await sdk.getTransactionStatus(mockTxHash, TxType.PEGOUT)

      expect(mockApiService.getTransactionStatus).toHaveBeenCalledWith(mockTxHash, TxType.PEGOUT)
      expect(result).toEqual(mockResponse)
      expect(result.txDetails.status).toBe(PegoutStatuses.REJECTED)
      expect(result.txDetails.reason).toBe('LOW_AMOUNT')
    })
  })
})
