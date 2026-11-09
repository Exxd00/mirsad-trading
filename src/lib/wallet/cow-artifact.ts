import { encodeAbiParameters, encodeDeployData, getAddress, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';
import generated from './generated/cow-enforcer.json';
import { COW_CHAIN_ID, COW_SETTLEMENT } from './cow-order';

export const COW_ENFORCER_ARTIFACT = generated;
export const COW_ENFORCER_RELEASE = 'mirsad-cow-policy-v1-solc-0.8.30';
export function cowEnforcerDeployment(manager: Address): Hex {
  if (!generated.compilerVersion.startsWith('0.8.30+') || keccak256(generated.bytecode as Hex) !== generated.artifactHash) throw new Error('cow_artifact_invalid');
  return encodeDeployData({ abi: generated.abi, bytecode: generated.bytecode as Hex, args: [manager, COW_SETTLEMENT, COW_CHAIN_ID] });
}
/** Exact compiler runtime with every immutable patched to its approved value.
 * A receipt/address alone cannot authenticate a custom enforcer. */
export function expectedCowEnforcerRuntime(manager: Address): Hex {
  const domain = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32,uint256,address'), [
    keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
    keccak256(stringToHex('Gnosis Protocol')), keccak256(stringToHex('v2')), BigInt(COW_CHAIN_ID), COW_SETTLEMENT,
  ]));
  const values: Record<string, Hex> = { delegationManager: encodeAbiParameters(parseAbiParameters('address'), [getAddress(manager)]),
    settlement: encodeAbiParameters(parseAbiParameters('address'), [COW_SETTLEMENT]),
    chainId: encodeAbiParameters(parseAbiParameters('uint256'), [BigInt(COW_CHAIN_ID)]), domainSeparator: domain };
  let code = generated.runtimeTemplate.slice(2);
  for (const [name, references] of Object.entries(generated.immutables)) {
    if (!values[name]) throw new Error('cow_artifact_immutable_invalid');
    for (const r of references) {
      const value = values[name].slice(2);
      if (r.length !== value.length / 2 || r.start < 0 || (r.start + r.length) * 2 > code.length) throw new Error('cow_artifact_immutable_invalid');
      code = code.slice(0, r.start * 2) + value + code.slice((r.start + r.length) * 2);
    }
  }
  return ('0x' + code) as Hex;
}
