import copy
import hashlib
import json
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import TestCase, override_settings
from django.utils import timezone

from atlas_intake.control import launch_manual, set_selection
from atlas_intake.models import Artifact, Audit, Control, Run
from atlas_intake.provider import Client, ProviderError
from atlas_intake.worker import StaleClaim, Worker
from tests.test_control import install_catalog
from tests.test_pbf_metadata import ScriptedHTTP, HeadersOnly, meta
from tests.test_provider import BASE, LATEST, DATED, PBF, PBF_MD5, POLY, Reply


MD5 = (PBF_MD5+"  iran-261117.osm.pbf\n").encode()


@override_settings(ATLAS_LIMITS={"pbf":1024,"poly":1024,"run":4096,"inbox":1024**2,"free":1})
class MetadataWorkerTests(TestCase):
    def setUp(self):
        install_catalog()
        set_selection(["iran"], "operator")
        self.temp=TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)

    def claim(self, client):
        worker=Worker(client,self.root)
        run=launch_manual("metadata", "operator")
        worker.active_run()
        return worker,run,worker.claim(run,run.artifacts.get(kind="pbf").pk,pin_only=True)

    def test_full_real_client_timeout_fallback_publishes_and_seals(self):
        steps=[("HEAD",LATEST,TimeoutError()),("GET",LATEST,HeadersOnly(307,Location=DATED)),
               ("GET",DATED,meta()),("HEAD",DATED,TimeoutError()),("GET",DATED,meta()),
               ("GET",DATED+".md5",Reply(body=MD5)),("GET",DATED,Reply(body=PBF,Content_Length=len(PBF),ETag='"valid"',Last_Modified="Wed, 18 Nov 2026 00:04:18 GMT"))]
        for path in ["/asia.poly","/asia/iran.poly","/europe/monaco.poly"]:
            steps.extend([("HEAD",path,HeadersOnly(Content_Length=len(POLY))),
                          ("GET",path,Reply(body=POLY,Content_Length=len(POLY)))])
        http=ScriptedHTTP(steps);worker=Worker(Client(opener=http),self.root)
        run=launch_manual("full-fallback","operator")
        for _ in range(6):
            worker.work_tick(parallel=False)
        run.refresh_from_db()
        self.assertEqual(run.status,Run.Status.SEALED)
        pbf=run.artifacts.get(kind="pbf")
        self.assertEqual(pbf.sha256,hashlib.sha256(PBF).hexdigest())
        self.assertEqual((self.root/pbf.relative_path).read_bytes(),PBF)
        events=list(Audit.objects.filter(action="artifact.metadata").values_list("detail",flat=True))
        self.assertTrue(events)
        self.assertTrue(all(e["artifact"]==pbf.pk and e["generation"]==1 for e in events))
        self.assertTrue(any(e.get("trigger")=="timeout" and e.get("method")=="GET" for e in events))
        self.assertTrue(any(e.get("stage")=="sidecar" for e in events))
        self.assertEqual(set(pbf.pin),{"url","length","md5","etag","last_modified"})

    def test_expired_claim_stops_before_network_and_does_not_renew(self):
        http=ScriptedHTTP([])
        worker,run,artifact=self.claim(Client(opener=http))
        expired=timezone.now()-timedelta(seconds=1)
        Artifact.objects.filter(pk=artifact.pk).update(lease_until=expired)
        with self.assertRaises(StaleClaim):
            worker._pin_pbf(artifact)
        artifact.refresh_from_db()
        self.assertEqual(artifact.lease_until,expired)
        self.assertFalse(http.requests)
        self.assertFalse(Audit.objects.filter(action="artifact.metadata").exists())

    def test_network_outliving_claim_closes_response_without_saving_success(self):
        response=meta()
        http=ScriptedHTTP([("HEAD",LATEST,HeadersOnly(307,Location=DATED)),("HEAD",DATED,response)])
        worker,run,artifact=self.claim(Client(opener=http))
        original=http.open
        def delayed(request,timeout):
            reply=original(request,timeout)
            if request.full_url==BASE+DATED:
                Artifact.objects.filter(pk=artifact.pk).update(lease_until=timezone.now()-timedelta(seconds=1))
            return reply
        http.open=delayed
        with self.assertRaises(StaleClaim):
            worker._pin_pbf(artifact)
        self.assertTrue(response.closed)
        artifact.refresh_from_db()
        self.assertEqual(artifact.pin,{})
        self.assertEqual(artifact.resolved_url,"")
        self.assertEqual(len(http.requests),2)
        self.assertFalse(Audit.objects.filter(action="artifact.metadata",detail__outcome="success").exists())

    def test_resolved_unpinned_retry_after_missing_sidecar_keeps_identity(self):
        http=ScriptedHTTP([("HEAD",LATEST,HeadersOnly(307,Location=DATED)),("HEAD",DATED,meta()),
                           ("HEAD",DATED,meta()),("GET",DATED+".md5",Reply(404))])
        worker,run,artifact=self.claim(Client(opener=http))
        with self.assertRaises(ProviderError) as error:
            worker._pin_pbf(artifact)
        self.assertEqual(error.exception.code,"sidecar_missing")
        artifact.refresh_from_db()
        first=copy.deepcopy(artifact.pin)
        self.assertEqual(artifact.resolved_url,BASE+DATED)
        self.assertIsNone(artifact.pinned_at)
        worker.fail(artifact,error.exception)
        Artifact.objects.filter(pk=artifact.pk).update(retry_at=timezone.now())
        resumed=ScriptedHTTP([("HEAD",DATED,meta()),("GET",DATED+".md5",Reply(body=MD5))])
        worker=Worker(Client(opener=resumed),self.root)
        next_claim=worker.claim(run,artifact.pk,pin_only=True)
        pinned=worker._pin_pbf(next_claim)
        self.assertEqual(pinned.pin["etag"],first["etag"])
        self.assertEqual(pinned.pin["url"],first["url"])
        self.assertEqual(len(resumed.requests),2)
        empty=ScriptedHTTP([])
        self.assertEqual(Worker(Client(opener=empty),self.root)._pin_pbf(pinned).pin,pinned.pin)
        self.assertFalse(empty.requests)

    def test_payload_and_event_caps_are_enforced_before_audit_write(self):
        worker,run,artifact=self.claim(Client(opener=ScriptedHTTP([])))
        observe=worker._metadata_observer(artifact)
        event={"event":"request_start","phase":"resolve","method":"HEAD",
               "target":BASE+"/"+"a"*12000+".osm.pbf","response_body":"secret","raw_exception":"secret"}
        with self.assertRaises(ProviderError) as error:
            for _ in range(50):
                observe(event)
        self.assertEqual(error.exception.code,"metadata_trace_limit")
        details=list(Audit.objects.filter(action="artifact.metadata").values_list("detail",flat=True))
        self.assertEqual(len(details),40)
        self.assertTrue(details[-1]["trace_truncated"])
        for row in details:
            self.assertLessEqual(len(json.dumps(row,sort_keys=True).encode()),4096)
            self.assertNotIn("secret",str(row))
            self.assertEqual(row["artifact"],artifact.pk)
        artifact.refresh_from_db()
        self.assertGreater(artifact.lease_until,timezone.now())
        self.assertIsNotNone(Control.objects.get(pk=1).worker_heartbeat)

    def test_two_observers_do_not_share_identity_or_counts(self):
        worker,run,one=self.claim(Client(opener=ScriptedHTTP([])))
        # The second metadata claim has another real artifact identity.
        two=worker.claim(run,run.artifacts.get(kind="poly",region_id="iran").pk,pin_only=True)
        observers=[worker._metadata_observer(one),worker._metadata_observer(two)]
        for observer in observers:
            observer({"event":"request_start","phase":"resolve","method":"HEAD","target":BASE+DATED})
        rows=list(Audit.objects.filter(action="artifact.metadata").values_list("detail",flat=True))
        self.assertEqual({r["artifact"] for r in rows},{one.pk,two.pk})
        self.assertEqual([r["event_number"] for r in rows],[1,1])


    def test_maximum_metadata_and_sidecar_redirect_paths_fit_generation_budget(self):
        steps=[("HEAD",LATEST,HeadersOnly(307,Location=DATED))]
        steps += [("HEAD",DATED,HeadersOnly(307,Location=DATED)) for _ in range(3)]
        steps += [("HEAD",DATED,TimeoutError()),("GET",DATED,meta())]
        steps += [("HEAD",DATED,HeadersOnly(307,Location=DATED)) for _ in range(4)]
        steps += [("HEAD",DATED,TimeoutError()),("GET",DATED,meta())]
        steps += [("GET",DATED+".md5",Reply(307,Location=DATED+".md5")) for _ in range(4)]
        steps += [("GET",DATED+".md5",Reply(body=MD5))]
        http=ScriptedHTTP(steps)
        worker,run,artifact=self.claim(Client(opener=http))
        result=worker._pin_pbf(artifact)
        self.assertEqual(len(http.requests),17)
        self.assertEqual(result.pin["md5"],PBF_MD5)
        self.assertIsNotNone(result.pinned_at)
        self.assertEqual(result.status,Artifact.Status.TRANSFERRING)
        self.assertFalse((self.root/result.relative_path).exists())
        self.assertLessEqual(Audit.objects.filter(action="artifact.metadata").count(),40)

    def test_sidecar_read_losing_generation_stops_before_another_read(self):
        calls=[]
        class LostDuringRead(Reply):
            def read1(reply,size):
                calls.append(size)
                Artifact.objects.filter(pk=artifact.pk).update(generation=artifact.generation+1)
                return b"123"
        http=ScriptedHTTP([("HEAD",LATEST,HeadersOnly(307,Location=DATED)),("HEAD",DATED,meta()),
                          ("HEAD",DATED,meta()),("GET",DATED+".md5",LostDuringRead(body=MD5))])
        worker,run,artifact=self.claim(Client(opener=http))
        with self.assertRaises(StaleClaim):
            worker._pin_pbf(artifact)
        self.assertEqual(len(calls),1)
        artifact.refresh_from_db()
        self.assertIsNone(artifact.pinned_at)
        self.assertEqual(artifact.resolved_url,BASE+DATED)

    def test_restarted_resolved_artifact_rejects_changed_validators(self):
        http=ScriptedHTTP([])
        worker,run,artifact=self.claim(Client(opener=http))
        original={"url":BASE+DATED,"length":len(PBF),"etag":'"first"',"last_modified":""}
        Artifact.objects.filter(pk=artifact.pk).update(resolved_url=BASE+DATED,pin=original,expected_length=len(PBF))
        artifact.refresh_from_db()
        resumed=ScriptedHTTP([("HEAD",DATED,meta()),("GET",DATED+".md5",Reply(body=MD5))])
        with self.assertRaises(ProviderError) as error:
            Worker(Client(opener=resumed),self.root)._pin_pbf(artifact)
        self.assertEqual(error.exception.code,"validator_changed")
        artifact.refresh_from_db()
        self.assertEqual(artifact.pin,original)
        self.assertIsNone(artifact.pinned_at)


    def test_long_target_normal_client_trace_preserves_digest_and_truncation(self):
        latest="/asia/"+("a"*1600)+"-latest.osm.pbf"
        dated="/asia/"+("a"*1600)+"-261117.osm.pbf"
        checksum=(PBF_MD5+"  "+dated.rsplit("/",1)[1]+chr(10)).encode()
        http=ScriptedHTTP([("HEAD",latest,HeadersOnly(307,Location=dated)),("HEAD",dated,meta()),
                          ("HEAD",dated,meta()),("GET",dated+".md5",Reply(body=checksum))])
        worker,run,artifact=self.claim(Client(opener=http))
        artifact.requested_url=BASE+latest
        artifact.save(update_fields=["requested_url"])
        worker._pin_pbf(artifact)
        first=Audit.objects.filter(action="artifact.metadata").order_by("pk").first().detail
        self.assertEqual(first["target_sha256"],hashlib.sha256((BASE+latest).encode()).hexdigest())
        self.assertIn("target",first["truncated_fields"])
        self.assertLessEqual(len(json.dumps(first).encode()),4096)

    def test_fallback_metadata_and_partial_body_do_not_publish_or_seal(self):
        steps=[("HEAD",LATEST,TimeoutError()),("GET",LATEST,HeadersOnly(307,Location=DATED)),
               ("GET",DATED,meta()),("HEAD",DATED,meta()),("GET",DATED+".md5",Reply(body=MD5)),
               ("GET",DATED,Reply(206,body=b"x",Content_Length=1,Content_Range="bytes 0-0/5000"))]
        for path in ["/asia.poly","/asia/iran.poly","/europe/monaco.poly"]:
            steps.extend([("HEAD",path,HeadersOnly(Content_Length=len(POLY))),
                          ("GET",path,Reply(body=POLY,Content_Length=len(POLY)))])
        worker=Worker(Client(opener=ScriptedHTTP(steps)),self.root)
        run=launch_manual("partial-body","operator")
        for _ in range(5):worker.work_tick(parallel=False)
        run.refresh_from_db()
        self.assertEqual(run.status,Run.Status.INCOMPLETE)
        artifact=run.artifacts.get(kind="pbf")
        self.assertEqual(artifact.status,Artifact.Status.FAILED)
        self.assertEqual(artifact.sha256,"")
        self.assertFalse(artifact.intent)
        self.assertFalse((self.root/artifact.relative_path).exists())


