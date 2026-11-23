import json
from django.core.management.base import BaseCommand,CommandError
from atlas_build.control import activate_fixture_profile
from atlas_build.fixtures import register_fixture,COVERAGE,KINDS,expected_coverage
class Command(BaseCommand):
    help='Register only new synthetic inputs; normal verifier and builder determine all outcomes.'
    def add_arguments(self,parser):
        group=parser.add_mutually_exclusive_group(required=True);group.add_argument('--activate',action='store_true');group.add_argument('--profile')
        parser.add_argument('--bootstrap',action='store_true');parser.add_argument('--kind',choices=sorted(KINDS),default='lossless')
        parser.add_argument('--actor',required=True)
    def handle(self,*args,**options):
        if options['bootstrap'] and not options['activate']:raise CommandError('Bootstrap intent belongs to explicit profile activation.')
        profile=activate_fixture_profile(expected_coverage(options['kind']),options['actor'],bootstrap=options['bootstrap']) if options['activate'] else None
        attempt=register_fixture(options['kind'],options['actor'],profile_id=profile.pk if profile else options['profile'])
        self.stdout.write(json.dumps({'scope':'fixture','verification_id':str(attempt.pk),'run_id':str(attempt.run_id),
            'profile':str(profile.pk if profile else options['profile']),'status':attempt.status,'kind':options['kind']},sort_keys=True))
