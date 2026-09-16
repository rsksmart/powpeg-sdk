import type { Network } from './constants'

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

/** Whether a scriptPubKey is P2SH: `OP_HASH160 <20-byte hash> OP_EQUAL`. */
export function isP2shScript(script: Buffer) {
  return script.length === 23 && script[0] === 0xA9 && script[1] === 0x14 && script[22] === 0x87
}

/**
 * Whether a scriptPubKey is a BIP141 witness program: a version opcode (`OP_0`, or `OP_1` through
 * `OP_16`) followed by a single push of 2 to 40 bytes. Covers P2WPKH, P2WSH and P2TR.
 */
export function isWitnessProgramScript(script: Buffer) {
  if (script.length < 4 || script.length > 42) {
    return false
  }
  const version = script[0]
  if (version !== 0x00 && (version < 0x51 || version > 0x60)) {
    return false
  }
  return script[1] === script.length - 2
}

/** Whether a scriptPubKey is P2PKH: `OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG`. */
export function isP2pkhScript(script: Buffer) {
  return script.length === 25 && script[0] === 0x76 && script[1] === 0xA9 && script[2] === 0x14
    && script[23] === 0x88 && script[24] === 0xAC
}

/** Whether a scriptPubKey is P2WPKH: witness version 0 with a 20-byte program. */
export function isP2wpkhScript(script: Buffer) {
  return script.length === 22 && script[0] === 0x00 && script[1] === 0x14
}

/**
 * Whether the SDK can build a PSBT input a `BitcoinSigner` is able to sign for this scriptPubKey.
 * P2PKH and P2WPKH are signable from the address alone; every other type needs a redeem script, a
 * witness script or a key the signer contract does not expose.
 */
export function isSupportedFundingScript(script: Buffer) {
  return isP2pkhScript(script) || isP2wpkhScript(script)
}
