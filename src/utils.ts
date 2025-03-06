import type { Network } from './types'

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
