import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Psbt } from 'bitcoinjs-lib'
import { PowPegSDK } from './powpeg'
import type { BitcoinSigner, BitcoinDataSource } from '../types'
import { AmountBelowMinError, NotEnoughFundsError, InvalidAddressError, FederationAddressError } from '../errors'
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
  getFeatures: vi.fn(),
  getPeginConfiguration: vi.fn().mockResolvedValue({
    minValue: 500_000,
    maxValue: 4_199_866_190_155_915,
    federationAddress: '2MskK2P1Qw9QbeZ6MG5jmeWMX2d4MFANgkD',
    btcConfirmations: 100,
  }),
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

  describe('getFeatures', () => {
    it('should return the features from the API', async () => {
      const features = [
        { name: 'flyover', value: 'enabled' },
        { name: 'union_bridge', value: 'disabled' },
        { name: 'powpeg', value: 'enabled' },
      ]
      mockApiService.getFeatures.mockResolvedValue(features)

      await expect(sdk.getFeatures()).resolves.toEqual(features)
    })
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

  describe('getAvailableUtxos', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('should return UTXOs for valid addresses', async () => {
      const validAddresses = [btcAddresses[0], btcAddresses[1]]
      const mockUtxos = [
        { address: btcAddresses[0], txid: 'tx1', vout: 0, amount: 1000n },
        { address: btcAddresses[1], txid: 'tx2', vout: 1, amount: 2000n },
      ]

      mockedDataSource.getOutputs
        .mockResolvedValueOnce([mockUtxos[0]])
        .mockResolvedValueOnce([mockUtxos[1]])

      const result = await sdk.getAvailableUtxos(validAddresses)

      expect(result).toEqual(mockUtxos)
      expect(mockedDataSource.getOutputs).toHaveBeenCalledTimes(2)
    })

    it('should return UTXOs for a single address', async () => {
      const singleAddress = btcAddresses[0]
      const mockUtxos = [{ address: singleAddress, txid: 'tx1', vout: 0, amount: 1000n }]

      mockedDataSource.getOutputs.mockResolvedValueOnce(mockUtxos)

      const result = await sdk.getAvailableUtxos(singleAddress)

      expect(result).toEqual(mockUtxos)
      expect(mockedDataSource.getOutputs).toHaveBeenCalledTimes(1)
      expect(mockedDataSource.getOutputs).toHaveBeenCalledWith(singleAddress)
    })

    it('should throw InvalidAddressError with correct message and invalidAddresses for invalid addresses', async () => {
      const invalidAddresses = [
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        '0x8c2f0abf2b1c4d4f7f5b6e3c3f2a6b7f7c7c1d9d',
      ]

      await expect(sdk.getAvailableUtxos(invalidAddresses)).rejects.toThrow(InvalidAddressError)
      await expect(sdk.getAvailableUtxos(invalidAddresses)).rejects.toThrow('Invalid addresses:')
    })
  })

  describe('selected UTXO support', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('should create a peg-in with selected UTXOs', async () => {
      const amount = 100_000n
      const selectedUtxos = [
        { address: btcAddresses[0], txid: 'tx1', vout: 0, amount: 500_000n },
        { address: btcAddresses[1], txid: 'tx2', vout: 1, amount: 300_000n },
      ]

      const psbt = await sdk.createPegin(amount, rskAddresses[0], selectedUtxos)

      expect(psbt.txOutputs).toHaveLength(2)
      expect(psbt.txOutputs[0].value).toBe(0)
      expect(psbt.txOutputs[1].value).toBe(Number(amount))
    })

    it('should create and fund a peg-in with selected UTXOs', async () => {
      mockedDataSource.getAddressDetails
        .mockResolvedValueOnce({ address: btcAddresses[1], balance: 0, txCount: 0 })
        .mockResolvedValueOnce({ address: btcAddresses[2], balance: 0, txCount: 0 })
      const txHex = '0200000001a2399abede23d11581f898eaa3b900b5fe09b8e7366bfb362e42173123fdb188000000006b483045022100836f7eb5a993d86fab93397c3cbd000b5d05fccbfa0921e5e3262b810f0085f00220123a465b2abfb73a6d555087312482b8292c5d170e087244b1130084b1be623c0121033b0017bbeced25a65c3f4e18ac49183fbbef9a2c8215a6f48ca59809cd7fd085ffffffff02af195203000000001976a9141f36d1d36d0bf2d279311db70c5b17faca75e0bb88ac0000000000000000536a4c5048454d4901007084170022b6d196534385ea12387b7e0bcfe929911662add4acf95b048323eb3c0dc549f6f233c90333424e8250a29d4f23eb51b6b0a9d01f11b067b0419aa8ad235794fc699814950d1a063a00'
      const selectedUtxos = [
        { address: btcAddresses[0], txid: '7309875224b1630ec4470b4d808243022f295a5595a1f32b1eb640cb2fea773e', vout: 0, amount: 1_000_000n },
      ]
      mockedDataSource.getTxHex.mockResolvedValue(txHex)

      const result = await sdk.createAndFundPegin(500_000n, rskAddresses[0], mockedSigner, 'average', selectedUtxos)

      expect(result.psbt).toBeDefined()
      expect(result.inputs).toBeDefined()
      expect(result.inputs.length).toBeGreaterThan(0)
      expect(result.fee).toBeGreaterThan(0)
      expect(result.transactions).toBeDefined()
    })

    it('should work the same way when selected UTXOs are not provided', async () => {
      mockedDataSource.getAddressDetails
        .mockResolvedValueOnce({ address: btcAddresses[1], balance: 1_000_000, txCount: 1 })
        .mockResolvedValueOnce({ address: btcAddresses[2], balance: 0, txCount: 1 })
      mockedDataSource.getOutputs.mockResolvedValue([{ address: btcAddresses[1], amount: 1_000_000n, txid: '7309875224b1630ec4470b4d808243022f295a5595a1f32b1eb640cb2fea773e', vout: 0 }])
      mockedDataSource.getTxHex.mockResolvedValue('0200000001a2399abede23d11581f898eaa3b900b5fe09b8e7366bfb362e42173123fdb188000000006b483045022100836f7eb5a993d86fab93397c3cbd000b5d05fccbfa0921e5e3262b810f0085f00220123a465b2abfb73a6d555087312482b8292c5d170e087244b1130084b1be623c0121033b0017bbeced25a65c3f4e18ac49183fbbef9a2c8215a6f48ca59809cd7fd085ffffffff02af195203000000001976a9141f36d1d36d0bf2d279311db70c5b17faca75e0bb88ac0000000000000000536a4c5048454d4901007084170022b6d196534385ea12387b7e0bcfe929911662add4acf95b048323eb3c0dc549f6f233c90333424e8250a29d4f23eb51b6b0a9d01f11b067b0419aa8ad235794fc699814950d1a063a00')

      const result = await sdk.createAndFundPegin(500_000n, rskAddresses[0], mockedSigner, 'average')

      expect(result.psbt).toBeDefined()
      expect(result.inputs).toBeDefined()
      expect(result.inputs.length).toBeGreaterThan(0)
      expect(result.fee).toBeGreaterThan(0)
      expect(result.transactions).toBeDefined()
    })
  })

  describe('funding context isolation', () => {
    const txHex = '0200000001a2399abede23d11581f898eaa3b900b5fe09b8e7366bfb362e42173123fdb188000000006b483045022100836f7eb5a993d86fab93397c3cbd000b5d05fccbfa0921e5e3262b810f0085f00220123a465b2abfb73a6d555087312482b8292c5d170e087244b1130084b1be623c0121033b0017bbeced25a65c3f4e18ac49183fbbef9a2c8215a6f48ca59809cd7fd085ffffffff02af195203000000001976a9141f36d1d36d0bf2d279311db70c5b17faca75e0bb88ac0000000000000000536a4c5048454d4901007084170022b6d196534385ea12387b7e0bcfe929911662add4acf95b048323eb3c0dc549f6f233c90333424e8250a29d4f23eb51b6b0a9d01f11b067b0419aa8ad235794fc699814950d1a063a00'

    beforeEach(() => {
      vi.clearAllMocks()
      mockedDataSource.getTxHex.mockResolvedValue(txHex)
    })

    it('should fund each PSBT with its own UTXOs when peg-ins are created interleaved', async () => {
      const utxoA = { address: btcAddresses[1], txid: 'a'.repeat(64), vout: 0, amount: 2_000_000n }
      const utxoB = { address: btcAddresses[2], txid: 'b'.repeat(64), vout: 0, amount: 2_000_000n }

      const psbtA = await sdk.createPegin(500_000n, rskAddresses[0], [utxoA])
      const psbtB = await sdk.createPegin(500_000n, rskAddresses[0], [utxoB])

      const fundedA = await sdk.fundPegin(psbtA, 'average')
      const fundedB = await sdk.fundPegin(psbtB, 'average')

      expect(fundedA.inputs).toHaveLength(1)
      expect(fundedA.inputs[0].txid).toBe(utxoA.txid)
      expect(fundedB.inputs).toHaveLength(1)
      expect(fundedB.inputs[0].txid).toBe(utxoB.txid)
    })

    it('should not reuse a previous peg-in change address in createAndFundPsbt', async () => {
      const previousPeginUtxo = { address: btcAddresses[1], txid: 'a'.repeat(64), vout: 0, amount: 2_000_000n }
      await sdk.createPegin(500_000n, rskAddresses[0], [previousPeginUtxo])

      const psbtUtxo = { address: btcAddresses[4], txid: 'b'.repeat(64), vout: 0, amount: 2_000_000n }
      const { psbt } = await sdk.createAndFundPsbt(500_000n, btcAddresses[3], [psbtUtxo], 'average')

      const changeOutput = psbt.txOutputs[1]
      expect(changeOutput.address).toBe(psbtUtxo.address)
      expect(changeOutput.address).not.toBe(btcAddresses[0])
    })

    it('should fail to fund a PSBT that has no funding context', async () => {
      await expect(sdk.fundPegin(new Psbt(), 'average')).rejects.toThrow('No funding context')
    })
  })

  describe('federation address verification', () => {
    it('should fail to create a peg-in when the pegin configuration reports a different federation address', async () => {
      mockApiService.getPeginConfiguration.mockResolvedValueOnce({
        minValue: 500_000,
        maxValue: 4_199_866_190_155_915,
        federationAddress: '2N7eSt5myGSXoiAnqpzu856EwgA8SHg53Lg',
        btcConfirmations: 100,
      })

      await expect(sdk.createPegin(500_000n, rskAddresses[0])).rejects.toThrowError(FederationAddressError)
    })

    it('should fail to create a peg-in when the pegin configuration is unavailable', async () => {
      mockApiService.getPeginConfiguration.mockRejectedValueOnce(new Error('Not found'))

      await expect(sdk.createPegin(500_000n, rskAddresses[0])).rejects.toThrowError(FederationAddressError)
    })
  })

  describe('coin selection', () => {
    const feePerInput = 290 // 2 sat/B * 145 bytes
    const baseFee = 218

    const utxo = (amount: bigint, i: number) => ({
      address: btcAddresses[0],
      txid: `tx${i}`,
      vout: 0,
      amount,
    })

    it('should prefer a single large UTXO over many small ones', () => {
      const utxos = [...Array.from({ length: 40 }, (_, i) => utxo(40_000n, i)), utxo(5_000_000n, 40)]

      const { inputs, rest } = sdk['selectInputs'](500_000n, utxos, baseFee, feePerInput)

      expect(inputs).toHaveLength(1)
      expect(inputs[0].amount).toBe(5_000_000n)
      expect(rest).toBeLessThanOrEqual(0)
    })

    it('should skip UTXOs worth less than their own input fee', () => {
      const utxos = Array.from({ length: 60 }, (_, i) => utxo(200n, i))

      const { inputs, rest } = sdk['selectInputs'](500_000n, utxos, baseFee, feePerInput)

      expect(inputs).toHaveLength(0)
      expect(rest).toBeGreaterThan(0)
    })

    it('should stop selecting once the target is covered', () => {
      const utxos = [utxo(600_000n, 0), utxo(550_000n, 1), utxo(500_000n, 2)]

      const { inputs } = sdk['selectInputs'](500_000n, utxos, baseFee, feePerInput)

      expect(inputs).toHaveLength(1)
      expect(inputs[0].amount).toBe(600_000n)
    })

    it('should not mutate the caller\'s UTXO array', () => {
      const utxos = [utxo(40_000n, 0), utxo(5_000_000n, 1), utxo(100_000n, 2)]
      const originalOrder = utxos.map((u) => u.txid)

      sdk['selectInputs'](500_000n, utxos, baseFee, feePerInput)

      expect(utxos.map((u) => u.txid)).toEqual(originalOrder)
    })

    it('should estimate the fee with the same selection used to fund when UTXOs are provided', async () => {
      const utxos = [...Array.from({ length: 40 }, (_, i) => utxo(40_000n, i)), utxo(5_000_000n, 40)]

      const estimatedFee = await sdk.estimatePeginFee(500_000n, 'fast', utxos)
      const feeRate = mockValues.bitcoinFeeRate
      const expectedBaseFee = feeRate * (13 + 32 * 3)
      const expectedFeePerInput = feeRate * 145

      // one input selected, so the estimate reflects exactly one input's cost
      expect(estimatedFee).toBe(expectedBaseFee + expectedFeePerInput)
    })
  })

  describe('RSK recipient validation', () => {
    const validRecipients = [
      // EIP-55 checksum (what ethers accepts)
      '0x8C2f0AbF2B1c4d4f7f5B6e3c3F2a6B7F7c7C1D9d',
      // EIP-1191 chainId 30 (RSK mainnet)
      '0x8c2f0AbF2B1C4d4f7F5b6e3C3F2A6B7F7c7c1d9d',
      // EIP-1191 chainId 31 (RSK testnet)
      '0x8c2f0abF2b1C4D4f7F5b6e3c3F2a6B7f7c7c1d9d',
      // all-lowercase, and without 0x prefix
      '0x8c2f0abf2b1c4d4f7f5b6e3c3f2a6b7f7c7c1d9d',
      '8c2f0abf2b1c4d4f7f5b6e3c3f2a6b7f7c7c1d9d',
    ]

    const invalidRecipients = [
      '0x8c2f0abf2b1c4d4f7f5b6e3c3f2a6b7f7c7c1d9', // 39 hex chars (truncated)
      '0x8c2f0abf2b1c4d4f7f5b6e3c3f2a6b7f7c7c1d9dd', // 41 hex chars
      '0x8c2f0abf2b1c4d4f7f5b6e3c3f2a6b7f7c7cZZZZ', // non-hex characters
      'XE38GDI18R1Q9VVZ9YX48FQ1HBYPCUM2W7X', // ICAP/IBAN form accepted by ethers isAddress
      'tb1qm0f4nu37q8u82txpj0l0cp924836gs2q4m9rdf', // Bitcoin address pasted by mistake
      '',
    ]

    it.each(validRecipients)('should accept valid recipient %s and encode the full 20-byte recipient', async (recipient) => {
      const psbt = await sdk.createPegin(500_000n, recipient)

      // payload starts with the 5-byte protocol header followed by the 20-byte
      // recipient (a refund entry may follow, making the payload 46 bytes)
      const scriptHex = psbt.txOutputs[0].script.toString('hex')
      expect(scriptHex).toContain(`52534b5401${recipient.toLowerCase().replace(/^0x/, '')}`)
    })

    it.each(invalidRecipients)('should reject invalid recipient %s', async (recipient) => {
      await expect(sdk.createPegin(500_000n, recipient)).rejects.toThrowError(InvalidAddressError)
    })
  })

  describe('UTXO deduplication', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('should deduplicate UTXOs when the same UTXO is returned for multiple addresses', async () => {
      const duplicateUtxo = { address: btcAddresses[0], txid: 'duplicate_tx_id', vout: 0, amount: 500_000n }
      const uniqueUtxo = { address: btcAddresses[1], txid: 'unique_tx_id', vout: 1, amount: 300_000n }

      mockedDataSource.getOutputs
        .mockResolvedValueOnce([duplicateUtxo])
        .mockResolvedValueOnce([duplicateUtxo, uniqueUtxo])

      const result = await sdk.getAvailableUtxos([btcAddresses[0], btcAddresses[1]])

      expect(result).toHaveLength(2)
      expect(result).toEqual([duplicateUtxo, uniqueUtxo])
      expect(mockedDataSource.getOutputs).toHaveBeenCalledTimes(2)
    })

    it('should deduplicate UTXOs with same txid and vout but different addresses', async () => {
      const utxo1 = { address: btcAddresses[0], txid: 'same_tx_id', vout: 0, amount: 500_000n }
      const utxo2 = { address: btcAddresses[1], txid: 'same_tx_id', vout: 0, amount: 500_000n }

      mockedDataSource.getOutputs
        .mockResolvedValueOnce([utxo1])
        .mockResolvedValueOnce([utxo2])

      const result = await sdk.getAvailableUtxos([btcAddresses[0], btcAddresses[1]])

      expect(result).toHaveLength(1)
      expect(result[0].txid).toBe('same_tx_id')
      expect(result[0].vout).toBe(0)
      expect(result[0].address).toBe(btcAddresses[0])
    })

    it('should not deduplicate UTXOs with same txid but different vout', async () => {
      const utxo1 = { address: btcAddresses[0], txid: 'same_tx_id', vout: 0, amount: 500_000n }
      const utxo2 = { address: btcAddresses[0], txid: 'same_tx_id', vout: 1, amount: 300_000n }

      mockedDataSource.getOutputs.mockResolvedValueOnce([utxo1, utxo2])

      const result = await sdk.getAvailableUtxos(btcAddresses[0])

      expect(result).toHaveLength(2)
      expect(result).toEqual([utxo1, utxo2])
    })

    it('should handle auto-selection with duplicate UTXOs without throwing error', async () => {
      const duplicateUtxo = { address: btcAddresses[1], txid: '7309875224b1630ec4470b4d808243022f295a5595a1f32b1eb640cb2fea773e', vout: 0, amount: 1_000_000n }
      const txHex = '0200000001a2399abede23d11581f898eaa3b900b5fe09b8e7366bfb362e42173123fdb188000000006b483045022100836f7eb5a993d86fab93397c3cbd000b5d05fccbfa0921e5e3262b810f0085f00220123a465b2abfb73a6d555087312482b8292c5d170e087244b1130084b1be623c0121033b0017bbeced25a65c3f4e18ac49183fbbef9a2c8215a6f48ca59809cd7fd085ffffffff02af195203000000001976a9141f36d1d36d0bf2d279311db70c5b17faca75e0bb88ac0000000000000000536a4c5048454d4901007084170022b6d196534385ea12387b7e0bcfe929911662add4acf95b048323eb3c0dc549f6f233c90333424e8250a29d4f23eb51b6b0a9d01f11b067b0419aa8ad235794fc699814950d1a063a00'

      mockedDataSource.getAddressDetails
        .mockResolvedValueOnce({ address: btcAddresses[1], balance: 1_000_000, txCount: 1 })
        .mockResolvedValueOnce({ address: btcAddresses[2], balance: 1_000_000, txCount: 1 })

      mockedDataSource.getOutputs
        .mockResolvedValueOnce([duplicateUtxo])
        .mockResolvedValueOnce([duplicateUtxo])

      mockedDataSource.getTxHex.mockResolvedValue(txHex)

      const result = await sdk.createAndFundPegin(500_000n, rskAddresses[0], mockedSigner, 'average')

      expect(result.psbt).toBeDefined()
      expect(result.inputs).toBeDefined()
      expect(result.inputs.length).toBe(1)
      expect(result.inputs[0].txid).toBe(duplicateUtxo.txid)
      expect(result.inputs[0].vout).toBe(duplicateUtxo.vout)
    })

    it('should create PSBT with no duplicate inputs when API returns duplicates', async () => {
      const duplicateUtxo = { address: btcAddresses[1], txid: '7309875224b1630ec4470b4d808243022f295a5595a1f32b1eb640cb2fea773e', vout: 0, amount: 1_000_000n }
      const uniqueUtxo = { address: btcAddresses[2], txid: 'a2399abede23d11581f898eaa3b900b5fe09b8e7366bfb362e42173123fdb188', vout: 0, amount: 800_000n }
      const txHex = '0200000001a2399abede23d11581f898eaa3b900b5fe09b8e7366bfb362e42173123fdb188000000006b483045022100836f7eb5a993d86fab93397c3cbd000b5d05fccbfa0921e5e3262b810f0085f00220123a465b2abfb73a6d555087312482b8292c5d170e087244b1130084b1be623c0121033b0017bbeced25a65c3f4e18ac49183fbbef9a2c8215a6f48ca59809cd7fd085ffffffff02af195203000000001976a9141f36d1d36d0bf2d279311db70c5b17faca75e0bb88ac0000000000000000536a4c5048454d4901007084170022b6d196534385ea12387b7e0bcfe929911662add4acf95b048323eb3c0dc549f6f233c90333424e8250a29d4f23eb51b6b0a9d01f11b067b0419aa8ad235794fc699814950d1a063a00'

      mockedDataSource.getAddressDetails
        .mockResolvedValueOnce({ address: btcAddresses[1], balance: 1_000_000, txCount: 1 })
        .mockResolvedValueOnce({ address: btcAddresses[2], balance: 800_000, txCount: 1 })

      mockedDataSource.getOutputs
        .mockResolvedValueOnce([duplicateUtxo, uniqueUtxo])
        .mockResolvedValueOnce([duplicateUtxo])

      mockedDataSource.getTxHex.mockResolvedValue(txHex)

      const result = await sdk.createAndFundPegin(500_000n, rskAddresses[0], mockedSigner, 'average')

      expect(result.psbt).toBeDefined()
      expect(result.inputs).toBeDefined()
      expect(result.inputs.length).toBe(1)

      const inputKeys = result.inputs.map((input) => `${input.txid}:${input.vout}`)
      const uniqueInputKeys = new Set(inputKeys)
      expect(inputKeys.length).toBe(uniqueInputKeys.size)
    })
  })
})
