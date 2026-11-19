from time import sleep

from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from atlas_verification.worker import VerificationWorker


class Command(BaseCommand):
    help = "Process the persistent Atlas input verification queue."

    def add_arguments(self,parser):
        parser.add_argument("--once",action="store_true")

    def handle(self,*args,**options):
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s)",[0x41544C41533142])
            if not cursor.fetchone()[0]:
                raise CommandError("Another verifier already owns this worker lock.")
        try:
            worker=VerificationWorker()
            while True:
                active=worker.tick()
                if options["once"]:
                    return
                if not active:
                    sleep(2)
        finally:
            connection.close()
