from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Execute one private verifier generation under the parent worker."

    def add_arguments(self,parser):
        parser.add_argument("directory")

    def handle(self,*args,**options):
        from atlas_verification.execute import main
        main(options["directory"])
