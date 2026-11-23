import json
from django.core.management.base import BaseCommand
from atlas_build.worker import candidate_handoff
class Command(BaseCommand):
    help='Revalidate the internal fixture handoff, including current source bytes and the actual reader.'
    def add_arguments(self,parser):parser.add_argument('candidate')
    def handle(self,*args,**options):self.stdout.write(json.dumps(candidate_handoff(options['candidate']),sort_keys=True))
