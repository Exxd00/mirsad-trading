import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, getAddress, getContractAddress, keccak256, toFunctionSelector, type Abi, type AbiFunction, type Hex } from 'viem';
import policy from '../src/lib/wallet/generated/gnosis-funding-contracts.json';
import runtime from './fixtures/gnosis-funding-source-swap-runtime.json';

describe('published RedSnwapper source and actual public runtime binding (no settlement or liquidity claim)', () => {
  it('binds all reviewed router/token identities to actual recorded paired-RPC runtime bytes', () => {
    const names = { router: 'sourceSwap', safeExecutor: 'sourceSwapSafeExecutor', executor: 'sourceSwapExecutor',
      usdc: 'sourceUsdc', usdcImplementation: 'sourceUsdcImplementation' } as const;
    for (const [name, fixtureName] of Object.entries(names)) {
      const pin = policy.sourceSwap.contracts[name as keyof typeof names], observed = runtime.contracts[fixtureName];
      expect(observed.address.toLowerCase()).toBe(pin.address.toLowerCase());
      expect(keccak256(observed.runtime as Hex)).toBe(pin.runtimeHash); expect(observed.codeHash).toBe(pin.runtimeHash);
    }
    expect(runtime.values.whitelisted).toBe(true); expect(runtime.values.paused).toBe(false); expect(runtime.values.decimals).toBe(6);
    expect(runtime.values.implementation).toBe(policy.sourceSwap.usdc.implementation);
    expect(runtime.values.implementationSlot).toBe(policy.sourceSwap.usdc.implementationSlot);
    expect(policy.sourceSwap.provenance.executor.sourceStatus).toBe('unverified-source-fixed-runtime-net-wrapper-boundary-only');
    expect(policy.sourceSwap.boundary.nestedRoute).toContain('no-claim-of-inner-route-source-verification');
  });
  it('proves the immutable SafeExecutor address and child runtime are embedded in the exact verified parent creation', () => {
    const pin = policy.sourceSwap.contracts, proof = policy.sourceSwap.provenance.safeExecutor;
    expect(getContractAddress({ from: pin.router.address as Hex, nonce: BigInt(proof.createNonce) })).toBe(pin.safeExecutor.address);
    expect(keccak256(runtime.publishedRouterRuntime as Hex)).toBe(pin.router.runtimeHash);
    expect(runtime.publishedRouterCreationBytecode.toLowerCase()).toContain(runtime.contracts.sourceSwapSafeExecutor.runtime.slice(2));
    expect(runtime.values.safeExecutor).toBe(pin.safeExecutor.address);
    for (const offset of proof.immutableWordOffsets) {
      const word = runtime.contracts.sourceSwap.runtime.slice(2 + offset * 2, 2 + (offset + proof.immutableWordBytes) * 2);
      expect(word).toBe(pin.safeExecutor.address.slice(2).toLowerCase().padStart(64, '0'));
    }
    expect(policy.sourceSwap.provenance.router.runtimeMatch).toBe('exact_match');
    expect(policy.sourceSwap.provenance.router.creationMatch).toBe('exact_match');
  });
  it('exposes only canonical positive-input/net-minimum wrapper arguments with a separately pinned nested call', () => {
    const abi = policy.sourceSwap.abi.router as Abi, snwap = policy.sourceSwap.abi.router.find(v => v.name === 'snwap')!;
    expect(toFunctionSelector(snwap as AbiFunction)).toBe(policy.sourceSwap.selector);
    const encoded = encodeFunctionData({ abi, functionName: 'snwap', args: [policy.fromToken.address, 9925000n,
      policy.contracts.diamond.address, policy.sourceSwap.contracts.usdc.address, 9900000n, policy.sourceSwap.contracts.executor.address,
      policy.sourceSwap.executorSelector] });
    const d = decodeFunctionData({ abi, data: encoded });
    expect(d.functionName).toBe('snwap'); expect(d.args).toEqual([getAddress(policy.fromToken.address), 9925000n, getAddress(policy.contracts.diamond.address),
      getAddress(policy.sourceSwap.contracts.usdc.address), 9900000n, getAddress(policy.sourceSwap.contracts.executor.address), policy.sourceSwap.executorSelector]);
    expect(policy.sourceSwap.maximumPerStepSlippage).toBe('0.0025');
    expect(policy.sourceSwap.aggregateMaximumSlippage).toBe(policy.maximumSlippage);
  });
});
