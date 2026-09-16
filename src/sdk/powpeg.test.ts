import { describe, expect, it, vi, beforeEach } from 'vitest'
import { crypto as bitcoinJsCrypto, networks as bitcoinJsNetworks, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { PowPegSDK } from './powpeg'
import { ApiService } from '../api/api'
import type { BitcoinSigner, BitcoinDataSource } from '../types'
import { AmountBelowMinError, NotEnoughFundsError, InvalidAddressError, FederationAddressError, InvalidFeeRateError, SigningError, WrongNetworkError, PegoutRejectedError, UnsupportedSenderError, TransactionRevertedError, UnsupportedAddressTypeError } from '../errors'
import { bridge as bridgePrecompile } from '@rsksmart/rsk-precompiled-abis'
import { ethers } from '@rsksmart/bridges-core-sdk'
import { TxType, PegoutStatuses, PeginStatuses } from '../types'

const btcAddresses = [
  'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
  'n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi',
  'mgnucj8nYqdrPFh2JfZSB1NmUThUGnmsqe',
  '2N7eSt5myGSXoiAnqpzu856EwgA8SHg53Lg',
  'tb1qm0f4nu37q8u82txpj0l0cp924836gs2q4m9rdf',
]

/**
 * Builds a real, valid previous transaction and returns its actual hex and txid — `fundPegin`
 * now verifies both against the UTXO claiming to spend it, so a fixture's txid/value can no
 * longer be picked independently of the hex it's paired with.
 */
function buildFundingTx(value: number, vout = 0, salt = 9, script = Buffer.from(`0014${'00'.repeat(20)}`, 'hex')): { hex: string, txid: string } {
  const tx = new Transaction()
  tx.version = 2
  tx.addInput(Buffer.alloc(32, salt), 0)
  for (let i = 0; i <= vout; i++) {
    tx.addOutput(script, i === vout ? value : 1_000)
  }
  return { hex: tx.toHex(), txid: tx.getId() }
}

// A fixed key, so a funding output can be built that the throwaway signer below is actually able to
// sign: bitcoinjs refuses to sign an input whose script does not carry the signer's public key.
const probePublicKey = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
const probeKeyHash = bitcoinJsCrypto.hash160(probePublicKey)
const probeSigner = { publicKey: probePublicKey, sign: () => Buffer.alloc(64, 1) }
const scriptsFor = {
  legacy: () => payments.p2pkh({ hash: probeKeyHash, network: bitcoinJsNetworks.testnet }).output as Buffer,
  p2sh: () => payments.p2sh({ redeem: payments.p2wpkh({ hash: probeKeyHash, network: bitcoinJsNetworks.testnet }), network: bitcoinJsNetworks.testnet }).output as Buffer,
  nativeSegwit: () => payments.p2wpkh({ hash: probeKeyHash, network: bitcoinJsNetworks.testnet }).output as Buffer,
}

const rskAddresses = [
  '0x8c2f0abf2b1c4d4f7f5b6e3c3f2a6b7f7c7c1d9d',
]

// The mocked federation keeps the shape of the live testnet one: a 491-byte redeem script wrapped as
// P2SH-P2WSH, with the address derived from it so the two stay consistent.
const mockRedeemScript = Buffer.concat([
  ...Array.from({ length: 14 }, (_, i) => Buffer.concat([Buffer.from([0x21]), Buffer.alloc(33, i + 1)])),
  Buffer.alloc(15, 0xae),
])
const mockFederationAddress = payments.p2sh({
  redeem: payments.p2wsh({ redeem: { output: mockRedeemScript }, network: bitcoinJsNetworks.testnet }),
  network: bitcoinJsNetworks.testnet,
}).address as string

const mockValues = {
  federationAddress: mockFederationAddress,
  estimatedFeeForNextPegOut: ethers.BigNumber.from(45_500n),
  queuedPegoutsCount: ethers.BigNumber.from(2n),
  highBalance: ethers.BigNumber.from(1_000_000_000_000_000_000n),
  mediumBalance: ethers.BigNumber.from(100_000_000_000_000n),
  lowBalance: ethers.BigNumber.from(95_020_024_416_166n),
  estimatedGas: ethers.BigNumber.from(50_000n),
  gasPrice: ethers.BigNumber.from(6_000_123n),
  bitcoinFeeRate: 1,
  // Live testnet federation at the time of writing: 6-of-11, 491-byte P2SH-P2WSH ERP redeem script.
  feePerKb: 8_000n,
  federationThreshold: 6,
  redeemScript: `0x${mockRedeemScript.toString('hex')}`,
}

const createMockProvider = (balance = mockValues.highBalance) => ({
  ...Object.create(ethers.providers.JsonRpcProvider.prototype),
  getBalance: vi.fn().mockResolvedValue(balance),
  getCode: vi.fn().mockResolvedValue('0x'),
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
    federationAddress: mockValues.federationAddress,
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
  const { bridge } = await import('@rsksmart/rsk-precompiled-abis')
  return {
    ...original,
    ethers: {
      ...original.ethers,
      Contract: vi.fn(() => ({
        ...ethers.Contract.prototype,
        interface: new original.ethers.utils.Interface(bridge.abi),
        getFederationAddress: vi.fn().mockResolvedValue(mockValues.federationAddress),
        getEstimatedFeesForNextPegOutEvent: vi.fn().mockResolvedValue(mockValues.estimatedFeeForNextPegOut),
        getQueuedPegoutsCount: vi.fn().mockResolvedValue(mockValues.queuedPegoutsCount),
        getFeePerKb: vi.fn().mockImplementation(() => original.ethers.BigNumber.from(mockValues.feePerKb)),
        getActivePowpegRedeemScript: vi.fn().mockImplementation(() => mockValues.redeemScript),
        getFederationThreshold: vi.fn().mockImplementation(() => original.ethers.BigNumber.from(mockValues.federationThreshold)),
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

  const sdk = new PowPegSDK({ network: 'TEST', bitcoinSigner: mockedSigner, bitcoinDataSource: mockedDataSource })

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
    const fundingTx = buildFundingTx(1_000_000)
    mockedDataSource.getOutputs.mockResolvedValue([{ address: btcAddresses[1], amount: 1_000_000n, txid: fundingTx.txid, vout: 0 }])
    mockedDataSource.getTxHex.mockResolvedValue(fundingTx.hex)
    const psbt = await sdk.createPegin(500_000n, rskAddresses[0])
    const fundedPsbt = await sdk.fundPegin(psbt, 'average')

    expect(fundedPsbt).toBeDefined()
  })
  describe('funding input address types', () => {
    const fundFrom = async (script: Buffer) => {
      const fundingTx = buildFundingTx(1_000_000, 0, 77, script)
      mockedDataSource.getTxHex.mockResolvedValue(fundingTx.hex)
      const utxo = { address: btcAddresses[3], txid: fundingTx.txid, vout: 0, amount: 1_000_000n }
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo])
      return { funded: await sdk.fundPegin(psbt, 'average'), fundingTx }
    }

    it('should produce a legacy input the signer can actually sign', async () => {
      const { funded, fundingTx } = await fundFrom(scriptsFor.legacy())

      expect(funded.psbt.data.inputs[0].nonWitnessUtxo).toEqual(Buffer.from(fundingTx.hex, 'hex'))
      expect(() => funded.psbt.signInput(0, probeSigner)).not.toThrow()
    })

    it('should produce a native segwit input the signer can actually sign', async () => {
      const { funded } = await fundFrom(scriptsFor.nativeSegwit())

      expect(() => funded.psbt.signInput(0, probeSigner)).not.toThrow()
    })

    it('should carry the parent transaction only on the inputs that need it to be signed', async () => {
      // The segwit UTXO is the larger one, so input selection takes it first and the legacy input
      // lands at index 1.
      const segwitTx = buildFundingTx(900_000, 0, 81, scriptsFor.nativeSegwit())
      const legacyTx = buildFundingTx(800_000, 0, 82, scriptsFor.legacy())
      mockedDataSource.getTxHex.mockImplementation((txid: string) => Promise.resolve(txid === segwitTx.txid ? segwitTx.hex : legacyTx.hex))
      const utxos = [
        { address: btcAddresses[4], txid: segwitTx.txid, vout: 0, amount: 900_000n },
        { address: btcAddresses[0], txid: legacyTx.txid, vout: 0, amount: 800_000n },
      ]
      const psbt = await sdk.createPegin(1_200_000n, rskAddresses[0], utxos)

      const { psbt: funded } = await sdk.fundPegin(psbt, 'average')

      expect(funded.txInputs).toHaveLength(2)
      expect(funded.data.inputs[0].nonWitnessUtxo).toBeUndefined()
      expect(funded.data.inputs[1].nonWitnessUtxo).toEqual(Buffer.from(legacyTx.hex, 'hex'))
      expect(() => funded.signInput(0, probeSigner)).not.toThrow()
      expect(() => funded.signInput(1, probeSigner)).not.toThrow()
    })

    it('should refuse a UTXO held by a P2SH address', async () => {
      const fundingTx = buildFundingTx(1_000_000, 0, 78, scriptsFor.p2sh())
      mockedDataSource.getTxHex.mockResolvedValue(fundingTx.hex)
      const utxo = { address: btcAddresses[3], txid: fundingTx.txid, vout: 0, amount: 1_000_000n }
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo])

      const error = await sdk.fundPegin(psbt, 'average').catch((e) => e)

      expect(error).toBeInstanceOf(UnsupportedAddressTypeError)
      expect(error.address).toBe(btcAddresses[3])
      expect(psbt.txInputs).toHaveLength(0)
    })

    it('should leave the PSBT untouched when it refuses a UTXO that is not the first one', async () => {
      const segwitTx = buildFundingTx(900_000, 0, 83, scriptsFor.nativeSegwit())
      const p2shTx = buildFundingTx(800_000, 0, 84, scriptsFor.p2sh())
      mockedDataSource.getTxHex.mockImplementation((txid: string) => Promise.resolve(txid === segwitTx.txid ? segwitTx.hex : p2shTx.hex))
      const utxos = [
        { address: btcAddresses[4], txid: segwitTx.txid, vout: 0, amount: 900_000n },
        { address: btcAddresses[3], txid: p2shTx.txid, vout: 0, amount: 800_000n },
      ]
      const psbt = await sdk.createPegin(1_200_000n, rskAddresses[0], utxos)
      const outputsBefore = psbt.txOutputs.length

      const error = await sdk.fundPegin(psbt, 'average').catch((e) => e)

      expect(error).toBeInstanceOf(UnsupportedAddressTypeError)
      expect(error.address).toBe(btcAddresses[3])
      expect(psbt.txInputs).toHaveLength(0)
      expect(psbt.txOutputs).toHaveLength(outputsBefore)
      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrowError(UnsupportedAddressTypeError)
    })
  })

  it('should fail to create a peg-out with an amount below the minimum', async () => {
    await expect(sdk.createPegout('0.001', rskAddresses[0])).rejects.toThrowError(AmountBelowMinError)
  })
  it('should refuse a peg-out from a contract account before anything is sent', async () => {
    mockProvider.getCode.mockResolvedValueOnce('0x60806040523480156100')

    await expect(sdk.createPegout('0.005', rskAddresses[0])).rejects.toThrowError(UnsupportedSenderError)
  })

  it('should read both the sender\'s balance and its code', async () => {
    await sdk.createPegout('0.005', rskAddresses[0])

    expect(mockProvider.getBalance).toHaveBeenCalledWith(rskAddresses[0])
    expect(mockProvider.getCode).toHaveBeenCalledWith(rskAddresses[0])
  })

  it('should build a peg-in for a signer that exposes no change addresses', async () => {
    const noChangeSigner = {
      getNonChangeAddresses: vi.fn().mockResolvedValue(btcAddresses.slice(1)),
      getChangeAddresses: vi.fn().mockResolvedValue([]),
      signTransaction: vi.fn(),
    } satisfies BitcoinSigner
    const noChangeFundingTx = buildFundingTx(2_000_000, 0, 41)
    mockedDataSource.getTxHex.mockResolvedValue(noChangeFundingTx.hex)
    const utxo = { address: btcAddresses[1], txid: noChangeFundingTx.txid, vout: 0, amount: 2_000_000n }

    const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo], noChangeSigner)
    const funded = await sdk.fundPegin(psbt, 'average')

    expect(funded.psbt.txOutputs.at(-1)?.address).toBe(utxo.address)
  })

  it('should build a peg-in from selected UTXOs even when the signer derives no addresses', async () => {
    const addressLessSigner = {
      getNonChangeAddresses: vi.fn().mockResolvedValue([]),
      getChangeAddresses: vi.fn().mockResolvedValue([]),
      signTransaction: vi.fn(),
    } satisfies BitcoinSigner
    const ownFundingTx = buildFundingTx(2_000_000, 0, 51)
    mockedDataSource.getTxHex.mockResolvedValue(ownFundingTx.hex)
    const utxo = { address: btcAddresses[1], txid: ownFundingTx.txid, vout: 0, amount: 2_000_000n }

    const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo], addressLessSigner)
    const funded = await sdk.fundPegin(psbt, 'average')

    expect(funded.psbt.txOutputs.at(-1)?.address).toBe(utxo.address)
  })

  it('should refuse to build a peg-in when the signer derives no addresses', async () => {
    const emptySigner = {
      getNonChangeAddresses: vi.fn().mockResolvedValue([]),
      getChangeAddresses: vi.fn().mockResolvedValue([]),
      signTransaction: vi.fn(),
    } satisfies BitcoinSigner

    await expect(sdk.createPegin(500_000n, rskAddresses[0], undefined, emptySigner)).rejects.toThrowError(SigningError)
  })

  it('should still build a peg-in when every derived change address has been used', async () => {
    const usedSigner = {
      getNonChangeAddresses: vi.fn().mockResolvedValue(btcAddresses.slice(1)),
      getChangeAddresses: vi.fn().mockResolvedValue(btcAddresses.slice(0, 1)),
      signTransaction: vi.fn(),
    } satisfies BitcoinSigner
    mockedDataSource.getAddressDetails.mockImplementation((address: string) => ({ address, balance: 1_000_000, txCount: 3 }))
    const usedFundingTx = buildFundingTx(2_000_000, 0, 31)
    mockedDataSource.getTxHex.mockResolvedValue(usedFundingTx.hex)
    const utxo = { address: btcAddresses[1], txid: usedFundingTx.txid, vout: 0, amount: 2_000_000n }

    const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo], usedSigner)
    const funded = await sdk.fundPegin(psbt, 'average')

    expect(funded.psbt.txOutputs.at(-1)?.address).toBe(utxo.address)
  })

  it('should reject an amount below the network minimum without reading the Bridge', async () => {
    const localSdk = new PowPegSDK({ network: 'TEST', bitcoinSigner: mockedSigner, bitcoinDataSource: mockedDataSource })
    const feePerKb = vi.spyOn(localSdk['bridge'], 'getFeePerKb')
    const redeemScript = vi.spyOn(localSdk['bridge'], 'getActivePowpegRedeemScript')
    const threshold = vi.spyOn(localSdk['bridge'], 'getFederationThreshold')
    const federationAddress = vi.spyOn(localSdk['bridge'], 'getFederationAddress')

    await expect(localSdk.createPegout('0.001', rskAddresses[0])).rejects.toThrowError(AmountBelowMinError)

    expect(feePerKb).not.toHaveBeenCalled()
    expect(redeemScript).not.toHaveBeenCalled()
    expect(threshold).not.toHaveBeenCalled()
    expect(federationAddress).not.toHaveBeenCalled()
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

  describe('peg-out size, against rskj', () => {
    // Outputs pay the federation, which is P2SH under both formats, so a bare P2SH script is
    // representative for sizing.
    const p2shOutput = payments.p2sh({ hash: Buffer.alloc(20) }).output as Buffer
    // A P2SH-P2WSH ERP federation of 13 members plus 4 emergency keys: 445 + 139 + 9 bytes.
    const erpRedeemScript = Buffer.alloc(593, 0x21)
    // The same 13 members as a standard multisig: OP_7 + 13 pushes + OP_13 + OP_CHECKMULTISIG.
    const standardRedeemScript = Buffer.alloc(445, 0x21)

    it('should match rskj for a P2SH-P2WSH federation', () => {
      // BridgeUtilsTest.testCalculatePegoutTxSize_{2,9}Inputs_2Outputs, segwit assertions.
      expect(sdk['pegoutVSizeSegwit'](erpRedeemScript, 7, p2shOutput, 2, 2)).toBe(694)
      expect(sdk['pegoutVSizeSegwit'](erpRedeemScript, 7, p2shOutput, 9, 2)).toBe(2866)
    })

    it('should match rskj for a federation that is not P2SH-P2WSH', () => {
      // Same tests, standard-multisig assertions.
      expect(sdk['pegoutVSizeNonSegwit'](standardRedeemScript, 7, p2shOutput, 2, 2)).toBe(2058)
      expect(sdk['pegoutVSizeNonSegwit'](standardRedeemScript, 7, p2shOutput, 9, 2)).toBe(9002)
    })

    it('should size the post-RSKIP378 rule larger than the one in force', () => {
      // rskj publishes no expected value for this branch, so this pins our own port of
      // BridgeUtils.simulateSegwitPegoutVSize and its relation to the rule in force today.
      const afterRskip378 = sdk['pegoutVSizeAfterRskip378'](erpRedeemScript, 7, p2shOutput, 2, 2)

      expect(afterRskip378).toBe(786)
      // A second input count pins the per-input witness terms, which the /4 truncation hides at 2 inputs.
      expect(sdk['pegoutVSizeAfterRskip378'](erpRedeemScript, 7, p2shOutput, 9, 2)).toBe(3280)
      expect(afterRskip378).toBeGreaterThan(sdk['pegoutVSizeSegwit'](erpRedeemScript, 7, p2shOutput, 2, 2))
    })

    it('should take the larger of the two rules, so the minimum is never below the Bridge\'s', () => {
      // The mocked federation: 491-byte redeem script, 6 signatures. In force today it sizes at 607.
      const vsize = sdk['simulatePegoutVSize'](mockValues.redeemScript, 6, mockValues.federationAddress)

      expect(vsize).toBe(698)
    })

    it('should recognise a federation that is not P2SH-P2WSH from its address', () => {
      const legacyAddress = payments.p2sh({ redeem: { output: mockRedeemScript }, network: bitcoinJsNetworks.testnet }).address as string

      expect(sdk['resolveFederationOutput'](mockRedeemScript, mockValues.federationAddress).isSegwit).toBe(true)
      expect(sdk['resolveFederationOutput'](mockRedeemScript, legacyAddress).isSegwit).toBe(false)
    })

    it('should size a P2SH-P2WSH federation whose redeem script exceeds the script-sig limit', () => {
      // A P2SH-P2WSH redeem script may run to 3566 bytes; only a script-sig spend is capped at 520.
      const largeRedeemScript = Buffer.concat([
        ...Array.from({ length: 15 }, (_, i) => Buffer.concat([Buffer.from([0x21]), Buffer.alloc(33, i + 1)])),
        Buffer.alloc(15, 0xae),
      ])
      const federationAddress = payments.p2sh({
        redeem: payments.p2wsh({ redeem: { output: largeRedeemScript }, network: bitcoinJsNetworks.testnet }),
        network: bitcoinJsNetworks.testnet,
      }).address as string

      expect(largeRedeemScript.length).toBeGreaterThan(520)
      expect(sdk['resolveFederationOutput'](largeRedeemScript, federationAddress).isSegwit).toBe(true)
      expect(sdk['simulatePegoutVSize'](`0x${largeRedeemScript.toString('hex')}`, 8, federationAddress)).toBeGreaterThan(0)
    })

    it('should reject a federation address that does not derive from the redeem script', () => {
      expect(() => sdk['resolveFederationOutput'](mockRedeemScript, btcAddresses[1]))
        .toThrowError(FederationAddressError)
    })

    it('should reject a redeem script bitcoinjs cannot interpret', () => {
      expect(() => sdk['resolveFederationOutput'](Buffer.alloc(491, 0x64), mockValues.federationAddress))
        .toThrowError(FederationAddressError)
    })
  })

  it('should allow a peg-out above the network minimum the Bridge enforces', async () => {
    const pegout = await sdk.createPegout('0.003', rskAddresses[0])

    expect(pegout).toBeDefined()
  })

  it('should reject a peg-out below the floor derived from the current fee per kb', async () => {
    const strictSdk = new PowPegSDK({ network: 'TEST', bitcoinSigner: mockedSigner, bitcoinDataSource: mockedDataSource })
    vi.spyOn(strictSdk['bridge'], 'getFeePerKb').mockResolvedValue(500_000n)

    await expect(strictSdk.createPegout('0.005', rskAddresses[0])).rejects.toThrowError(AmountBelowMinError)
  })

  const rejectedPegoutSigner = (reason: number) => {
    const bridgeInterface = new ethers.utils.Interface(bridgePrecompile.abi)
    const { data, topics } = bridgeInterface.encodeEventLog(
      bridgeInterface.getEvent('release_request_rejected'),
      [ethers.constants.AddressZero, 500_000_000_000_000n, reason],
    )
    const receipt = {
      transactionHash: '0xsent',
      logs: [{ address: '0x0000000000000000000000000000000001000006', data, topics }],
    }
    return {
      getChainId: vi.fn().mockResolvedValue(31),
      sendTransaction: vi.fn().mockResolvedValue({ hash: '0xsent' }),
      provider: { waitForTransaction: vi.fn().mockResolvedValue(receipt) },
    } as unknown as ethers.Signer
  }

  it('should surface a peg-out the Bridge rejected instead of reporting success', async () => {
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])
    const error = await sdk.signAndBroadcastPegout(tx, rejectedPegoutSigner(1)).catch((e) => e)

    expect(error).toBeInstanceOf(PegoutRejectedError)
    expect(error.reason).toBe(1)
    expect(error.amount).toBe(500_000_000_000_000n)
    expect(error.message).toContain('was refunded')
  })

  it('should keep the transaction hash of a rejected peg-out on the error', async () => {
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])
    const error = await sdk.signAndBroadcastPegout(tx, rejectedPegoutSigner(1)).catch((e) => e)

    expect(error.txHash).toBe('0xsent')
    expect(error.message).toContain('0xsent')
  })

  it('should ignore a rejection event emitted by a contract other than the Bridge', async () => {
    const bridgeInterface = new ethers.utils.Interface(bridgePrecompile.abi)
    const { data, topics } = bridgeInterface.encodeEventLog(
      bridgeInterface.getEvent('release_request_rejected'),
      [ethers.constants.AddressZero, 500_000_000_000_000n, 1],
    )
    const impostor = { address: '0x00000000000000000000000000000000000c0ffee', data, topics }

    expect(sdk['bridge'].findRejectedPegout([impostor])).toBeUndefined()
  })

  it('should not claim a refund when the Bridge rejected the caller for being a contract', async () => {
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])
    const error = await sdk.signAndBroadcastPegout(tx, rejectedPegoutSigner(2)).catch((e) => e)

    expect(error.reason).toBe(2)
    expect(error.message).toContain('NOT refunded')
    expect(error.message).toContain('remains held by the Bridge')
  })

  it.each(['toString', '__proto__', 'constructor', 'hasOwnProperty'])('should refuse %s as a network name', (network) => {
    expect(() => new PowPegSDK({ network: network as unknown as 'TEST', bitcoinSigner: mockedSigner }))
      .toThrowError('Unknown network')
  })

  it('should pin the configured network on the Rootstock provider', () => {
    new PowPegSDK({ network: 'MAIN' })

    expect(ethers.providers.JsonRpcProvider).toHaveBeenCalledWith('https://public-node.rsk.co', 30)
  })

  it('should include the configured chain id in the peg-out transaction', async () => {
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])

    expect(tx.chainId).toBe(31)
  })

  it('should not send a peg-out when the signer is on another chain', async () => {
    const signer = {
      getChainId: vi.fn().mockResolvedValue(1),
      sendTransaction: vi.fn(),
    } as unknown as ethers.Signer

    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])

    await expect(sdk.signAndBroadcastPegout(tx, signer)).rejects.toThrow(WrongNetworkError)
    expect(signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('should send a peg-out when the signer is on the configured chain', async () => {
    const waitForTransaction = vi.fn().mockResolvedValue({ transactionHash: '0xreceipt', logs: [] })
    const signer = {
      getChainId: vi.fn().mockResolvedValue(31),
      sendTransaction: vi.fn().mockResolvedValue({ hash: '0xsent' }),
      provider: { waitForTransaction },
    } as unknown as ethers.Signer

    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])
    const receipt = await sdk.signAndBroadcastPegout(tx, signer)

    expect(signer.sendTransaction).toHaveBeenCalledWith(tx)
    expect(tx.chainId).toBe(31)
    expect(waitForTransaction).toHaveBeenCalledWith('0xsent')
    expect(receipt).toEqual({ transactionHash: '0xreceipt', logs: [] })
  })

  const pegoutSigner = (chainId = 31) => ({
    getChainId: vi.fn().mockResolvedValue(chainId),
    sendTransaction: vi.fn().mockResolvedValue({ hash: '0xsent' }),
    provider: { waitForTransaction: vi.fn().mockResolvedValue({ transactionHash: '0xreceipt', logs: [] }) },
  } as unknown as ethers.Signer)

  it('should forward every field the caller set to the signer', async () => {
    const signer = pegoutSigner()
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])
    const request = { ...tx, gasPrice: '0x1', nonce: 7, gasLimit: '0x5208', type: 0 }

    await sdk.signAndBroadcastPegout(request, signer)

    expect(signer.sendTransaction).toHaveBeenCalledWith(request)
  })

  it('should surface a peg-out that mined but reverted instead of returning its receipt', async () => {
    const signer = {
      getChainId: vi.fn().mockResolvedValue(31),
      sendTransaction: vi.fn().mockResolvedValue({ hash: '0xsent' }),
      provider: { waitForTransaction: vi.fn().mockResolvedValue({ transactionHash: '0xmined', status: 0, gasUsed: 21_000, logs: [] }) },
    } as unknown as ethers.Signer

    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])
    const error = await sdk.signAndBroadcastPegout(tx, signer).catch((e) => e)

    expect(error).toBeInstanceOf(TransactionRevertedError)
    expect(error.txHash).toBe('0xsent')
    expect(error.receipt).toEqual({ transactionHash: '0xmined', status: 0, gasUsed: 21_000, logs: [] })
  })

  it('should return the receipt of a peg-out that mined without a status field', async () => {
    const signer = {
      getChainId: vi.fn().mockResolvedValue(31),
      sendTransaction: vi.fn().mockResolvedValue({ hash: '0xsent' }),
      provider: { waitForTransaction: vi.fn().mockResolvedValue({ transactionHash: '0xsent', logs: [] }) },
    } as unknown as ethers.Signer

    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])

    await expect(sdk.signAndBroadcastPegout(tx, signer)).resolves.toEqual({ transactionHash: '0xsent', logs: [] })
  })

  it('should not send a peg-out whose chain id is not the configured one', async () => {
    const signer = pegoutSigner()
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])

    await expect(sdk.signAndBroadcastPegout({ ...tx, chainId: 1 }, signer)).rejects.toThrow(WrongNetworkError)
    expect(signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('should not send a peg-out whose chain id is zero', async () => {
    const signer = pegoutSigner()
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])

    await expect(sdk.signAndBroadcastPegout({ ...tx, chainId: 0 }, signer)).rejects.toThrow(WrongNetworkError)
    expect(signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('should reject a chain id that is not a number with a typed error', async () => {
    const signer = pegoutSigner()
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])

    await expect(sdk.signAndBroadcastPegout({ ...tx, chainId: null as unknown as number }, signer)).rejects.toThrow(WrongNetworkError)
    expect(signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('should stamp the configured chain id on a request that omits it', async () => {
    const signer = pegoutSigner()
    const { tx } = await sdk.createPegout('0.005', rskAddresses[0])
    const withoutChainId = { from: tx.from, to: tx.to, value: tx.value, gasPrice: '0x1', nonce: 7, gasLimit: '0x5208' }

    await sdk.signAndBroadcastPegout(withoutChainId, signer)

    expect(signer.sendTransaction).toHaveBeenCalledWith({ ...withoutChainId, chainId: 31 })
  })

  it('should pass its own bounds through to the default ApiService', () => {
    new PowPegSDK({ network: 'TEST', bitcoinSigner: mockedSigner, maxFeeRateSatPerByte: 2500, requestTimeoutMs: 4000 })

    expect(ApiService).toHaveBeenCalledWith('TEST', undefined, 2500, 4000)
  })

  it('should default the API request timeout when none is given', () => {
    new PowPegSDK({ network: 'TEST', bitcoinSigner: mockedSigner })

    expect(ApiService).toHaveBeenCalledWith('TEST', undefined, 1000, 10_000)
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
            federationAddress: mockValues.federationAddress,
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
            federationAddress: mockValues.federationAddress,
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
      const fundingTx = buildFundingTx(1_000_000)
      const selectedUtxos = [
        { address: btcAddresses[0], txid: fundingTx.txid, vout: 0, amount: 1_000_000n },
      ]
      mockedDataSource.getTxHex.mockResolvedValue(fundingTx.hex)

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
      const fundingTx = buildFundingTx(1_000_000)
      mockedDataSource.getOutputs.mockResolvedValue([{ address: btcAddresses[1], amount: 1_000_000n, txid: fundingTx.txid, vout: 0 }])
      mockedDataSource.getTxHex.mockResolvedValue(fundingTx.hex)

      const result = await sdk.createAndFundPegin(500_000n, rskAddresses[0], mockedSigner, 'average')

      expect(result.psbt).toBeDefined()
      expect(result.inputs).toBeDefined()
      expect(result.inputs.length).toBeGreaterThan(0)
      expect(result.fee).toBeGreaterThan(0)
      expect(result.transactions).toBeDefined()
    })
  })

  describe('funding context isolation', () => {
    const fundingTx = buildFundingTx(2_000_000)

    beforeEach(() => {
      vi.clearAllMocks()
      mockedDataSource.getTxHex.mockResolvedValue(fundingTx.hex)
    })

    it('should fund each PSBT with its own UTXOs when peg-ins are created interleaved', async () => {
      const txA = buildFundingTx(2_000_000, 0, 1)
      const txB = buildFundingTx(2_000_000, 0, 2)
      const utxoA = { address: btcAddresses[1], txid: txA.txid, vout: 0, amount: 2_000_000n }
      const utxoB = { address: btcAddresses[2], txid: txB.txid, vout: 0, amount: 2_000_000n }

      const psbtA = await sdk.createPegin(500_000n, rskAddresses[0], [utxoA])
      const psbtB = await sdk.createPegin(500_000n, rskAddresses[0], [utxoB])

      mockedDataSource.getTxHex.mockResolvedValueOnce(txA.hex).mockResolvedValueOnce(txB.hex)
      const fundedA = await sdk.fundPegin(psbtA, 'average')
      const fundedB = await sdk.fundPegin(psbtB, 'average')

      expect(fundedA.inputs).toHaveLength(1)
      expect(fundedA.inputs[0].txid).toBe(utxoA.txid)
      expect(fundedB.inputs).toHaveLength(1)
      expect(fundedB.inputs[0].txid).toBe(utxoB.txid)
    })

    it('should not reuse a previous peg-in change address in createAndFundPsbt', async () => {
      // Never funded (only createPegin runs on it), so this UTXO is never checked against a fetched transaction.
      const previousPeginUtxo = { address: btcAddresses[1], txid: 'a'.repeat(64), vout: 0, amount: 2_000_000n }
      await sdk.createPegin(500_000n, rskAddresses[0], [previousPeginUtxo])

      const psbtUtxo = { address: btcAddresses[4], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }
      const { psbt } = await sdk.createAndFundPsbt(500_000n, btcAddresses[3], [psbtUtxo], 'average')

      const changeOutput = psbt.txOutputs[1]
      expect(changeOutput.address).toBe(psbtUtxo.address)
      expect(changeOutput.address).not.toBe(btcAddresses[0])
    })

    it('should fail to fund a PSBT that has no funding context', async () => {
      await expect(sdk.fundPegin(new Psbt(), 'average')).rejects.toThrow('No funding context')
    })

    it('should fail to fund the same PSBT twice', async () => {
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo])

      await expect(sdk.fundPegin(psbt, 'average')).resolves.toBeDefined()
      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrow('No funding context')
    })

    it('should leave the PSBT unmodified when funding fails, allowing a retry', async () => {
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo])
      const outputCountBefore = psbt.txOutputs.length

      mockedDataSource.getTxHex.mockRejectedValueOnce(new Error('network error'))
      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrow('network error')
      expect(psbt.txOutputs).toHaveLength(outputCountBefore)
      expect(psbt.txInputs).toHaveLength(0)

      const funded = await sdk.fundPegin(psbt, 'average')
      expect(funded.psbt.txInputs).toHaveLength(1)
      expect(funded.psbt.txOutputs).toHaveLength(outputCountBefore + 1)
    })

    it('should leave the PSBT unmodified when a fetched transaction fails to parse, allowing a retry', async () => {
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo])
      const outputCountBefore = psbt.txOutputs.length

      mockedDataSource.getTxHex.mockResolvedValueOnce('00'.repeat(4))
      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrow()
      expect(psbt.txOutputs).toHaveLength(outputCountBefore)
      expect(psbt.txInputs).toHaveLength(0)

      const funded = await sdk.fundPegin(psbt, 'average')
      expect(funded.psbt.txInputs).toHaveLength(1)
      expect(funded.psbt.txOutputs).toHaveLength(outputCountBefore + 1)
    })

    it('should leave the PSBT unmodified when a UTXO references a vout that does not exist on its fetched transaction', async () => {
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 5, amount: 2_000_000n }
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo])
      const outputCountBefore = psbt.txOutputs.length

      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrow('was not found in the fetched transaction')
      expect(psbt.txOutputs).toHaveLength(outputCountBefore)
      expect(psbt.txInputs).toHaveLength(0)
    })

    it('should reject a UTXO whose fetched transaction is not actually the one that was requested', async () => {
      const wrongTx = buildFundingTx(2_000_000, 0, 99)
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo])

      mockedDataSource.getTxHex.mockResolvedValueOnce(wrongTx.hex)
      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrow('does not match the requested txid')
    })

    it('should reject a UTXO whose fetched transaction reports a different value than claimed', async () => {
      const mismatchedValueTx = buildFundingTx(999_999, 0, 30)
      const utxo = { address: btcAddresses[1], txid: mismatchedValueTx.txid, vout: 0, amount: 2_000_000n }
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [utxo])

      mockedDataSource.getTxHex.mockResolvedValueOnce(mismatchedValueTx.hex)
      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrow('value mismatch')
    })

    it('should block a retry after a mid-mutation failure instead of allowing it to double-mutate the PSBT', async () => {
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }
      const psbt = await sdk.createPegin(3_500_000n, rskAddresses[0], [utxo, { ...utxo }])

      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrow('Duplicate input')
      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrow('No funding context')
    })

    it('should keep a PSBT bound to the signer active when it was created, even if the instance-level signer changes before signing', async () => {
      const changeAddressA = 'mChangeAddressSignerA00000000000000'
      const changeAddressB = 'mChangeAddressSignerB00000000000000'
      let resolveSignerAChangeAddresses: (addresses: string[]) => void
      const signerA = {
        getNonChangeAddresses: vi.fn().mockReturnValue(btcAddresses.slice(1)),
        getChangeAddresses: vi.fn(() => new Promise<string[]>((resolve) => { resolveSignerAChangeAddresses = resolve })),
        signTransaction: vi.fn().mockResolvedValue('signed-by-signer-a'),
      } satisfies BitcoinSigner
      const signerB = {
        getNonChangeAddresses: vi.fn().mockReturnValue(btcAddresses.slice(1)),
        getChangeAddresses: vi.fn().mockResolvedValue([changeAddressB]),
        signTransaction: vi.fn(),
      } satisfies BitcoinSigner
      const utxoA = { address: btcAddresses[1], txid: 'c'.repeat(64), vout: 0, amount: 2_000_000n }
      const utxoB = { address: btcAddresses[1], txid: 'd'.repeat(64), vout: 0, amount: 2_000_000n }

      sdk['bitcoinSigner'] = signerA
      const pendingA = sdk.createPegin(500_000n, rskAddresses[0], [utxoA])
      sdk['bitcoinSigner'] = signerB
      await sdk.createPegin(500_000n, rskAddresses[0], [utxoB])
      resolveSignerAChangeAddresses!([changeAddressA])
      const psbtA = await pendingA
      sdk['bitcoinSigner'] = mockedSigner

      await sdk.signAndBroadcastPegin(psbtA)

      expect(signerA.signTransaction).toHaveBeenCalledWith(psbtA, undefined, undefined)
      expect(signerB.signTransaction).not.toHaveBeenCalled()
    })

    it('should not mutate the instance-level signer as a side effect of createAndFundPegin', async () => {
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }
      const otherSigner = {
        getNonChangeAddresses: vi.fn().mockReturnValue(btcAddresses.slice(1)),
        getChangeAddresses: vi.fn().mockReturnValue(btcAddresses.slice(0, 1)),
        signTransaction: vi.fn(),
      } satisfies BitcoinSigner

      sdk['bitcoinSigner'] = mockedSigner
      await sdk.createAndFundPegin(500_000n, rskAddresses[0], otherSigner, 'average', [utxo])

      expect(sdk['bitcoinSigner']).toBe(mockedSigner)
    })

    it('should sign a PSBT from createAndFundPsbt with the signer passed to it, not the instance signer', async () => {
      const psbtSigner = {
        getNonChangeAddresses: vi.fn(),
        getChangeAddresses: vi.fn(),
        signTransaction: vi.fn().mockResolvedValue('signed-by-psbt-signer'),
      } satisfies BitcoinSigner
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }

      const { psbt, inputs, transactions } = await sdk.createAndFundPsbt(500_000n, btcAddresses[2], [utxo], 'average', psbtSigner)
      await sdk.signAndBroadcastPegin(psbt, inputs, transactions)

      expect(psbtSigner.signTransaction).toHaveBeenCalledWith(psbt, inputs, transactions)
      expect(mockedSigner.signTransaction).not.toHaveBeenCalled()
    })

    it('should not broadcast when the signer returns no signed transaction', async () => {
      const failingSigner = {
        getNonChangeAddresses: vi.fn(),
        getChangeAddresses: vi.fn(),
        signTransaction: vi.fn().mockResolvedValue(''),
      } satisfies BitcoinSigner
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }

      const { psbt, inputs, transactions } = await sdk.createAndFundPsbt(500_000n, btcAddresses[2], [utxo], 'average', failingSigner)

      await expect(sdk.signAndBroadcastPegin(psbt, inputs, transactions)).rejects.toThrow(SigningError)
      expect(mockedDataSource.broadcast).not.toHaveBeenCalled()
    })

    it('should fail to sign a PSBT that has no signer bound to it', async () => {
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }

      const { psbt, inputs, transactions } = await sdk.createAndFundPsbt(500_000n, btcAddresses[2], [utxo], 'average')

      await expect(sdk.signAndBroadcastPegin(psbt, inputs, transactions)).rejects.toThrow('No signer bound to this PSBT')
    })
  })

  describe('BitcoinDataSource address integrity', () => {
    const fundingTx = buildFundingTx(2_000_000, 0, 14)

    it('should keep the address it queried for a UTXO, not the one a hostile getOutputs echoes', async () => {
      const attackerAddress = 'mAttackerUtxoAddress00000000000000'
      const usedAddress = btcAddresses[1]
      const hostileDataSource = {
        getAddressDetails: vi.fn().mockImplementation((address: string) => Promise.resolve({
          address,
          balance: address === usedAddress ? 1 : 0,
          txCount: address === usedAddress ? 1 : 0,
        })),
        getFeeRate: vi.fn().mockResolvedValue(mockValues.bitcoinFeeRate),
        getOutputs: vi.fn().mockResolvedValue([{ address: attackerAddress, txid: fundingTx.txid, vout: 0, amount: 2_000_000n }]),
        getTxHex: vi.fn().mockResolvedValue(fundingTx.hex),
        broadcast: vi.fn(),
      } satisfies BitcoinDataSource
      const hostileSdk = new PowPegSDK({ network: 'TEST', bitcoinSigner: mockedSigner, bitcoinDataSource: hostileDataSource })

      const psbt = await hostileSdk.createPegin(500_000n, rskAddresses[0])
      const funded = await hostileSdk.fundPegin(psbt, 'average')

      expect(funded.inputs).toHaveLength(1)
      expect(funded.inputs[0].address).toBe(usedAddress)
      expect(funded.inputs[0].address).not.toBe(attackerAddress)
    })

    it('should keep the address it queried for the change output, not the one a hostile getAddressDetails echoes', async () => {
      const attackerAddress = 'mAttackerChangeAddress0000000000000'
      const hostileDataSource = {
        getAddressDetails: vi.fn().mockResolvedValue({ address: attackerAddress, balance: 0, txCount: 0 }),
        getFeeRate: vi.fn().mockResolvedValue(mockValues.bitcoinFeeRate),
        getOutputs: vi.fn().mockResolvedValue([]),
        getTxHex: vi.fn().mockResolvedValue(fundingTx.hex),
        broadcast: vi.fn(),
      } satisfies BitcoinDataSource
      const hostileSdk = new PowPegSDK({ network: 'TEST', bitcoinSigner: mockedSigner, bitcoinDataSource: hostileDataSource })
      const utxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 2_000_000n }

      const psbt = await hostileSdk.createPegin(500_000n, rskAddresses[0], [utxo])
      const funded = await hostileSdk.fundPegin(psbt, 'average')

      const changeOutput = funded.psbt.txOutputs[2]
      expect(changeOutput.address).toBe(btcAddresses[0])
      expect(changeOutput.address).not.toBe(attackerAddress)
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

  describe('fee rate validation', () => {
    const fundableUtxo = (txid: string) => ({ address: btcAddresses[1], txid, vout: 0, amount: 2_000_000n })

    it.each([0, -5, 1.5, NaN])('should reject a fee rate of %p from the data source', async (feeRate) => {
      mockedDataSource.getFeeRate.mockReturnValueOnce(feeRate)
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [fundableUtxo(`invalid-rate-${feeRate}`)])

      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrowError(InvalidFeeRateError)
    })

    it('should reject a fee rate above the configured bound', async () => {
      mockedDataSource.getFeeRate.mockReturnValueOnce(1001)
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [fundableUtxo('above-bound')])

      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrowError(InvalidFeeRateError)
    })

    it('should reject a fee disproportionate to the amount being sent, even at an in-bounds rate', async () => {
      mockedDataSource.getFeeRate.mockReturnValueOnce(1000)
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [fundableUtxo('disproportionate-fee')])

      await expect(sdk.fundPegin(psbt, 'average')).rejects.toThrowError(InvalidFeeRateError)
    })

    it('should reject an out-of-bounds fee rate passed explicitly to fundPegin, bypassing the data source', async () => {
      const psbt = await sdk.createPegin(500_000n, rskAddresses[0], [fundableUtxo('explicit-rate-bypass')])

      await expect(sdk.fundPegin(psbt, 'average', undefined, 1001)).rejects.toThrowError(InvalidFeeRateError)
    })

    it('should forward an explicit fee rate from createAndFundPegin down to fundPegin', async () => {
      await expect(
        sdk.createAndFundPegin(500_000n, rskAddresses[0], mockedSigner, 'average', [fundableUtxo('createAndFundPegin-rate-bypass')], 1001),
      ).rejects.toThrowError(InvalidFeeRateError)
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
      const fundingTx = buildFundingTx(1_000_000, 0, 21)
      const duplicateUtxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 1_000_000n }

      mockedDataSource.getAddressDetails
        .mockResolvedValueOnce({ address: btcAddresses[1], balance: 1_000_000, txCount: 1 })
        .mockResolvedValueOnce({ address: btcAddresses[2], balance: 1_000_000, txCount: 1 })

      mockedDataSource.getOutputs
        .mockResolvedValueOnce([duplicateUtxo])
        .mockResolvedValueOnce([duplicateUtxo])

      mockedDataSource.getTxHex.mockResolvedValue(fundingTx.hex)

      const result = await sdk.createAndFundPegin(500_000n, rskAddresses[0], mockedSigner, 'average')

      expect(result.psbt).toBeDefined()
      expect(result.inputs).toBeDefined()
      expect(result.inputs.length).toBe(1)
      expect(result.inputs[0].txid).toBe(duplicateUtxo.txid)
      expect(result.inputs[0].vout).toBe(duplicateUtxo.vout)
    })

    it('should create PSBT with no duplicate inputs when API returns duplicates', async () => {
      const fundingTx = buildFundingTx(1_000_000, 0, 22)
      const duplicateUtxo = { address: btcAddresses[1], txid: fundingTx.txid, vout: 0, amount: 1_000_000n }
      const uniqueUtxo = { address: btcAddresses[2], txid: 'a2399abede23d11581f898eaa3b900b5fe09b8e7366bfb362e42173123fdb188', vout: 0, amount: 800_000n }

      mockedDataSource.getAddressDetails
        .mockResolvedValueOnce({ address: btcAddresses[1], balance: 1_000_000, txCount: 1 })
        .mockResolvedValueOnce({ address: btcAddresses[2], balance: 800_000, txCount: 1 })

      mockedDataSource.getOutputs
        .mockResolvedValueOnce([duplicateUtxo, uniqueUtxo])
        .mockResolvedValueOnce([duplicateUtxo])

      mockedDataSource.getTxHex.mockResolvedValue(fundingTx.hex)

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
