from pathlib import Path
import os
from django.core.management.base import BaseCommand
from atlas_build.provision import Provisioner
from atlas_build.rpc import make_server

class Command(BaseCommand):
    help='Serve only bounded generation-owned candidate provisioning operations.'
    def handle(self,*args,**options):
        Provisioner().bootstrap()
        secret=Path(os.environ['ATLAS_PROVISIONER_SECRET_FILE']).read_bytes().strip()
        if len(secret)<32:raise ValueError('Provisioner requires a scoped secret of at least 32 bytes.')
        with make_server(('0.0.0.0',8010),secret,Provisioner) as server:server.serve_forever(poll_interval=0.5)
