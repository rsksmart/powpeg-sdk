import type { AddressType, Network } from './constants'
import { initEccLib, type Network as BitcoinJsNetwork, payments } from 'bitcoinjs-lib'
import { networks } from './constants'
import * as ecc from 'tiny-secp256k1'
import BIP32Factory from 'bip32'

export function remove0x(hex: string) {
  return hex.startsWith('0x') ? hex.slice(2) : hex
}

const addressTypeRegex = {
  TEST: {
    LEGACY: /^[mn][1-9A-HJ-NP-Za-km-z]{26,35}/,
    SEGWIT: /^[2][1-9A-HJ-NP-Za-km-z]{26,35}/,
    NATIVE_SEGWIT: /^[tb1][0-9A-HJ-NP-Za-z]{41,62}/,
  },
  MAIN: {
    LEGACY: /^[1][1-9A-HJ-NP-Za-km-z]{26,35}/,
    SEGWIT: /^[3][1-9A-HJ-NP-Za-km-z]{26,35}/,
    NATIVE_SEGWIT: /^[bc1][0-9A-HJ-NP-Za-z]{41,62}/,
  },
}

export function getAddressType(address: string, network: Network) {
  const { LEGACY, SEGWIT, NATIVE_SEGWIT } = addressTypeRegex[network]
  if (LEGACY.test(address)) {
    return 'LEGACY'
  }
  if (SEGWIT.test(address)) {
    return 'SEGWIT'
  }
  if (NATIVE_SEGWIT.test(address)) {
    return 'NATIVE SEGWIT'
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(() => resolve(true), ms))
}

const pubkeyAddressGenerators = {
  'LEGACY': (pubkey: Buffer, network: BitcoinJsNetwork) => payments.p2pkh({ pubkey, network }),
  'SEGWIT': (pubkey: Buffer, network: BitcoinJsNetwork) => payments.p2sh({ redeem: payments.p2wpkh({ pubkey, network }), network }),
  'NATIVE SEGWIT': (pubkey: Buffer, network: BitcoinJsNetwork) => payments.p2wpkh({ pubkey, network }),
}

function getAddressFromPubKey(pubkey: Buffer, addressType: AddressType, network: BitcoinJsNetwork) {
  const generator = pubkeyAddressGenerators[addressType]
  if (!generator) throw new Error(`Unsupported address type: ${addressType}`)
  return generator(pubkey, network)
}

export function deriveAddress(xpub: string, index: number, addressType: AddressType, network: Network) {
  const { lib: networkLib } = networks[network]
  initEccLib(ecc)
  const bip32 = BIP32Factory(ecc)
  const node = bip32.fromBase58(xpub, networkLib)
  const pubkey = Buffer.from(node.derive(index).publicKey)
  if (!pubkey) {
    throw new Error(`Failed to derive public key for index ${index}`)
  }
  const { address } = getAddressFromPubKey(pubkey, addressType, networkLib)
  if (!address) {
    throw new Error('Failed to generate address')
  }
  return address
}
