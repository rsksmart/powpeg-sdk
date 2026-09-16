import { describe, expect, it } from 'vitest'
import { crypto as bitcoinJsCrypto, networks, payments } from 'bitcoinjs-lib'
import { isP2shScript, isWitnessProgramScript } from './utils'

describe('isP2shScript', () => {
  const network = networks.testnet
  const hash = bitcoinJsCrypto.hash160(Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'))
  const witnessHash = bitcoinJsCrypto.sha256(Buffer.alloc(32, 7))

  it('should recognise a P2SH scriptPubKey', () => {
    expect(isP2shScript(payments.p2sh({ redeem: payments.p2wpkh({ hash, network }), network }).output as Buffer)).toBe(true)
  })

  it.each([
    ['P2PKH', () => payments.p2pkh({ hash, network }).output as Buffer],
    ['P2WPKH', () => payments.p2wpkh({ hash, network }).output as Buffer],
    ['P2WSH', () => payments.p2wsh({ hash: witnessHash, network }).output as Buffer],
    ['OP_RETURN', () => payments.embed({ data: [Buffer.alloc(20, 1)] }).output as Buffer],
  ])('should not mistake a %s scriptPubKey for P2SH', (_label, build) => {
    expect(isP2shScript(build())).toBe(false)
  })

  it.each([
    ['merely starts with OP_HASH160', `a914${'11'.repeat(20)}88ac`],
    ['is 23 bytes but carries no opcodes', '00'.repeat(23)],
    ['has the P2SH prefix but not the OP_EQUAL terminator', `a914${'11'.repeat(20)}00`],
    ['has the P2SH shape but the wrong push length', `a913${'11'.repeat(20)}87`],
    ['matches the P2SH bytes but runs past the template', `a914${'11'.repeat(20)}87deadbeef`],
  ])('should not match a non-standard script that %s', (_label, hex) => {
    expect(isP2shScript(Buffer.from(hex, 'hex'))).toBe(false)
  })
})

describe('isWitnessProgramScript', () => {
  const network = networks.testnet
  const hash = bitcoinJsCrypto.hash160(Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'))
  const witnessHash = bitcoinJsCrypto.sha256(Buffer.alloc(32, 7))

  it.each([
    ['P2WPKH', () => payments.p2wpkh({ hash, network }).output as Buffer],
    ['P2WSH', () => payments.p2wsh({ hash: witnessHash, network }).output as Buffer],
    ['P2TR', () => Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 9)])],
  ])('should recognise %s as a witness program', (_label, build) => {
    expect(isWitnessProgramScript(build())).toBe(true)
  })

  it.each([
    ['P2PKH', () => payments.p2pkh({ hash, network }).output as Buffer],
    ['P2SH', () => payments.p2sh({ redeem: payments.p2wpkh({ hash, network }), network }).output as Buffer],
    ['OP_RETURN', () => payments.embed({ data: [Buffer.alloc(20, 1)] }).output as Buffer],
    ['an empty script', () => Buffer.alloc(0)],
  ])('should not recognise %s as a witness program', (_label, build) => {
    expect(isWitnessProgramScript(build())).toBe(false)
  })

  it.each([
    ['the push length disagrees with the script length', '0013' + '11'.repeat(20)],
    ['the version byte is not an opcode in the witness range', '4c14' + '11'.repeat(20)],
    ['the program is shorter than two bytes', '0001' + '11'],
    ['the program is longer than forty bytes', '0029' + '11'.repeat(41)],
  ])('should reject a script where %s', (_label, hex) => {
    expect(isWitnessProgramScript(Buffer.from(hex, 'hex'))).toBe(false)
  })
})
