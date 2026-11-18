from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from atlas_intake.models import Control


class Command(BaseCommand):
    help = "Check that the Atlas worker is making progress."

    def handle(self, *args, **options):
        threshold = timezone.now() - timedelta(minutes=3)
        if not Control.objects.filter(pk=1, worker_heartbeat__gte=threshold).exists():
            raise CommandError("Atlas worker heartbeat is missing or stale.")
        self.stdout.write("ok")
