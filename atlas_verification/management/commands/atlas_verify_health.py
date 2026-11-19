from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from atlas_verification.models import VerificationHealth


class Command(BaseCommand):
    def handle(self,*args,**options):
        if not VerificationHealth.objects.filter(pk=1,heartbeat__gte=timezone.now()-timedelta(seconds=30)).exists():
            raise CommandError("Verification worker heartbeat is missing or stale.")
        self.stdout.write("ok")
