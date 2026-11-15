import 'server-only';
import { cowFail, type CowGasLimits, type CowTxPhase } from './cow-execution-types';

const phases = ['presign', 'cancel', 'clear-presign'] as const;
const invalid = (): never => cowFail('cow_gas_limits_invalid');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return invalid();
}
function positive(value: unknown): string {
  // Preserve the existing runtime schema's canonical positive decimal width.
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,38}$/.test(value)) return invalid();
  return value;
}

/** Strict canonical copy for persisted configuration and signed-proof inputs.
 * No defaults lower a legacy budget, and an optional phase map is all-or-none. */
export function normalizeCowGasLimits(value: unknown): CowGasLimits {
  const v = record(value);
  keys(v, ['maxGas', 'maxFeePerGasWei', 'maxPriorityFeePerGasWei', 'maxTransactionCostWei'], ['phaseMaxGas']);
  const normalized: CowGasLimits = { maxGas: positive(v.maxGas), maxFeePerGasWei: positive(v.maxFeePerGasWei),
    maxPriorityFeePerGasWei: positive(v.maxPriorityFeePerGasWei), maxTransactionCostWei: positive(v.maxTransactionCostWei) };
  if (BigInt(normalized.maxPriorityFeePerGasWei) > BigInt(normalized.maxFeePerGasWei)) return invalid();
  if (Object.prototype.hasOwnProperty.call(v, 'phaseMaxGas')) {
    const p = record(v.phaseMaxGas); keys(p, phases);
    const phaseMaxGas = { presign: positive(p.presign), cancel: positive(p.cancel), 'clear-presign': positive(p['clear-presign']) };
    if (phases.some(phase => BigInt(phaseMaxGas[phase]) > BigInt(normalized.maxGas))) return invalid();
    normalized.phaseMaxGas = phaseMaxGas;
  }
  return normalized;
}

export function gasForPhase(value: CowGasLimits, phase: CowTxPhase): bigint {
  if (!phases.includes(phase)) return invalid();
  const limits = normalizeCowGasLimits(value);
  return BigInt(limits.phaseMaxGas?.[phase] ?? limits.maxGas);
}

/** A presign and its self-transfer clearance compete for ONE executor nonce.
 * Cancellation uses the next nonce. Count the larger competing cost once;
 * replacement attempts do not create an additional mined transaction nonce.
 * This is an upper budget for this two-nonce leg, not an actual expense. */
export function cowGasWeiPerLeg(value: CowGasLimits): bigint {
  const limits = normalizeCowGasLimits(value), fee = BigInt(limits.maxFeePerGasWei), cap = BigInt(limits.maxTransactionCostWei);
  const phase = (name: CowTxPhase) => BigInt(limits.phaseMaxGas?.[name] ?? limits.maxGas);
  const nonceGas = phase('presign') > phase('clear-presign') ? phase('presign') : phase('clear-presign');
  const cost = (gas: bigint) => gas * fee < cap ? gas * fee : cap;
  return cost(nonceGas) + cost(phase('cancel'));
}
