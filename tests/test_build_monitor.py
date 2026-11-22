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
