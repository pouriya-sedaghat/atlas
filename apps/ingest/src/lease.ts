import {IntakeError} from './contracts.js';

/** A transient renewal error is not proof of lease loss. Never work past the safe monotonic deadline. */
export class LeaseWatch {
  private readonly abort=new AbortController();private readonly timer:ReturnType<typeof setInterval>;
  private readonly interval:number;private readonly margin:number;private deadline:number;private next:number;
  private busy=false;private stopped=false;error:unknown;
  readonly signal:AbortSignal;
  private readonly forward=()=>this.abort.abort();
  constructor(private readonly renew:()=>Promise<void>,leaseMs:number,claimStarted:number,parent?:AbortSignal,
    private readonly onRetry:(error:unknown)=>void=()=>{},private readonly now:()=>number=()=>performance.now()){
    if(!Number.isFinite(leaseMs)||leaseMs<1000)throw new IntakeError('invalid_watch_lease');
    this.margin=Math.min(5000,leaseMs/10);this.interval=Math.min(10000,leaseMs/4);
    this.deadline=claimStarted+leaseMs-this.margin;this.next=this.now()+this.interval;this.signal=this.abort.signal;
    this.parent=parent;parent?.addEventListener('abort',this.forward,{once:true});if(parent?.aborted)this.abort.abort();
    this.timer=setInterval(()=>{
      if(this.stopped||this.signal.aborted)return;
      const start=this.now();
      if(start>=this.deadline){this.error=new IntakeError('control_lease_deadline');this.abort.abort();return;}
      if(this.busy||start<this.next)return;
      this.busy=true;this.next=start+this.interval;
      this.renew().then(()=>{if(!this.stopped){this.deadline=start+leaseMs-this.margin;}}).catch(error=>{
        if(this.stopped)return;
        if(error instanceof IntakeError&&error.code==='lease_lost'){this.error=error;this.abort.abort();}
        else this.onRetry(error);
      }).finally(()=>{this.busy=false;});
    },Math.min(1000,leaseMs/10));
  }
  private readonly parent?:AbortSignal;
  stop():void{this.stopped=true;clearInterval(this.timer);this.parent?.removeEventListener('abort',this.forward);}
}
