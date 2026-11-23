import json
from django.core.management.base import BaseCommand
from atlas_build.control import approve_receipt
class Command(BaseCommand):
    help='Explicit coverage approval for one unadmitted receipt and the actual scope baseline.'
    def add_arguments(self,parser):
        parser.add_argument('receipt',type=int);parser.add_argument('--baseline',required=True)
        parser.add_argument('--actor',required=True);parser.add_argument('--reason',required=True)
    def handle(self,*args,**options):
        approval=approve_receipt(options['receipt'],options['baseline'],options['actor'],options['reason'])
        self.stdout.write(json.dumps({'approval':str(approval.pk),'receipt':options['receipt'],'baseline':str(approval.baseline_id)}))
