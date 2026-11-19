import hashlib
import json
import subprocess
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
                if data == "relations":
                    primitive.primitivegroup.add().relations.add(id=1)
                elif data:
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
                        self.assertEqual(partial["counts"]["nodes"],int(data == 1))
                        self.assertFalse(partial["build_eligible"])
                        inspector_files=list((generation/"result"/"regions").glob("*/osmium*"))
                        if inspector_files:
                            source=next(row for row in partial["region_results"] if row["region_id"]=="sample")
                            self.assertIn("osmium_failure_outputs",source["checks"]["pbf"])
                            outputs=source["checks"]["pbf"]["osmium_failure_outputs"]
                            self.assertEqual({output["path"] for output in outputs},
                                             {path.name for path in inspector_files})
                            for output in outputs:
                                path=next(path for path in inspector_files if path.name==output["path"])
                                content=path.read_bytes()
                                self.assertEqual(output["size"],len(content))
                                self.assertEqual(output["sha256"],hashlib.sha256(content).hexdigest())
                        raise
            for region in result["regions"]:
                manifest=json.loads((generation/"result"/region["path"]).read_bytes())
                validate_manifest("region",manifest)
                folder=(generation/"result"/region["path"]).parent
                for output in manifest["outputs"]:
                    content=(folder/output["path"]).read_bytes()
                    self.assertEqual(len(content),output["size"])
                    self.assertEqual(hashlib.sha256(content).hexdigest(),output["sha256"])
                if manifest["checks"].get("pbf",{}).get("osmium",{}).get("adapter"):
                    self.assertFalse((folder/"osmium.json").exists())
                    self.assertEqual(
                        {path.name for path in folder.iterdir() if path.name != "manifest.json"},
                        {output["path"] for output in manifest["outputs"]},
                    )
                    diagnostic=(folder/"osmium-json.stderr").read_text()
                    self.assertIn("Geometry error: Invalid location.",diagnostic)
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
        self.assertEqual(set(source["checks"]["pbf"]["osmium"]),{"counts","sha256"})
        self.assertEqual(source["checks"]["pbf"]["reread"]["count"],1)

    def test_empty_and_boundary_only_verification_stays_build_ineligible(self):
        for data in (None,0):
            with self.subTest(data=data):
                result=self.verify(data=data)
                self.assertEqual(result["status"],"verified")
                self.assertFalse(result["build_eligible"])
                if data == 0:
                    source=next(row for row in result["region_results"] if row["region_id"]=="sample")
                    self.assertTrue(source["checks"]["pbf"]["empty"])
                    self.assertIn("valid_empty_snapshot",[item["code"] for item in source["checks"]["pbf"]["reasons"]])
                    inspector=source["checks"]["pbf"]["osmium"]
                    self.assertEqual(inspector["counts"],{"nodes":0,"ways":0,"relations":0})
                    self.assertEqual(inspector["bounds"],None)
                    self.assertIn("1.18",inspector["adapter"])

    def test_relations_without_node_bounds_complete_count_reconciliation(self):
        result=self.verify(data="relations")
        self.assertEqual(result["status"],"verified")
        self.assertTrue(result["build_eligible"])
        self.assertEqual(result["counts"],{"nodes":0,"ways":0,"relations":1})
        source=next(row for row in result["region_results"] if row["region_id"]=="sample")
        inspector=source["checks"]["pbf"]["osmium"]
        self.assertEqual(inspector["counts"],{"nodes":0,"ways":0,"relations":1})
        self.assertIsNone(inspector["bounds"])

    def test_empty_count_disagreement_blocks_batch_and_retains_output_identity(self):
        from unittest.mock import patch
        native=subprocess.run
        def inspector(command, **options):
            if "--get=data.count.relations" in command:
                options["stdout"].write(b"1\n")
                return subprocess.CompletedProcess(command,0)
            return native(command,**options)
        with patch("atlas_verification.execute.subprocess.run",side_effect=inspector):
            result=self.verify(data=0)
        self.assertEqual(result["status"],"input_invalid")
        self.assertFalse(result["build_eligible"])
        self.assertEqual(result["blocking"][0]["reasons"][-1]["code"],"count_disagreement")

    def test_empty_failed_or_malformed_count_cannot_complete_verification(self):
        from unittest.mock import patch
        native=subprocess.run
        for code,output,error in ((1,b"0\n",b"processing failed\n"),(0,b"0\n1\n",b"")):
            with self.subTest(code=code,output=output):
                def inspector(command, **options):
                    if "--get=data.count.relations" in command:
                        options["stdout"].write(output)
                        options["stderr"].write(error)
                        return subprocess.CompletedProcess(command,code)
                    return native(command,**options)
                with patch("atlas_verification.execute.subprocess.run",side_effect=inspector):
                    with self.assertRaises(RuntimeError):
                        self.verify(data=0)

    def test_invalid_boundary_only_region_blocks_whole_batch(self):
        result=self.verify(invalid_boundary=True)
        self.assertEqual(result["status"],"input_invalid")
        self.assertFalse(result["build_eligible"])
        self.assertEqual(result["counts"]["nodes"],1)
        self.assertTrue(result["blocking"])
