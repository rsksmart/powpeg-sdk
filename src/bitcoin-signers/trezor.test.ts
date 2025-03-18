import { describe, it, expect, vi, beforeAll } from 'vitest'
import TrezorConnect from '@trezor/connect-web'
import { TrezorSigner } from './trezor'
import { Psbt } from 'bitcoinjs-lib'
import type { Utxo } from '../types'

vi.mock('@trezor/connect-web', () => ({
  default: {
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getAddress: vi.fn(),
    signTransaction: vi.fn(),
  },
}))

describe('TrezorSigner', () => {
  let trezor: TrezorSigner

  beforeAll(async () => {
    trezor = await TrezorSigner.init('TEST')
  })

  it('should initialize without errors', async () => {
    expect(TrezorConnect.init).toHaveBeenCalled()
  })
  it('should use specified address type', async () => {
    trezor.addressType = 'LEGACY'
    expect(trezor.addressType).toBe('LEGACY')
    trezor.addressType = 'SEGWIT'
    expect(trezor.addressType).toBe('SEGWIT')
    trezor.addressType = 'NATIVE SEGWIT'
    expect(trezor.addressType).toBe('NATIVE SEGWIT')
  })
  it('should return different type of addresses with correct paths', async () => {
    vi.mocked(TrezorConnect.getAddress).mockResolvedValueOnce({
      success: true,
      payload: [
        { address: 'mock-address-1', path: [84, 1, 0, 0, 0], serializedPath: '' },
        { address: 'mock-address-2', path: [84, 1, 0, 0, 1], serializedPath: '' },
      ],
    })
    vi.mocked(TrezorConnect.getAddress).mockResolvedValueOnce({
      success: true,
      payload: [
        { address: 'mock-address-3', path: [84, 1, 0, 1, 2], serializedPath: '' },
        { address: 'mock-address-4', path: [84, 1, 0, 1, 3], serializedPath: '' },
      ],
    })
    const nonChange = await trezor.getNonChangeAddresses(2)
    const change = await trezor.getChangeAddresses(2)

    expect(nonChange).toEqual(['mock-address-1', 'mock-address-2'])
    expect(trezor['addresses'].get('mock-address-1')).toEqual([84, 1, 0, 0, 0])
    expect(trezor['addresses'].get('mock-address-2')).toEqual([84, 1, 0, 0, 1])
    expect(change).toEqual(['mock-address-3', 'mock-address-4'])
    expect(trezor['addresses'].get('mock-address-3')).toEqual([84, 1, 0, 1, 2])
    expect(trezor['addresses'].get('mock-address-4')).toEqual([84, 1, 0, 1, 3])
    expect(TrezorConnect.getAddress).toHaveBeenCalledTimes(2)
  })
  it('should return empty string if sign fails', async () => {
    vi.mocked(TrezorConnect.signTransaction).mockResolvedValue({ success: false, payload: { error: '' } })
    const signedTx = await trezor.signTransaction(new Psbt(), [])

    expect(signedTx).toBe('')
    expect(TrezorConnect.signTransaction).toHaveBeenCalled()
  })

  it('should transform legacy UTXOs correctly into Trezor input type', () => {
    trezor['addresses'].set('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', [])
    const utxos: Utxo[] = [
      { address: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', txid: 'mock-txid', vout: 0, amount: 1000n },
    ]
    const inputs = trezor['getInputs'](utxos)

    expect(inputs).toEqual([
      {
        address_n: [],
        prev_hash: 'mock-txid',
        prev_index: 0,
        script_type: 'SPENDADDRESS',
        amount: 1000,
      },
    ])
  })

  it('should transform segwit UTXOs correctly into Trezor input type', () => {
    trezor['addresses'].set('2N7eSt5myGSXoiAnqpzu856EwgA8SHg53Lg', [])
    const utxos: Utxo[] = [
      { address: '2N7eSt5myGSXoiAnqpzu856EwgA8SHg53Lg', txid: 'mock-txid', vout: 1, amount: 1000n },
    ]
    const inputs = trezor['getInputs'](utxos)

    expect(inputs).toEqual([
      {
        address_n: [],
        prev_hash: 'mock-txid',
        prev_index: 1,
        script_type: 'SPENDP2SHWITNESS',
        amount: 1000,
      },
    ])
  })

  it('should transform native segwit UTXOs correctly into Trezor input type', () => {
    trezor['addresses'].set('tb1qm0f4nu37q8u82txpj0l0cp924836gs2q4m9rdf', [])
    const utxos: Utxo[] = [
      { address: 'tb1qm0f4nu37q8u82txpj0l0cp924836gs2q4m9rdf', txid: 'mock-txid', vout: 2, amount: 1000n },
    ]
    const inputs = trezor['getInputs'](utxos)

    expect(inputs).toEqual([
      {
        address_n: [],
        prev_hash: 'mock-txid',
        prev_index: 2,
        script_type: 'SPENDWITNESS',
        amount: 1000,
      },
    ])
  })
})
