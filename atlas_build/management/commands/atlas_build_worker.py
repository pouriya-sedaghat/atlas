from time import sleep
from django.core.management.base import BaseCommand,CommandError
from django.db import connection
from atlas_build.worker import BuildWorker
class Command(BaseCommand):
    help='Process only the opted-in persistent fixture candidate queue.'
    def add_arguments(self,parser):parser.add_argument('--once',action='store_true')
    def handle(self,*args,**options):
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_try_advisory_lock(%s)',[0x41544C41533143])
            if not cursor.fetchone()[0]:raise CommandError('Another builder owns this worker lock.')
        try:
            worker=BuildWorker()
            while True:
                active=worker.tick()
                if options['once']:return
                if not active:sleep(1)
        finally:connection.close()
