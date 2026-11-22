"""Host root and capacity attestation cannot overlap any retained deployment."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from django.core.exceptions import ValidationError

class BuildMonitorTests(TestCase):
    def test_root_guard_rejects_overlap_and_symlinks_without_writing_legacy_mounts(self):
        from atlas_build.monitor import guard_root
        with TemporaryDirectory() as temporary:
            base=Path(temporary);old=base/'old';new=base/'new';old.mkdir();new.mkdir()
            inventory=[{'mounts':[{'Source':str(old),'Destination':'/inbox','RW':True}]}]
            self.assertEqual(guard_root(new,inventory),new)
            for path in [old,old/'child',base]:
                with self.assertRaises(ValidationError):guard_root(path,inventory)
            link=base/'alias';link.symlink_to(new,target_is_directory=True)
            with self.assertRaises(ValidationError):guard_root(link,inventory)
    def test_attestation_requires_fresh_inventory_complete_capacity_and_valid_domains(self):
        from atlas_build.monitor import validate_attestation
        from datetime import datetime,timezone,timedelta
        now=datetime.now(timezone.utc)
        observation={'observed_at':now.isoformat(),'quiescent':True,'inventory_digest':'a'*64,
            'headroom_bytes':33*1024**3,'candidate_bytes':1024,'new_service_uncommitted':4*1024**3}
        self.assertEqual(validate_attestation(observation,now=now),observation)
        for change in [{'observed_at':(now-timedelta(seconds=30)).isoformat()},{'candidate_bytes':-1},
                       {'inventory_digest':'invalid'},{'headroom_bytes':True},{'new_service_uncommitted':None}]:
            with self.assertRaises(ValidationError):validate_attestation({**observation,**change},now=now)
    def test_new_service_inventory_requires_exact_ceiling_pins_and_no_extra_writers(self):
        from atlas_build.monitor import own_capacity,CEILINGS
        rows=[]
        for service,(cpu,memory) in CEILINGS.items():
            rows.append({'Name':'/atlas-phase1c-fixture-'+service+'-1','Image':'pinned-'+service,
                'Config':{'Labels':{'com.docker.compose.service':service,'org.opencontainers.image.revision':'candidate'}},
                'State':{'Running':True,'Health':{'Status':'healthy'}},
                'HostConfig':{'NanoCpus':int(cpu*10**9),'Memory':memory,'MemorySwap':memory}})
        pins={service:'pinned-'+service for service in CEILINGS}
        self.assertEqual(own_capacity(rows,'candidate',pins),4224*1024**2)
        for mutate in [lambda data:data.append(dict(data[0])),lambda data:data[0]['HostConfig'].update(Memory=0),
                       lambda data:data[0].update(Image='different')]:
            import copy
            invalid=copy.deepcopy(rows);mutate(invalid)
            with self.assertRaises(ValidationError):own_capacity(invalid,'candidate',pins)
    def test_actual_kernel_cpu_memory_and_physical_io_caps_are_mandatory(self):
        from atlas_build.monitor import validate_cgroup_limits,CEILINGS,IO_RATES
        samples={}
        for service,(cpu,memory) in CEILINGS.items():
            read,write=IO_RATES[service]
            samples['atlas-phase1c-fixture-'+service+'-1']={'cpu.max':str(int(cpu*100000))+' 100000',
                'memory.max':str(memory),'memory.swap.max':'0','io.max':f'8:0 rbps={read} wbps={write} riops=max wiops=max'}
        self.assertTrue(validate_cgroup_limits(samples,'8:0'))
        for field,value in [('cpu.max','max 100000'),('memory.max','max'),('io.max',''),('memory.swap.max','max')]:
            import copy
            bad=copy.deepcopy(samples);bad['atlas-phase1c-fixture-builder-1'][field]=value
            with self.assertRaises(ValidationError):validate_cgroup_limits(bad,'8:0')

    def test_host_waits_for_bounded_sink_ready_handshake(self):
        from atlas_build.pilot import wait_sink_ready
        from unittest.mock import Mock
        selector=Mock();selector.select.return_value=[object()]
        sink=Mock();sink.stdout.readline.return_value=b'ready\n'
        wait_sink_ready(selector,sink);selector.select.assert_called_once_with(timeout=10)
        for data in [b'',b'accepted\n']:
            sink.stdout.readline.return_value=data
            with self.assertRaises(ValueError):wait_sink_ready(selector,sink)
        selector.select.return_value=[]
        with self.assertRaises(ValueError):wait_sink_ready(selector,sink)

from django.test import TransactionTestCase,override_settings
@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class AttestationProtocolTests(TransactionTestCase):
    def test_stream_signals_ready_before_consuming_fresh_observation(self):
        import io,json
        from datetime import datetime,timezone
        from types import SimpleNamespace
        from unittest.mock import patch
        from django.core.management import call_command
        from atlas_build.models import BuildHealth
        value={'observed_at':datetime.now(timezone.utc).isoformat(),'quiescent':True,'inventory_digest':'a'*64,
               'headroom_bytes':33*1024**3,'candidate_bytes':0,'new_service_uncommitted':4224*1024**2}
        output=io.StringIO()
        with patch('sys.stdin',SimpleNamespace(buffer=io.BytesIO((json.dumps(value)+'\n').encode()))):
            call_command('atlas_build_attest',stream=True,stdout=output)
        self.assertEqual(output.getvalue().splitlines(),['ready','accepted'])
        self.assertEqual(BuildHealth.objects.get().legacy,value)

class LegacyReadOnlyProbeTests(TestCase):
    def test_collection_reuses_probes_and_preserves_identical_inventory_contract(self):
        import copy,json
        from unittest.mock import patch,Mock
        from atlas_build import legacy
        scopes={name:{'name':name,'run_cap':2*1024**3,'intake_outstanding':0,'verification_outstanding':0,'verifier_cap':0,'busy':False,'identity':{'mode':'manual'}} for name in legacy.LEGACY}
        rows=[{'Name':'/'+name+'-web-1','Id':name,'Image':'pin','State':{'StartedAt':'frozen','Health':{'Status':'healthy'}},'HostConfig':{'Memory':0,'NanoCpus':0},'Mounts':[]} for name in legacy.LEGACY]
        calls=[]
        def command(args,**kwargs):
            calls.append(args)
            if args[:2]==['docker','ps']:return '\n'.join(row['Name'].lstrip('/') for row in rows)
            if args[:2]==['docker','inspect']:return json.dumps(rows)
            raise AssertionError('Cold Docker exec must not occur when a persistent probe is provided')
        probe=Mock(side_effect=lambda scope:copy.deepcopy(scopes[scope]))
        with patch.object(legacy,'command',side_effect=command):result=legacy.collect(probe=probe)
        self.assertEqual(probe.call_count,5);self.assertTrue(result['quiescent'])
        self.assertEqual(result['headroom_bytes'],11*1024**3)
        self.assertEqual(len(calls),2)
        expected=legacy.evaluate(list(scopes.values()),result['inventory'])
        self.assertEqual(result['inventory_digest'],expected['inventory_digest'])

    def test_persistent_probe_bounds_frames_and_closes_existing_diagnostic_process(self):
        import io,json
        from unittest.mock import patch,Mock
        from atlas_build.legacy_probe import LegacyProbe
        with TemporaryDirectory() as temporary:
            process=Mock();process.poll.return_value=None
            process.stdin=io.BytesIO();process.stdout=Mock()
            selection=Mock();selection.select.return_value=[object()]
            with patch('atlas_build.legacy_probe.subprocess.Popen',return_value=process) as create,patch('atlas_build.legacy_probe.selectors.DefaultSelector',return_value=selection),patch('atlas_build.legacy_probe.os.read',side_effect=[b'noise\nATLAS_EVIDENCE={"busy":false}\n',b'ATLAS_EVIDENCE={"busy":true}\n']):
                probe=LegacyProbe('atlas-poly-smoke',Path(temporary))
                self.assertFalse(probe.read()['busy']);self.assertTrue(probe.read()['busy'])
                self.assertEqual(create.call_count,1);self.assertEqual(process.stdin.getvalue(),b'observe\nobserve\n')
                self.assertIn('SET TRANSACTION READ ONLY',create.call_args.args[0][-1])
                selection.select.return_value=[]
                with self.assertRaises(ValueError):probe.read()
                probe.close();self.assertTrue(process.stdin.closed)
            with self.assertRaises(ValueError):LegacyProbe('unapproved-scope',Path(temporary))
