from datetime import timedelta
from django.core.management.base import BaseCommand,CommandError
from django.utils import timezone
from atlas_build.models import BuildHealth
class Command(BaseCommand):
    def handle(self,*args,**options):
        if not BuildHealth.objects.filter(pk=1,heartbeat__gte=timezone.now()-timedelta(seconds=10)).exists():
            raise CommandError('Builder heartbeat is missing or stale.')
        self.stdout.write('ok')
