from time import monotonic, sleep

from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.utils import timezone

from atlas_intake.catalog import due_refresh, heartbeat, refresh_catalog
from atlas_intake.control import dispatch_due, get_control
from atlas_intake.provider import Client
from atlas_intake.worker import Worker


class Command(BaseCommand):
    help = "Run the Atlas intake scheduler and download worker."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Run one bounded poll cycle.")

    def handle(self, *args, **options):
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s)", [0x41544C41533141])
            if not cursor.fetchone()[0]:
                raise CommandError("An Atlas intake worker already owns the scheduler lock.")
        try:
            worker = Worker()
            get_control()
            startup = timezone.now()
            self.stdout.write("Atlas intake worker started.")
            while True:
                heartbeat()
                if due_refresh():
                    refresh_catalog(Client())
                dispatch_due()
                worker.reclaim_expired()
                worker.recover_publications()
                worker.integrity_tick(startup)
                if monotonic() >= worker.next_sweep:
                    worker.clean_staging()
                    worker.next_sweep = monotonic() + 300
                did_work = worker.work_tick()
                if options["once"]:
                    break
                if not did_work:
                    sleep(2)
        finally:
            connection.close()
