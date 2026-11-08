import { concatHex, getAddress, hashTypedData, isAddress, numberToHex, zeroAddress, type Address, type Hex } from 'viem';

// Ethereum GPv2 deployment and signing domain. These are order identity helpers,
// not an execution source, permission grant, or approval to submit an order.
export const COW_CHAIN_ID = 1;
export const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;
export const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as const;
export const COW_DOMAIN = Object.freeze({ name: 'Gnosis Protocol', version: 'v2',
  chainId: COW_CHAIN_ID, verifyingContract: COW_SETTLEMENT } as const);

export type CowOrder = {
  sellToken: Address; buyToken: Address; receiver: Address;
  sellAmount: string; buyAmount: string; validTo: number; appData: Hex;
  feeAmount: '0'; kind: 'buy' | 'sell'; partiallyFillable: boolean;
  sellTokenBalance: 'erc20'; buyTokenBalance: 'erc20';
};

const fields = ['sellToken', 'buyToken', 'receiver', 'sellAmount', 'buyAmount', 'validTo',
  'appData', 'feeAmount', 'kind', 'partiallyFillable', 'sellTokenBalance', 'buyTokenBalance'] as const;
const uint256Max = (1n << 256n) - 1n;
const orderTypes = { Order: [
  { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' },
  { name: 'receiver', type: 'address' }, { name: 'sellAmount', type: 'uint256' },
  { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
  { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' },
  { name: 'kind', type: 'string' }, { name: 'partiallyFillable', type: 'bool' },
  { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
] } as const;

export function normalizeCowAddress(raw: unknown): Address {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw) || !isAddress(raw)
    || raw.toLowerCase() === zeroAddress) throw new Error('cow_address_invalid');
  return getAddress(raw);
}

function amount(raw: unknown): string {
  // Decimal strings only: avoid JSON precision loss, alternative encodings and
  // a changed digest caused by silently interpreting malformed amounts.
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,77}$/.test(raw)
    || BigInt(raw) > uint256Max) throw new Error('cow_order_invalid');
  return raw;
}

export function normalizeCowOrder(raw: unknown): CowOrder {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('cow_order_invalid');
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key as typeof fields[number])))
    throw new Error('cow_order_invalid');
  const value = raw as Record<string, unknown>;
  const sellToken = normalizeCowAddress(value.sellToken), buyToken = normalizeCowAddress(value.buyToken);
  const receiver = normalizeCowAddress(value.receiver);
  if (sellToken === buyToken || !Number.isSafeInteger(value.validTo) || (value.validTo as number) < 0
    || (value.validTo as number) > 0xffffffff || typeof value.appData !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(value.appData) || value.feeAmount !== '0'
    || (value.kind !== 'buy' && value.kind !== 'sell') || typeof value.partiallyFillable !== 'boolean'
    || value.sellTokenBalance !== 'erc20' || value.buyTokenBalance !== 'erc20') throw new Error('cow_order_invalid');
  return { sellToken, buyToken, receiver, sellAmount: amount(value.sellAmount), buyAmount: amount(value.buyAmount),
    validTo: value.validTo as number, appData: value.appData.toLowerCase() as Hex, feeAmount: '0', kind: value.kind,
    partiallyFillable: value.partiallyFillable, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
}

export function normalizeCowUid(raw: unknown): Hex {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{112}$/.test(raw)) throw new Error('cow_uid_invalid');
  return raw.toLowerCase() as Hex;
}

export function cowOrderDigest(order: CowOrder): Hex {
  const normalized = normalizeCowOrder(order);
  return hashTypedData({ domain: COW_DOMAIN, types: orderTypes, primaryType: 'Order',
    message: { ...normalized, sellAmount: BigInt(normalized.sellAmount), buyAmount: BigInt(normalized.buyAmount), feeAmount: 0n } });
}

export function cowOrderUid(order: CowOrder, owner: string): Hex {
  const normalized = normalizeCowOrder(order), account = normalizeCowAddress(owner);
  const digest = cowOrderDigest(normalized);
  return normalizeCowUid(concatHex([digest, account, numberToHex(normalized.validTo, { size: 4 })]));
}

export function assertCowOrderUid(uid: unknown, order: CowOrder, owner: string): Hex {
  const normalized = normalizeCowUid(uid);
  if (normalized !== cowOrderUid(order, owner)) throw new Error('cow_order_uid_mismatch');
  return normalized;
}
