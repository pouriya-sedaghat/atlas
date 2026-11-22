import json
from django.core.management.base import BaseCommand
from atlas_build.provision import Provisioner
class Command(BaseCommand):
    help='Explicit reviewed maintenance-journal recovery; never deletes FROZEN/unknown or READY data.'
    def add_arguments(self,parser):
        parser.add_argument('candidate');parser.add_argument('--journal-sha256',required=True)
        parser.add_argument('--actor',required=True);parser.add_argument('--reason',required=True)
    def handle(self,*args,**options):
        result=Provisioner().cleanup_orphan(options['candidate'],options['journal_sha256'],options['actor'],options['reason'])
        self.stdout.write(json.dumps(result,sort_keys=True))
