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

/**
 * The network names as values, so callers can write `Network.TEST` instead of the bare string. Shares
 * its name with the type above: TypeScript keeps values and types in separate declaration spaces, so
 * `Network` is both. The mapped annotation keeps it in step with `networks` — adding a network there
 * fails to compile until it is added here too.
 */
export const Network: { [K in Network]: K } = {
  MAIN: 'MAIN',
  TEST: 'TEST',
}
