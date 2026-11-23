"""Source strings cross real extraction, control persistence, and handoff."""
import hashlib
import json
from uuid import uuid4
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.db import transaction
from django.test import TransactionTestCase
from django.urls import reverse
from atlas_intake.models import Audit
from atlas_verification.control import request_verification, get_handoff
from atlas_verification.models import VerificationAttempt, VerificationExecution
from atlas_verification.worker import VerificationWorker
from atlas_verification.proto import osmformat_pb2 as osm
from tests.test_verification_decoder import block, pbf, frame
from tests.test_verification_handoff import VerificationHandoffTests


class VerificationReportTests(TransactionTestCase):
    setUp = VerificationHandoffTests.setUp
    seal_fixture = VerificationHandoffTests.seal_fixture
    publish_fixture = VerificationHandoffTests.publish_fixture

    def test_nul_source_values_and_keys_reach_real_published_handoff(self):
        primitive = block()
        primitive.stringtable.s.extend([b'key\0tail', b'value\0tail', b'user\0tail', b'role\0tail'])
        node = primitive.primitivegroup.add().nodes.add(id=1, lat=0, lon=0)
        node.keys.extend([5,1]); node.vals.extend([6,6])
        node.info.version = 1; node.info.timestamp = 0; node.info.user_sid = 7
        primitive.primitivegroup.add().ways.add(id=2).refs.append(1)
        member = primitive.primitivegroup.add().relations.add(id=3)
        member.memids.append(1); member.types.append(0); member.roles_sid.append(8)
        header = osm.HeaderBlock(required_features=['OsmSchema-V0.6','DenseNodes'],
                                 writingprogram='writer\0tail', source='source\0tail')
        attempt, check = self.publish_fixture(
            frame('OSMHeader', header) + frame('OSMData', primitive),
            {'nodes':1,'ways':1,'relations':1}, build_eligible=True)
        attempt.refresh_from_db()
        self.assertEqual(check['header']['writingprogram'], 'writer\0tail')
        serialized = json.dumps(attempt.summary)
        for value in ['key\\u0000tail', 'value\\u0000tail', 'user\\u0000tail', 'role\\u0000tail', 'writer\\u0000tail']:
            self.assertIn(value, serialized)
        self.assertEqual(check['tag_summary']['selected_keys']['name']['values']['value\0tail'],1)
        self.assertEqual(attempt.executions.get().report,attempt.summary)
        self.assertTrue(get_handoff(attempt.pk, verify_outputs=True)['build_eligible'])
        user = get_user_model().objects.create_user('report-reader')
        user.user_permissions.add(Permission.objects.get(codename='operate'))
        self.client.force_login(user)
        response = self.client.get(reverse('verification:attempt_detail',args=[attempt.pk]))
        self.assertEqual(response.status_code,200)
        self.assertNotIn(b'\0',response.content)
        self.assertIn(b'writer\\u0000tail',response.content)

    def test_report_progress_and_failure_diagnostics_preserve_source_keys(self):
        primitive=block();primitive.primitivegroup.add().nodes.add(id=1,lat=0,lon=0)
        run=self.seal_fixture(pbf(primitive))
        a=request_verification(run.pk,'nul-failure','operator')
        w=VerificationWorker();a=w.claim()
        original={'key\0':{'user':'\0','values':['','é','x\0y']}}
        a.progress=original;a.save(update_fields=['progress']);a.refresh_from_db()
        self.assertEqual(a.progress,original)
        with transaction.atomic():w.finish_failure(a,'operational_failed','failure\0tail',original)
        a.refresh_from_db()
        self.assertEqual(a.summary,original)
        self.assertEqual(a.executions.get().report['error'],'failure\0tail')
        self.assertEqual(a.error,'failure\\u0000tail')
        event=Audit.objects.filter(action='verification.failed',run=run).latest('pk')
        self.assertEqual(event.detail['error'],'failure\\u0000tail')
