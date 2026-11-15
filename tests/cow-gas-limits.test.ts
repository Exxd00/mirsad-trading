import { describe, expect, it } from 'vitest';
import { cowGasWeiPerLeg, gasForPhase, normalizeCowGasLimits } from '../src/lib/wallet/cow-gas-limits';
import type { CowGasLimits } from '../src/lib/wallet/cow-execution-types';

const legacy: CowGasLimits = { maxGas: '1500000', maxFeePerGasWei: '20000000000', maxPriorityFeePerGasWei: '2000000000',
  maxTransactionCostWei: '30000000000000000' };
const phased: CowGasLimits = { maxGas: '350000', maxFeePerGasWei: '2000000000', maxPriorityFeePerGasWei: '1500000000',
  maxTransactionCostWei: '700000000000000', phaseMaxGas: { presign: '350000', cancel: '210000', 'clear-presign': '30000' } };

describe('strict phase-aware CoW gas budgets', () => {
  it('retains every legacy phase and its two-transaction leg budget unchanged', () => {
    expect(normalizeCowGasLimits(legacy)).toEqual(legacy);
    for (const phase of ['presign', 'cancel', 'clear-presign'] as const) expect(gasForPhase(legacy, phase)).toBe(1500000n);
    expect(cowGasWeiPerLeg(legacy)).toBe(60000000000000000n);
    expect(normalizeCowGasLimits(legacy)).not.toHaveProperty('phaseMaxGas');
  });
  it('counts one competing presign/clearance nonce and a separate cancellation nonce', () => {
    expect(gasForPhase(phased, 'presign')).toBe(350000n); expect(gasForPhase(phased, 'cancel')).toBe(210000n);
    expect(gasForPhase(phased, 'clear-presign')).toBe(30000n);
    expect(cowGasWeiPerLeg(phased)).toBe(1120000000000000n);
    expect(cowGasWeiPerLeg({ ...phased, phaseMaxGas: { presign: '200000', cancel: '210000', 'clear-presign': '350000' } }))
      .toBe(1120000000000000n);
  });
  it('applies the independent maximum transaction cost to each nonce exactly once', () => {
    expect(cowGasWeiPerLeg({ ...phased, maxTransactionCostWei: '500000000000000' })).toBe(920000000000000n);
    expect(cowGasWeiPerLeg({ ...legacy, maxTransactionCostWei: '10000000000000000' })).toBe(20000000000000000n);
  });
  it('returns a stable canonical copy across JSONB key order and later caller mutation', () => {
    const input = JSON.parse(JSON.stringify(phased)), copy = normalizeCowGasLimits(input);
    const reordered = { phaseMaxGas: { 'clear-presign': '30000', cancel: '210000', presign: '350000' },
      maxTransactionCostWei: phased.maxTransactionCostWei, maxPriorityFeePerGasWei: phased.maxPriorityFeePerGasWei,
      maxFeePerGasWei: phased.maxFeePerGasWei, maxGas: phased.maxGas };
    expect(JSON.stringify(normalizeCowGasLimits(reordered))).toBe(JSON.stringify(copy));
    input.maxGas = '1'; input.phaseMaxGas.cancel = '1'; expect(copy).toEqual(phased);
  });
  it.each([
    { ...phased, phaseMaxGas: { presign: '350000', cancel: '210000' } },
    { ...phased, phaseMaxGas: { presign: '350000', cancel: '210000', 'clear-presign': '30000', extra: '1' } },
    { ...phased, phaseMaxGas: { presign: '350001', cancel: '210000', 'clear-presign': '30000' } },
    { ...phased, phaseMaxGas: { presign: '350000', cancel: '0', 'clear-presign': '30000' } },
    { ...phased, phaseMaxGas: { presign: '350000', cancel: '0210000', 'clear-presign': '30000' } },
    { ...phased, phaseMaxGas: { presign: '350000', cancel: 210000, 'clear-presign': '30000' } },
    { ...phased, phaseMaxGas: { presign: '350000', cancel: '210000', 'clear-presign': '-1' } },
    { ...phased, phaseMaxGas: undefined }, { ...phased, phaseMaxGas: null },
    { ...phased, maxGas: '0' }, { ...phased, maxGas: '9'.repeat(40) },
    { ...phased, maxFeePerGasWei: '1' }, { ...phased, maxTransactionCostWei: '0' },
    { ...phased, extra: '1' }, [], null,
  ])('rejects malformed or expanded limits before any financial use (%#)', value => {
    expect(() => normalizeCowGasLimits(value)).toThrow('cow_gas_limits_invalid');
    expect(() => cowGasWeiPerLeg(value as CowGasLimits)).toThrow('cow_gas_limits_invalid');
  });
  it('rejects a runtime phase outside the three reviewed transaction shapes', () => {
    expect(() => gasForPhase(phased, 'arbitrary' as 'presign')).toThrow('cow_gas_limits_invalid');
  });
});
