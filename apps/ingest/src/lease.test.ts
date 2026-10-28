import {afterEach,describe,it,expect,vi} from 'vitest';
import {LeaseWatch} from './lease.js';
import {IntakeError} from './contracts.js';
afterEach(()=>vi.useRealTimers());
function watch(renew:()=>Promise<void>,parent?:AbortSignal){return new LeaseWatch(renew,4000,Date.now(),parent,()=>{},()=>Date.now());}
describe('lease renewal under transient control-plane pressure',()=>{
  it('recovers a transient renewal failure without stopping valid work',async()=>{
    vi.useFakeTimers();const renew=vi.fn().mockRejectedValueOnce(new Error('temporary IO pressure')).mockResolvedValue(undefined),w=watch(renew);
    try{await vi.advanceTimersByTimeAsync(5000);expect(renew.mock.calls.length).toBeGreaterThan(2);expect(w.signal.aborted).toBe(false);expect(w.error).toBeUndefined();}finally{w.stop();}
  });
  it('aborts before the known lease can expire if renewal remains unavailable',async()=>{
    vi.useFakeTimers();const w=watch(async()=>{throw new Error('control unavailable');});
    try{await vi.advanceTimersByTimeAsync(3600);expect(w.signal.aborted).toBe(true);expect(w.error).toMatchObject({code:'control_lease_deadline'});}finally{w.stop();}
  });
  it('aborts immediately on authoritative fencing and stops all later renewals',async()=>{
    vi.useFakeTimers();const renew=vi.fn(async()=>{throw new IntakeError('lease_lost');}),w=watch(renew);
    await vi.advanceTimersByTimeAsync(1200);expect(w.signal.aborted).toBe(true);expect(w.error).toMatchObject({code:'lease_lost'});w.stop();
    await vi.advanceTimersByTimeAsync(10000);expect(renew).toHaveBeenCalledTimes(1);
  });
  it('forwards a deliberate shutdown without pretending ownership was lost',()=>{
    vi.useFakeTimers();const parent=new AbortController(),w=watch(async()=>{},parent.signal);parent.abort();expect(w.signal.aborted).toBe(true);expect(w.error).toBeUndefined();w.stop();
  });
});
