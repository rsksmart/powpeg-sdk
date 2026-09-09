import { isBtcMainnetAddress, isBtcTestnetAddress } from '@rsksmart/bridges-core-sdk'
import { networks as bitcoinJsNetworks } from 'bitcoinjs-lib'

export const networks = {
  TEST: {
    lib: bitcoinJsNetworks.testnet,
    isBtcAddress: isBtcTestnetAddress,
  },
  MAIN: {
    lib: bitcoinJsNetworks.bitcoin,
    isBtcAddress: isBtcMainnetAddress,
  },
} as const

export type Network = keyof typeof networks
