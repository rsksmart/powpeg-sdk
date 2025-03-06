import { describe, expect, it, vi } from 'vitest'
import { PowPegSDK } from './powpeg'
import type { BitcoinSigner, BitcoinDataSource } from '../types'
import { AmountBelowMinError, NotEnoughFundsError } from '../errors'

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

describe('sdk', () => {
  const mockedSigner = {
    getChangeAddresses: vi.fn().mockReturnValue(btcAddresses.slice(0, 1)),
    getNonChangeAddresses: vi.fn().mockReturnValue(btcAddresses.slice(1)),
    signTransaction: vi.fn(),
  } satisfies BitcoinSigner

  const mockedDataSource = {
    getAddressDetails: vi.fn().mockImplementation((address) => ({ address, balance: 0, txCount: 0 })),
    getFeeRate: vi.fn().mockReturnValue(1),
    getOutputs: vi.fn(),
    getTxHex: vi.fn(),
    broadcast: vi.fn(),
  } satisfies BitcoinDataSource

  const sdk = new PowPegSDK(mockedSigner, mockedDataSource, 'testnet')

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
})
