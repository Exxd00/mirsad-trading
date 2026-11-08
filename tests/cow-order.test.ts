import { describe, expect, it } from 'vitest';
import { hashDomain, zeroAddress } from 'viem';
import { assertCowOrderUid, COW_CHAIN_ID, COW_DOMAIN, COW_SETTLEMENT, COW_VAULT_RELAYER,
  cowOrderDigest, cowOrderUid, normalizeCowAddress, normalizeCowOrder, normalizeCowUid } from '../src/lib/wallet/cow-order';

const owner = '0x1111111111111111111111111111111111111111';
const another = '0x2222222222222222222222222222222222222222';
const uint256Max = ((1n << 256n) - 1n).toString();
function rawOrder(): Record<string, unknown> {
  return { sellToken: '0x6b175474e89094c44da98b954eedeac495271d0f',
    buyToken: '0xdef1ca1fb7fbcdc777520aa7f396b4e015f497ab', receiver: owner,
    sellAmount: '10000000000000000000000000', buyAmount: '10000', validTo: 1704067200,
    appData: '0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4',
    feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
}

describe('bounded Ethereum CoW order identity', () => {
  it('pins the Ethereum deployment and the historical GPv2 signing domain', () => {
    expect(COW_CHAIN_ID).toBe(1);
    expect(COW_SETTLEMENT).toBe('0x9008D19f58AAbD9eD0D60971565AA8510560ab41');
    expect(COW_VAULT_RELAYER).toBe('0xC92E8bdf79f0507f65a392b0ab4667716BFE0110');
    expect(COW_DOMAIN).toEqual({ name: 'Gnosis Protocol', version: 'v2', chainId: 1, verifyingContract: COW_SETTLEMENT });
    expect(Object.isFrozen(COW_DOMAIN)).toBe(true);
    const domainTypes = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } as const;
    expect(hashDomain({ domain: { ...COW_DOMAIN, chainId: BigInt(COW_CHAIN_ID) }, types: domainTypes }))
      .toBe('0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943');
  });

  it('matches a fixed EIP-712/packed-UID vector and preserves base-unit precision', () => {
    // The vector was computed independently using GPv2Order's type hash,
    // ABI-encoded fields, and keccak256(0x1901 || domain || structHash).
    const order = normalizeCowOrder(rawOrder());
    const uid = cowOrderUid(order, owner);
    expect(cowOrderDigest(order)).toBe('0x32ebd2210646759cfe3fb231ad7371f8e9a95b9ad56d2f41f694c516c8b98bee');
    expect(uid.slice(0, 66)).toBe(cowOrderDigest(order));
    expect(uid).toBe('0x32ebd2210646759cfe3fb231ad7371f8e9a95b9ad56d2f41f694c516c8b98bee111111111111111111111111111111111111111165920080');
    expect(uid).toHaveLength(2 + 56 * 2);
    expect(uid.slice(66, 106)).toBe(owner.slice(2));
    expect(uid.slice(106)).toBe('65920080');
    expect(order.sellAmount).toBe('10000000000000000000000000');
    expect(assertCowOrderUid(uid, order, owner)).toBe(uid);
  });

  it('normalizes address and bytes casing without changing deterministic identity', () => {
    const raw = rawOrder(), order = normalizeCowOrder(raw);
    const uppercase = (value: unknown) => '0x' + String(value).slice(2).toUpperCase();
    const normalized = normalizeCowOrder({ ...raw, sellToken: normalizeCowAddress(raw.sellToken),
      buyToken: normalizeCowAddress(raw.buyToken), appData: uppercase(raw.appData) });
    expect(normalized).toEqual(order);
    expect(normalized.sellToken).toBe('0x6B175474E89094C44Da98b954EedeAC495271d0F');
    expect(cowOrderUid(normalized, owner)).toBe(cowOrderUid(order, owner));
    const uid = cowOrderUid(order, owner);
    expect(normalizeCowUid(uppercase(uid))).toBe(uid);
  });

  it.each([zeroAddress, '0x123', '0x' + 'g'.repeat(40), '0x' + '1'.repeat(41), '', null, 1])('rejects invalid or zero identity %s', raw => {
    expect(() => normalizeCowAddress(raw)).toThrow('cow_address_invalid');
    for (const field of ['sellToken', 'buyToken', 'receiver'])
      expect(() => normalizeCowOrder({ ...rawOrder(), [field]: raw })).toThrow('cow_address_invalid');
    expect(() => cowOrderUid(normalizeCowOrder(rawOrder()), raw as string)).toThrow('cow_address_invalid');
  });

  it('rejects an invalid mixed-case checksum and same-token orders', () => {
    expect(() => normalizeCowAddress('0x6B175474E89094C44Da98b954EedeAC495271d0f')).toThrow('cow_address_invalid');
    const raw = rawOrder();
    expect(() => normalizeCowOrder({ ...raw, buyToken: raw.sellToken })).toThrow('cow_order_invalid');
  });

  it.each(['0', '01', '-1', '+1', '1.0', '1e3', '0x1', '', ' 1', 1, 1n,
    ((1n << 256n)).toString(), '1'.repeat(79)])('rejects noncanonical or out-of-range token amounts %s', value => {
    for (const field of ['sellAmount', 'buyAmount'])
      expect(() => normalizeCowOrder({ ...rawOrder(), [field]: value })).toThrow('cow_order_invalid');
  });

  it('accepts uint256 boundary amounts without narrowing to JS numbers', () => {
    const order = normalizeCowOrder({ ...rawOrder(), sellAmount: uint256Max, buyAmount: '1' });
    expect(order.sellAmount).toBe(uint256Max);
    expect(cowOrderUid(order, owner)).toHaveLength(114);
  });

  it.each([-1, 0x100000000, 1.5, NaN, Infinity, '1', 1n, null, undefined])('rejects a non-uint32 validTo %s', validTo => {
    expect(() => normalizeCowOrder({ ...rawOrder(), validTo })).toThrow('cow_order_invalid');
  });

  it('encodes uint32 validity boundaries in four bytes with big-endian order', () => {
    expect(cowOrderUid(normalizeCowOrder({ ...rawOrder(), validTo: 0 }), owner).slice(-8)).toBe('00000000');
    expect(cowOrderUid(normalizeCowOrder({ ...rawOrder(), validTo: 0xffffffff }), owner).slice(-8)).toBe('ffffffff');
  });

  it.each([
    { feeAmount: '1' }, { feeAmount: 0 }, { feeAmount: '00' }, { kind: 'BUY' }, { kind: 0 },
    { partiallyFillable: 'false' }, { partiallyFillable: 0 },
    { sellTokenBalance: 'external' }, { buyTokenBalance: 'internal' },
    { appData: '0x' + '1'.repeat(63) }, { appData: '0x' + '1'.repeat(65) }, { appData: '0x' + 'g'.repeat(64) },
  ])('rejects unsupported order fields %j', change => {
    expect(() => normalizeCowOrder({ ...rawOrder(), ...change })).toThrow('cow_order_invalid');
  });

  it('requires every GPv2 field and rejects extensions instead of discarding them', () => {
    for (const key of Object.keys(rawOrder())) {
      const incomplete = rawOrder(); delete incomplete[key];
      expect(() => normalizeCowOrder(incomplete)).toThrow('cow_order_invalid');
    }
    for (const extension of [{ chainId: 100 }, { owner }, { signature: 'hidden' }, { quoteId: 1 }, { [Symbol('extra')]: true }])
      expect(() => normalizeCowOrder({ ...rawOrder(), ...extension })).toThrow('cow_order_invalid');
    for (const invalid of [undefined, null, [], 'order', 1])
      expect(() => normalizeCowOrder(invalid)).toThrow('cow_order_invalid');
  });

  it('changes the UID for changed signed intent or owner and detects mismatched evidence', () => {
    const order = normalizeCowOrder(rawOrder()), uid = cowOrderUid(order, owner);
    for (const change of [{ sellToken: another }, { buyToken: another }, { receiver: another }, { sellAmount: '1' },
      { buyAmount: '1' }, { validTo: order.validTo + 1 }, { appData: '0x' + '0'.repeat(64) },
      { kind: 'buy' }, { partiallyFillable: true }]) {
      const changed = normalizeCowOrder({ ...order, ...change });
      expect(cowOrderUid(changed, owner)).not.toBe(uid);
      expect(() => assertCowOrderUid(uid, changed, owner)).toThrow('cow_order_uid_mismatch');
    }
    expect(cowOrderUid(order, another)).not.toBe(uid);
    expect(() => assertCowOrderUid(uid, order, another)).toThrow('cow_order_uid_mismatch');
  });

  it.each(['0x', '0x' + '1'.repeat(110), '0x' + '1'.repeat(114), '0x' + 'g'.repeat(112), 1, null])('rejects malformed UID %s', uid => {
    expect(() => normalizeCowUid(uid)).toThrow('cow_uid_invalid');
  });

  it('revalidates a typed order before hashing and emits sanitized errors', () => {
    const order = normalizeCowOrder(rawOrder());
    order.sellAmount = 'private-input';
    expect(() => cowOrderDigest(order)).toThrow('cow_order_invalid');
    try { cowOrderUid(order, owner); throw new Error('expected_failure'); }
    catch (error) { expect(error).toEqual(new Error('cow_order_invalid')); }
  });
});
