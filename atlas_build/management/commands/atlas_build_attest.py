import json,sys
from datetime import timedelta
from django.core.management.base import BaseCommand,CommandError
from django.utils import timezone
from atlas_build.control import fixture_guard
from atlas_build.models import BuildHealth
from atlas_build.monitor import validate_attestation

class Command(BaseCommand):
    help='Accept bounded host observations on stdin in the isolated QA control database.'
    def add_arguments(self,parser):parser.add_argument('--stream',action='store_true')
    def handle(self,*args,**options):
        fixture_guard()
        if options['stream']:
            self.stdout.write('ready',ending='\n');self.stdout.flush()
        while True:
            raw=sys.stdin.buffer.readline(1024**2+1)
            if not raw:return
            if len(raw)>1024**2:raise CommandError('External observation exceeds its bound.')
            value=validate_attestation(json.loads(raw))
            BuildHealth.objects.update_or_create(pk=1,defaults={'legacy':value,'legacy_until':timezone.now()+timedelta(seconds=12)})
            self.stdout.write('accepted',ending='\n');self.stdout.flush()
            if not options['stream']:return