from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, local
from django.db import close_old_connections, connection
from django.test import TransactionTestCase


class ConcurrentMetadataTests(TransactionTestCase):
    def test_observers_are_isolated_and_release_locks_before_concurrent_io(self):
        install_catalog()
        set_selection(["iran"],"operator")
        with TemporaryDirectory() as temporary:
            worker=Worker(Client(opener=ScriptedHTTP([])),Path(temporary))
            run=launch_manual("concurrent","operator")
            worker.active_run()
            one=worker.claim(run,run.artifacts.get(kind="pbf").pk,pin_only=True)
            two=worker.claim(run,run.artifacts.get(region_id="monaco",kind="poly").pk,pin_only=True)
            barrier=Barrier(2)
            class ConcurrentHTTP:
                def __init__(self):self.local=local()
                def open(self,request,timeout):
                    if connection.in_atomic_block:
                        raise AssertionError("Network I/O held database locks")
                    self.local.calls=getattr(self.local,"calls",0)+1
                    barrier.wait(timeout=5)
                    return HeadersOnly(307,Location=DATED) if self.local.calls==1 else meta()
            shared_client=Client(opener=ConcurrentHTTP())
            def perform(artifact):
                close_old_connections()
                try:
                    shared_client.resolve_pbf(BASE+LATEST,observer=worker._metadata_observer(artifact))
                finally:
                    connection.close()
            with ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(perform,[one,two]))
            rows=list(Audit.objects.filter(action="artifact.metadata").values_list("detail",flat=True))
            operations={}
            for row in rows:
                operations.setdefault(row["artifact"],set()).add(row["operation"])
            self.assertEqual(set(operations),{one.pk,two.pk})
            self.assertEqual(len(operations[one.pk]),1)
            self.assertFalse(operations[one.pk]&operations[two.pk])
            for artifact in [one,two]:
                self.assertEqual([r["event_number"] for r in rows if r["artifact"]==artifact.pk],list(range(1,7)))
