import { test, expect } from 'bun:test';
import { keccak256, type Hex } from 'viem';
import { matchPilotRuntime } from '../src/pilot-verification';

test('runtime verification masks only compiler immutable slots and checks repeated copies',()=>{
  const word='01'.repeat(32),other='02'.repeat(32),zero='00'.repeat(32);
  const compiled={deployedBytecode:{object:('0x60'+zero+'61'+zero+'00') as Hex,immutableReferences:{'1':[{start:1,length:32},{start:34,length:32}]}}};
  const actual=('0x60'+word+'61'+word+'00') as Hex;
  expect(matchPilotRuntime(actual,compiled)).toBe(keccak256(actual));
  expect(()=>matchPilotRuntime(('0x60'+word+'61'+other+'00') as Hex,compiled)).toThrow('Inconsistent');
  expect(()=>matchPilotRuntime(('0x62'+word+'61'+word+'00') as Hex,compiled)).toThrow('compiled');
  expect(()=>matchPilotRuntime((actual+'00') as Hex,compiled)).toThrow('length');
  expect(()=>matchPilotRuntime(actual,{deployedBytecode:{...compiled.deployedBytecode,immutableReferences:{'1':[{start:1,length:31}]}}})).toThrow('offset');
  expect(()=>matchPilotRuntime(actual,{deployedBytecode:{...compiled.deployedBytecode,immutableReferences:{'1':[{start:1,length:32}], '2':[{start:1,length:32}]}}})).toThrow('Overlapping');
});
