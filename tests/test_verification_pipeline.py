import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from django.test import override_settings

from atlas_verification.execute import run
from atlas_verification.manifest import validate_manifest
from tests.test_verification_decoder import block, pbf


VALID_POLY=b"sample\n1\n0 0\n2 0\n2 2\n0 2\n0 0\nEND\nEND\n"
INVALID_POLY=b"bad\n1\n0 0\n2 2\n0 2\n2 0\n0 0\nEND\nEND\n"


class VerificationPipelineTests(TestCase):
    def verify(self,data=1,invalid_boundary=False):
        with TemporaryDirectory() as temporary:
            root=Path(temporary)
            inbox=root/"inbox"
            inbox.mkdir()
            generation=root/"generation"
            generation.mkdir()
            artifacts=[]
            for region in ("sample","boundary-only"):
                content=INVALID_POLY if invalid_boundary and region=="boundary-only" else VALID_POLY
                source=inbox/(region+".poly")
                source.write_bytes(content)
                artifacts.append({
                    "artifact_id":str(len(artifacts)+1),"region_id":region,"kind":"poly","path":source.name,
                    "length":len(content),"sha256":hashlib.sha256(content).hexdigest(),"exception":{},
                })
            if data is not None:
                source=inbox/"sample.osm.pbf"
                primitive=block()
                if data:
                    primitive.primitivegroup.add().nodes.add(id=1,lat=0,lon=0)
                content=pbf(primitive,compression="zlib")
                source.write_bytes(content)
                artifacts.append({
                    "artifact_id":"3","region_id":"sample","kind":"pbf","path":source.name,
                    "length":len(content),"sha256":hashlib.sha256(content).hexdigest(),"exception":{},
                })
            snapshot={
                "run_id":"test-run","catalog_digest":"a"*64,"retrieval_local_date":"2026-11-19",
                "zone":"Asia/Tehran","selected_pbfs":["sample"] if data is not None else [],
                "regions":["sample","boundary-only"],"artifacts":artifacts,
            }
            with override_settings(ATLAS_INBOX=inbox):
                # Direct runner uses the same configured inbox path as the managed child.
                import os
                from unittest.mock import patch
                with patch.dict(os.environ,{"ATLAS_INBOX":str(inbox)}):
                    try:
                        result=run(snapshot,generation,lambda update:None)
                    except RuntimeError:
                        partial=json.loads((generation/"partial.json").read_bytes())
                        self.assertEqual(len(partial["checks_completed"]),2)
                        self.assertEqual(partial["checks_incomplete"],["3"])
                        self.assertEqual(partial["counts"]["nodes"],1)
                        self.assertFalse(partial["build_eligible"])
                        raise
            for region in result["regions"]:
                manifest=json.loads((generation/"result"/region["path"]).read_bytes())
                validate_manifest("region",manifest)
            return result

    def test_spool_disk_failure_is_operational_not_invalid_input(self):
        import errno
        from unittest.mock import patch
        for code in (errno.ENOSPC, errno.EACCES):
            with self.subTest(errno=code):
                with patch("atlas_verification.execute.spool", side_effect=OSError(code, "private spool write failed")):
                    with self.assertRaises(OSError):
                        self.verify()

    def test_mandatory_inspector_failure_preserves_completed_and_incomplete_checks(self):
        from unittest.mock import patch
        with patch("atlas_verification.execute.osmium_check",side_effect=RuntimeError("fixture inspector failure")):
            with self.assertRaisesRegex(RuntimeError,"fixture inspector failure"):
                self.verify()

    def test_valid_nonempty_pipeline_crosschecks_osmium_and_is_build_eligible(self):
        result=self.verify()
        self.assertEqual(result["status"],"verified")
        self.assertTrue(result["build_eligible"])
        source=next(region for region in result["region_results"] if region["region_id"]=="sample")
        self.assertEqual(source["checks"]["pbf"]["osmium"]["counts"],{"nodes":1,"ways":0,"relations":0})
        self.assertEqual(source["checks"]["pbf"]["reread"]["count"],1)

    def test_empty_and_boundary_only_verification_stays_build_ineligible(self):
        for data in (None,0):
            with self.subTest(data=data):
                result=self.verify(data=data)
                self.assertEqual(result["status"],"verified" if data is None else "unsupported_profile")
                self.assertFalse(result["build_eligible"])
                if data == 0:
                    source=next(row for row in result["region_results"] if row["region_id"]=="sample")
                    self.assertTrue(source["checks"]["pbf"]["empty"])
                    self.assertIn("valid_empty_snapshot",[item["code"] for item in source["checks"]["pbf"]["reasons"]])

    def test_invalid_boundary_only_region_blocks_whole_batch(self):
        result=self.verify(invalid_boundary=True)
        self.assertEqual(result["status"],"input_invalid")
        self.assertFalse(result["build_eligible"])
        self.assertEqual(result["counts"]["nodes"],1)
        self.assertTrue(result["blocking"])
