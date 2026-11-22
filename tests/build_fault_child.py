"""Fault injection belongs only to tests; normal workers have no fault flags."""
import os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import django
django.setup()
from atlas_build import execute as child,bundle
from atlas_build.models import BuildExecution
fault=sys.argv[1]
if fault=='publication':
    def fail(*args,**kwargs):raise OSError('approved disposable publication failure')
    bundle.publish_bundle=fail
elif fault in {'after_bundle_link','after_bundle_prepared'}:
    if fault=='after_bundle_link':
        original=bundle.publish_bundle
        def publish(*args,**kwargs):
            def crash(step):
                if step=='after_link':os._exit(77)
            return original(*args,**kwargs,fault=crash)
        bundle.publish_bundle=publish
    else:
        original=child.phase
        def phase(*args,**kwargs):
            result=original(*args,**kwargs)
            if args[2]=='BUNDLE_PREPARED':os._exit(77)
            return result
        child.phase=phase
elif fault=='before_ready_result':
    original=child.write_result
    def write(path,value):
        if value.get('outcome')=='READY':os._exit(77)
        return original(path,value)
    child.write_result=write
elif fault=='during_copy':
    from atlas_build.importer import CopyBatch
    original=CopyBatch.flush
    def flush(self):
        pending=bool(self.count);result=original(self)
        if pending:os._exit(77)
        return result
    CopyBatch.flush=flush
elif fault in {'before_create','after_create','after_freeze','after_validation'}:
    if fault=='before_create':
        original=child.rpc.call
        def call(operation,*args,**kwargs):
            if operation=='create':os._exit(77)
            return original(operation,*args,**kwargs)
        child.rpc.call=call
    elif fault in {'after_create','after_freeze'}:
        original=child.phase
        def phase(*args,**kwargs):
            if fault=='after_create' and args[2]=='LOADING' and kwargs.get('identity'):os._exit(77)
            if fault=='after_freeze' and args[2]=='FROZEN':os._exit(77)
            return original(*args,**kwargs)
        child.phase=phase
    else:
        original=child.reconcile
        def reconcile(*args,**kwargs):
            original(*args,**kwargs);os._exit(77)
        child.reconcile=reconcile
else:raise ValueError('Unknown test fault')
e=BuildExecution.objects.get(status='running')
child.execute(e.pk,e.token)
