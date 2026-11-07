import { keccak256, type Hex } from 'viem';
import { swapAmounts, type Plan, type Side, type Signatures } from './mandate';

export type Pending = { side: Side; hash: Hex; raw: Hex; nonce: number };
export type Completion = { side: Side; hash: Hex; spent: string; received: string };
export type Trial = { plan: Plan; signatures?: Signatures; paused: boolean; fault?: string; pending?: Pending; fills: Completion[];
  lastCheck?: { at: number; status: string; reason?: string } };
export interface ChainPort {
  now(): Promise<number>;
  quote(plan: Plan, side: Side): Promise<bigint>;
  prepare(plan: Plan, side: Side, signatures: Signatures): Promise<Omit<Pending, 'side'>>;
  receipt(plan: Plan, pending: Pending): Promise<Completion | 'mined' | 'reverted' | 'conflict' | null>;
  broadcast(raw: Hex): Promise<Hex>;
}
export type LockedUpdate = <T>(edit: (state: Trial | null) => Promise<T>) => Promise<T>;
export type Result = { status: string; reason?: string; hash?: Hex };

// The transaction journal commits the exact signed bytes BEFORE any broadcast. The
// same hash can be retried across process deaths without spending a second nonce.
export async function offlineTick(lock: LockedUpdate, chain: ChainPort): Promise<Result> {
  type Step = { result: Result; send?: Pending };
  const step = await lock<Step>(async state => {
    if (!state?.signatures) return { result: { status: 'idle', reason: 'owner_grant_required' } };
    const { plan, pending } = state;
    if (state.fault) return { result: { status: 'blocked', reason: state.fault } };
    const now = await chain.now();
    if (pending) {
      const receipt = await chain.receipt(plan, pending);
      if (receipt === 'conflict' || receipt === 'reverted') {
        state.fault = 'transaction_' + receipt;
        return { result: { status: 'blocked', reason: state.fault, hash: pending.hash } };
      }
      if (receipt === 'mined') return { result: { status: 'confirming', hash: pending.hash } };
      if (receipt) {
        state.fills.push(receipt); delete state.pending;
        return { result: { status: 'confirmed', hash: pending.hash } };
      }
      if (state.paused || now >= plan.expires) return { result: { status: 'unresolved', hash: pending.hash } };
      return { result: { status: 'submitted', hash: pending.hash }, send: pending };
    }
    if (state.paused || now < plan.start || now >= plan.expires) return { result: { status: 'idle', reason: state.paused ? 'paused' : 'outside_validity' } };
    if (state.fills.length >= 2 * plan.cycles) return { result: { status: 'complete' } };
    // Testnet transport trial: alternate only after the preceding leg settled.
    // The owner's two price floors, the on-chain cap and the expiry bound each round.
    const side: Side = state.fills.length % 2 ? 'sell' : 'buy';
    const { minimum, amountIn } = swapAmounts(plan, side);
    if (side === 'sell' && BigInt(state.fills.at(-1)!.received) < amountIn) return { result: { status: 'blocked', reason: 'insufficient_confirmed_fill' } };
    const quoted = await chain.quote(plan, side);
    if (quoted < minimum || minimum * 10_000n < quoted * BigInt(10_000 - plan.maxSlippageBps)) {
      return { result: { status: 'waiting', reason: 'outside_signed_price_band' } };
    }
    const prepared = await chain.prepare(plan, side, state.signatures);
    if (keccak256(prepared.raw) !== prepared.hash) throw new Error('transaction_hash_mismatch');
    state.pending = { ...prepared, side };
    return { result: { status: 'submitted', hash: prepared.hash }, send: state.pending };
  });
  if (step.send) {
    try {
      if (await chain.broadcast(step.send.raw) !== step.send.hash) throw new Error('wrong_hash');
    } catch { return { status: 'unresolved', hash: step.send.hash }; }
  }
  return step.result;
}
