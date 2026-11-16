import 'server-only';
import { keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { CONFIG, fresh } from '../execution/v1/model';
import { normalizeCowAddress } from './cow-order';
import { cowFail } from './cow-execution-types';
import policy from './generated/gnosis-token-behavior.json';

const invalid = (): never => cowFail('wallet_net_limit_proof_invalid');
const address = z.string().transform(normalizeCowAddress);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(v => v as Hex);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = { proxy: address, proxyCodeHash: hash, implementation: address, implementationCodeHash: hash };
const schema = z.object({ chainId: z.literal(100), block: z.object({ number: z.string().regex(/^(0|[1-9]\d{0,19})$/),
  hash, timestamp }).strict(), readAt: timestamp, owner: address, settlement: address,
  quote: z.object(identity).strict(), base: z.object({ ...identity, bridgeContract: address }).strict(),
  governanceAssumption: z.literal('reviewed-code-at-admission-no-future-upgrade-or-bridge-change-guarantee') }).strict();
export type GnosisStandardTokenEvidence = z.infer<typeof schema>;
export type GnosisTokenEvidenceClient = Pick<PublicClient, 'getChainId' | 'getBlock' | 'getCode' | 'readContract'>;
const abi = parseAbi(['function implementation() view returns(address)', 'function decimals() view returns(uint8)',
  'function bridgeContract() view returns(address)']);
const same = (a: string, b: string) => normalizeCowAddress(a) === normalizeCowAddress(b);

/** Reviewed executable code has exact debit/credit paths, with a bridge-only
 * ERC677 callback in WETH. This evidence explicitly excludes that recipient.
 * A current snapshot is not a promise against later governance changes, token
 * freezes, bridge insolvency, failed fills or price movements. */
export function validateGnosisStandardTokenEvidence(value: unknown, ownerInput: string, now: number): GnosisStandardTokenEvidence {
  try {
    const e = schema.parse(value), owner = normalizeCowAddress(ownerInput);
    if (!Number.isSafeInteger(now) || now < 0 || !fresh(e.readAt, now, CONFIG.quoteMaxAgeSeconds)
      || !fresh(e.block.timestamp, now, 60) || e.block.timestamp > e.readAt
      || !same(e.owner, owner) || !same(e.settlement, policy.settlement)
      || !same(e.base.bridgeContract, policy.base.bridgeContract)
      || same(owner, e.base.bridgeContract) || same(e.settlement, e.base.bridgeContract)) return invalid();
    for (const key of ['quote', 'base'] as const) {
      if (!same(e[key].proxy, policy[key].proxy) || !same(e[key].implementation, policy[key].implementation)
        || e[key].proxyCodeHash !== policy[key].proxyCodeHash || e[key].implementationCodeHash !== policy[key].implementationCodeHash) return invalid();
    }
    return { chainId: 100, block: { number: e.block.number, hash: e.block.hash, timestamp: e.block.timestamp }, readAt: e.readAt,
      owner, settlement: normalizeCowAddress(policy.settlement),
      quote: { proxy: e.quote.proxy, proxyCodeHash: e.quote.proxyCodeHash, implementation: e.quote.implementation, implementationCodeHash: e.quote.implementationCodeHash },
      base: { proxy: e.base.proxy, proxyCodeHash: e.base.proxyCodeHash, implementation: e.base.implementation,
        implementationCodeHash: e.base.implementationCodeHash, bridgeContract: e.base.bridgeContract },
      governanceAssumption: 'reviewed-code-at-admission-no-future-upgrade-or-bridge-change-guarantee' };
  } catch { return invalid(); }
}

/** Fixed assets and getters only, at one freshly observed canonical block.
 * No URL, caller, transaction, approval, signer or mutable cache is accepted. */
export async function readGnosisStandardTokenEvidence(client: GnosisTokenEvidenceClient, ownerInput: string,
  clock: () => number): Promise<GnosisStandardTokenEvidence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const live = () => { if (!active) invalid(); };
  const work = async () => {
    const owner = normalizeCowAddress(ownerInput);
    if (same(owner, policy.base.bridgeContract)) return invalid();
    const [chainId, b] = await Promise.all([client.getChainId(), client.getBlock()]);
    live();
    if (chainId !== 100 || b.number === null || !b.hash || b.number < 0n || b.timestamp < 0n
      || b.timestamp > BigInt(Number.MAX_SAFE_INTEGER) || !fresh(Number(b.timestamp), clock(), 60)) return invalid();
    const quote = normalizeCowAddress(policy.quote.proxy), base = normalizeCowAddress(policy.base.proxy), at = b.number;
    const [quoteCode, baseCode, quoteImpl, baseImpl, bridgeContract, quoteDecimals, baseDecimals] = await Promise.all([
      client.getCode({ address: quote, blockNumber: at }), client.getCode({ address: base, blockNumber: at }),
      client.readContract({ address: quote, abi, functionName: 'implementation', blockNumber: at }),
      client.readContract({ address: base, abi, functionName: 'implementation', blockNumber: at }),
      client.readContract({ address: base, abi, functionName: 'bridgeContract', blockNumber: at }),
      client.readContract({ address: quote, abi, functionName: 'decimals', blockNumber: at }),
      client.readContract({ address: base, abi, functionName: 'decimals', blockNumber: at }),
    ]);
    live();
    if (!quoteCode || !baseCode || !same(quoteImpl, policy.quote.implementation) || !same(baseImpl, policy.base.implementation)
      || !same(bridgeContract, policy.base.bridgeContract) || same(owner, bridgeContract) || same(policy.settlement, bridgeContract)
      || quoteDecimals !== policy.quote.decimals || baseDecimals !== policy.base.decimals) return invalid();
    const [quoteImplCode, baseImplCode, check] = await Promise.all([
      client.getCode({ address: quoteImpl, blockNumber: at }), client.getCode({ address: baseImpl, blockNumber: at }),
      client.getBlock({ blockNumber: at }),
    ]);
    live();
    if (!quoteImplCode || !baseImplCode || check.number !== b.number || check.hash !== b.hash || check.timestamp !== b.timestamp) return invalid();
    return validateGnosisStandardTokenEvidence({ chainId: 100,
      block: { number: b.number.toString(), hash: b.hash, timestamp: Number(b.timestamp) }, readAt: clock(), owner, settlement: policy.settlement,
      quote: { proxy: quote, proxyCodeHash: keccak256(quoteCode), implementation: quoteImpl, implementationCodeHash: keccak256(quoteImplCode) },
      base: { proxy: base, proxyCodeHash: keccak256(baseCode), implementation: baseImpl, implementationCodeHash: keccak256(baseImplCode), bridgeContract },
      governanceAssumption: policy.governanceAssumption }, owner, clock());
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('wallet_net_limit_proof_invalid')), 20000);
    })]);
  } catch { return invalid(); }
  finally { active = false; if (timer !== undefined) clearTimeout(timer); }
}
