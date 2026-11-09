import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { keccak256, stringToHex } from 'viem';
const require = createRequire(import.meta.url), solc = require('solc');
if (!solc.version().startsWith('0.8.30+')) throw new Error('cow_compiler_version_mismatch');
// Compile the exact repository LF source on Windows and Linux alike. Solidity
// metadata includes source bytes, so checkout CRLF must not change its identity.
const content = (await readFile(new URL('../contracts/CoWOrderEnforcer.sol', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'prague',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'], '': ['ast'] } } };
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'CoWOrderEnforcer.sol': { content } }, settings })));
if (out.errors?.some(e => e.severity === 'error')) throw new Error('cow_enforcer_compile_failed');
const contract = out.contracts['CoWOrderEnforcer.sol'].CoWOrderEnforcer;
const nodes = out.sources['CoWOrderEnforcer.sol'].ast.nodes.find(n => n.name === 'CoWOrderEnforcer').nodes;
const immutables = Object.fromEntries(nodes.filter(n => n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable')
  .map(n => [n.name, contract.evm.deployedBytecode.immutableReferences[String(n.id)]]));
const bytecode = '0x' + contract.evm.bytecode.object;
const artifact = { compilerVersion: solc.version(), sourceHash: keccak256(stringToHex(content)),
  artifactHash: keccak256(bytecode), settings: { optimizer: settings.optimizer, viaIR: true, evmVersion: 'prague' },
  abi: contract.abi, bytecode, runtimeTemplate: '0x' + contract.evm.deployedBytecode.object, immutables };
const directory = new URL('../src/lib/wallet/generated/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('cow-enforcer.json', directory), JSON.stringify(artifact, null, 2) + '\n');
process.stdout.write(JSON.stringify({ compiler: artifact.compilerVersion, sourceHash: artifact.sourceHash, artifactHash: artifact.artifactHash }) + '\n');
