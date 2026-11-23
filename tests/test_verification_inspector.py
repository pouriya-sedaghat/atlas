"""Mandatory reconciliation failures must never become successful verification."""
import hashlib
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from django.core.exceptions import ValidationError

from atlas_verification.execute import osmium_check


NO_BOUNDS=b"Geometry error: Invalid location. Usually this means a node was missing from the input data.\n"


class OsmiumInspectorTests(TestCase):
    def setUp(self):
        temporary=TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory=Path(temporary.name)
        self.source=self.directory/"stable.pbf"
        self.source.write_bytes(b"stable spool identity")

    def inspect(self, responses, expected=None, scalar=False):
        # Only the native process is replaced: execute.py still owns real files,
        # parses responses, compares counts, and creates retained diagnostics.
        responses=iter(responses)
        self.invocations=[]
        def invoke(command, *, stdout, stderr, timeout):
            self.invocations.append(command)
            response=next(responses)
            if isinstance(response, BaseException):
                raise response
            code,out,err=response
            stdout.write(out)
            stderr.write(err)
            return subprocess.CompletedProcess(command,code)
        with patch("atlas_verification.execute.subprocess.run",side_effect=invoke):
            return osmium_check(self.source,expected or {"nodes":0,"ways":0,"relations":0},self.directory,**({"scalar_presentation":True} if scalar else {}))

    def test_known_presentation_error_reconciles_all_counts_and_retains_diagnostics(self):
        result=self.inspect([(1,b"",NO_BOUNDS),(0,b"0\n",b""),(0,b"0\n",b""),(0,b"2\n",b"")],
                            {"nodes":0,"ways":0,"relations":2})
        self.assertEqual(result["counts"],{"nodes":0,"ways":0,"relations":2})
        self.assertIsNone(result["bounds"])
        self.assertIn("1.18",result["adapter"])
        self.assertEqual(result["invocations"][0]["stderr"],NO_BOUNDS.decode())
        self.assertEqual([item["stdout"] for item in result["invocations"]],["","0\n","0\n","2\n"])
        self.assertEqual([item["exit_code"] for item in result["invocations"]],[1,0,0,0])
        self.assertEqual([item["command"] for item in result["invocations"]],self.invocations)
        for index,kind in enumerate(("nodes","ways","relations"),1):
            self.assertIn("--extended",self.invocations[index])
            self.assertIn("--get=data.count."+kind,self.invocations[index])
            self.assertEqual(self.invocations[index][-1],str(self.source))
        self.assertFalse((self.directory/"osmium.json").exists())
        self.assertEqual((self.directory/"osmium-json.stderr").read_bytes(),NO_BOUNDS)
        for output in result["outputs"]:
            content=(self.directory/output["path"]).read_bytes()
            self.assertEqual(output["size"],len(content))
            self.assertEqual(output["sha256"],hashlib.sha256(content).hexdigest())

    def test_general_processing_errors_cannot_select_count_adapter(self):
        for code,stdout,stderr,expected in (
            (-11,b"",b"",{"nodes":1,"ways":0,"relations":0}),
            (1,b"",b"PBF error: malformed block\n",{"nodes":0,"ways":0,"relations":0}),
            (1,b"",b"Invalid location\n",{"nodes":0,"ways":0,"relations":0}),
            (1,b"",NO_BOUNDS+b"PBF error: malformed block\n",{"nodes":0,"ways":0,"relations":0}),
            (2,b"",NO_BOUNDS,{"nodes":0,"ways":0,"relations":0}),
            (1,b"partial JSON",NO_BOUNDS,{"nodes":0,"ways":0,"relations":0}),
            (1,b"",NO_BOUNDS,{"nodes":1,"ways":0,"relations":0}),
        ):
            with self.subTest(code=code,stdout=stdout,stderr=stderr,expected=expected):
                with TemporaryDirectory() as temporary:
                    self.directory=Path(temporary)
                    with self.assertRaises(RuntimeError):
                        self.inspect([(code,stdout,stderr)],expected)
                    self.assertEqual(len(self.invocations),1)

    def test_failed_count_invocation_blocks_reconciliation(self):
        for index in range(3):
            with self.subTest(kind=index),TemporaryDirectory() as temporary:
                self.directory=Path(temporary)
                responses=[(1,b"",NO_BOUNDS)]+[(0,b"0\n",b"")]*index+[(1,b"0\n",b"PBF processing error\n")]
                with self.assertRaises(RuntimeError):
                    self.inspect(responses)

    def test_malformed_or_out_of_range_count_blocks_reconciliation(self):
        for value in (b"",b"-1\n",b"+0\n",b" 0\n",b"0 \n",b"0\n0\n",b"0.0\n",b"0\r\n",
                      b"\xff\n",b"00\n",b"18446744073709551616\n",b"1"*10000):
            with self.subTest(value=value[:40]),TemporaryDirectory() as temporary:
                self.directory=Path(temporary)
                with self.assertRaises(RuntimeError):
                    self.inspect([(1,b"",NO_BOUNDS),(0,value,b"")])

    def test_count_disagreement_on_each_type_blocks_reconciliation(self):
        for index in range(3):
            with self.subTest(kind=index),TemporaryDirectory() as temporary:
                self.directory=Path(temporary)
                responses=[(1,b"",NO_BOUNDS)]+[(0,b"1\n" if i==index else b"0\n",b"") for i in range(3)]
                with self.assertRaises(ValidationError):
                    self.inspect(responses)

    def test_timeout_blocks_reconciliation(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.inspect([(1,b"",NO_BOUNDS),subprocess.TimeoutExpired("osmium",1800)])

    def test_successful_but_malformed_json_cannot_select_count_adapter(self):
        with self.assertRaises((ValueError,RuntimeError)):
            self.inspect([(0,b"{",b"")])
        self.assertEqual(len(self.invocations),1)

    def test_confirmed_source_string_case_uses_three_scalar_counts_without_json(self):
        result=self.inspect([(0,b"2\n",b""),(0,b"1\n",b""),(0,b"3\n",b"")],
                            {"nodes":2,"ways":1,"relations":3},scalar=True)
        self.assertEqual(result["counts"],{"nodes":2,"ways":1,"relations":3})
        self.assertEqual(len(self.invocations),3)
        self.assertTrue(all("--json" not in c for c in self.invocations))
        self.assertEqual(result["adapter"],"osmium-1.18-source-string-counts-v1")
        self.assertEqual(len(result["outputs"]),6)

    def test_source_string_count_failure_and_disagreement_remain_blocking(self):
        for responses,error in [([(0,b"1\n",b"")]*3,ValidationError),
                                ([(-11,b"",b"")],RuntimeError)]:
            with TemporaryDirectory() as temporary:
                self.directory=Path(temporary)
                with self.assertRaises(error):
                    self.inspect(responses,{"nodes":2,"ways":0,"relations":0},scalar=True)
