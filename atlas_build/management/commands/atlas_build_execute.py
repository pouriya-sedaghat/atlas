from django.core.management.base import BaseCommand
from atlas_build.execute import execute
class Command(BaseCommand):
    def add_arguments(self,parser):parser.add_argument('execution');parser.add_argument('token')
    def handle(self,*args,**options):execute(options['execution'],options['token'])
