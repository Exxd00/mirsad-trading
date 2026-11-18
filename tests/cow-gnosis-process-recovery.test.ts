import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Starts only isolated Vitest Node processes. No HTTP server, Worker, production
// tick, wallet or financial service is started. No inherited app credentials.
const root=resolve(import.meta.dirname,'..');
function start(directory:string,phase:string,encryption:string){
  const child=spawn(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','vitest.gnosis-recovery.config.ts'],{
    cwd:root,windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,
      TEMP:process.env.TEMP,TMP:process.env.TMP,NODE_ENV:'test',DATABASE_URL:'',VERCEL:'',VERCEL_ENV:'local',
      MIRSAD_FIXTURE_PHASE:phase,MIRSAD_FIXTURE_DIRECTORY:directory,MIRSAD_FIXTURE_WORLD:directory+'/world.json',MIRSAD_FIXTURE_ENCRYPTION:encryption},
    stdio:['ignore','pipe','pipe'],
  });
  let output='';child.stdout!.on('data',d=>{output+=d});child.stderr!.on('data',d=>{output+=d});
  const completion=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  return{child,completion,output:()=>output};
}
async function finished(run:ReturnType<typeof start>,milliseconds=90000){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([run.completion,new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('Isolated process deadline exceeded:\n'+run.output())),milliseconds);
  })]);}finally{if(timer)clearTimeout(timer);}
}
async function waitForFile(path:string,child:ChildProcess,output:()=>string){
  const started=Date.now();while(!existsSync(path)){
    if(child.exitCode!==null||child.signalCode!==null)throw new Error('Scenario exited before checkpoint:\n'+output());
    if(Date.now()-started>90000)throw new Error('Checkpoint deadline exceeded:\n'+output());
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}
async function cleanup(directory:string){
  const absolute=resolve(directory);if(dirname(absolute)!==resolve(tmpdir())||!basename(absolute).startsWith('mirsad-gnosis-process-'))throw new Error('Unsafe test cleanup');
  await rm(absolute,{recursive:true,force:true});
}
it('recovers a chain100 partial BUY and pending cancellation after a real abrupt OS-process kill, then sells only acquired quantity and deduplicates fees',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mirsad-gnosis-process-')),encryption=randomBytes(32).toString('base64');
  let active:ReturnType<typeof start>|undefined;
  try{
    active=start(directory,'checkpoint',encryption);await waitForFile(directory+'/checkpoint.json',active.child,active.output);
    const checkpoint=JSON.parse(readFileSync(directory+'/checkpoint.json','utf8'));
    expect(checkpoint.pid).toBe(active.child.pid);expect(active.child.exitCode).toBeNull();
    expect(active.child.kill('SIGKILL')).toBe(true);const killed=await finished(active,10000);
    expect(killed.code===null||killed.code!==0).toBe(true);
    active=start(directory,'resume',encryption);const resumed=await finished(active);
    expect(resumed,active.output()).toEqual({code:0,signal:null});
    const result=JSON.parse(readFileSync(directory+'/result.json','utf8'));
    expect(result).toMatchObject({status:'PASS',chainId:100,uniqueTransactions:3,orders:2,fills:2,closedTrades:1});
    expect(result.pid).not.toBe(checkpoint.pid);expect(result.soldRaw).toBe(checkpoint.acquiredRaw);
    active=start(directory,'verify-again',encryption);expect(await finished(active),active.output()).toEqual({code:0,signal:null});
    const final=JSON.parse(readFileSync(directory+'/result.json','utf8'));expect(final.secondRestartVerified).toBe(true);
    expect(final.verificationPid).not.toBe(checkpoint.pid);expect(final.verificationPid).not.toBe(result.pid);
  }finally{if(active&&active.child.exitCode===null&&active.child.signalCode===null){active.child.kill('SIGKILL');await finished(active,10000);}await cleanup(directory);}
},320000); // Three 90s phase budgets plus kill/cleanup must finish before the outer deadline.
it('fails closed before any synthetic order or broadcast when the chain100 token implementation changes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mirsad-gnosis-process-'));let active:ReturnType<typeof start>|undefined;
  try{active=start(directory,'wrong-token',randomBytes(32).toString('base64'));expect(await finished(active),active.output()).toEqual({code:0,signal:null});}
  finally{if(active&&active.child.exitCode===null&&active.child.signalCode===null){active.child.kill('SIGKILL');await finished(active,10000);}await cleanup(directory);}
},120000);
