import { isBtcMainnetAddress, isBtcTestnetAddress } from '@rsksmart/bridges-core-sdk'
import { networks as bitcoinJsNetworks } from 'bitcoinjs-lib'

export const supportedAddressTypes = {
  'NATIVE SEGWIT': {
    path: '84',
    format: 'bech32',
  },
  'SEGWIT': {
    path: '49',
    format: 'p2sh',
  },
  'LEGACY': {
    path: '44',
    format: 'legacy',
  },
} as const

export const networks = {
  TEST: {
    currency: 'bitcoin_testnet',
    coin: '1',
    lib: bitcoinJsNetworks.testnet,
    xpubVersion: 0x043587cf,
    isBtcAddress: isBtcTestnetAddress,
  },
  MAIN: {
    currency: 'bitcoin',
    coin: '0',
    lib: bitcoinJsNetworks.bitcoin,
    xpubVersion: 0x0488b21e,
    isBtcAddress: isBtcMainnetAddress,
  },
} as const

export type AddressType = keyof typeof supportedAddressTypes

export type Network = keyof typeof networks
