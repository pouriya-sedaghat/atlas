"""Bounded cgroup v2 observations; lifetime accounting is separate from an attempt."""
from datetime import UTC, datetime
from pathlib import Path
import re


CGROUP_ROOT=Path("/sys/fs/cgroup")
OOM_COUNTERS=("oom","oom_kill","oom_group_kill")
MEMORY_FIELDS=("anon","file","kernel","kernel_stack","pagetables","sock","shmem",
               "file_mapped","file_dirty","file_writeback","slab","swapcached")


def cgroup_snapshot(root=CGROUP_ROOT):
    root=Path(root)
    unavailable=[]
    def read(name):
        try:
            with (root/name).open("r",encoding="ascii") as source:
                raw=source.read(16385)
            if len(raw)>16384:
                raise ValueError("Observation exceeds its bound.")
            return raw.strip()
        except (OSError,UnicodeError,ValueError):
            unavailable.append(name)
            return None
    def number(name,raw):
        if raw is not None and re.fullmatch(r"[0-9]+",raw) and len(raw)<=24:
            return int(raw)
        if name not in unavailable:
            unavailable.append(name)
        return None
    def counters(name):
        raw=read(name)
        if raw is None:
            return None
        result={}
        for line in raw.splitlines():
            fields=line.split()
            if len(fields)!=2 or fields[0] in result or not re.fullmatch(r"[0-9]{1,24}",fields[1]):
                unavailable.append(name)
                return None
            result[fields[0]]=int(fields[1])
        return result
    result={"observed_at":datetime.now(UTC).isoformat(),"cgroup_path":str(root)}
    try:
        result["cgroup_directory_inode"]=root.stat().st_ino
    except OSError:
        result["cgroup_directory_inode"]=None
    for name,key in (("memory.max","memory_max"),("memory.swap.max","memory_swap_max")):
        raw=read(name)
        result[key+"_raw"]=raw
        result[key+"_bytes"]=None if raw=="max" else number(name,raw)
    for name,key in (("memory.current","memory_current_bytes"),("memory.peak","memory_peak_bytes"),
                     ("memory.swap.current","memory_swap_current_bytes"),("memory.swap.peak","memory_swap_peak_bytes")):
        result[key]=number(name,read(name))
    raw=read("cpu.max")
    result.update(cpu_max=raw,cpu_quota_usec=None,cpu_period_usec=None)
    if raw is not None:
        fields=raw.split()
        if len(fields)==2 and (fields[0]=="max" or re.fullmatch(r"[0-9]{1,24}",fields[0])) and re.fullmatch(r"[0-9]{1,24}",fields[1]) and int(fields[1])>0:
            result["cpu_quota_usec"]=None if fields[0]=="max" else int(fields[0])
            result["cpu_period_usec"]=int(fields[1])
        else:
            unavailable.append("cpu.max")
    result["memory_events"]=counters("memory.events")
    stats=counters("memory.stat")
    result["memory_stat_bytes"]=None if stats is None else {key:stats[key] for key in MEMORY_FIELDS if key in stats}
    result["unavailable"]=sorted(set(unavailable))
    return result


class CgroupObservation:
    def __init__(self,*,capture=None,before=None):
        self.capture=capture or cgroup_snapshot
        self.before=before if before is not None else self.capture()
        self.after=self.before
        self.observations=0
        self.sampled_peaks={key:None for key in ("memory_current_bytes","memory_swap_current_bytes","anon_bytes","file_cache_bytes")}
        self.oom_event_deltas={key:None for key in OOM_COUNTERS}
        self.observed_oom_event_deltas={key:None for key in OOM_COUNTERS}
        self.scope_changed=False
        self._observe(self.before)

    def _observe(self,current):
        self.after=current
        self.observations+=1
        start_inode=self.before.get("cgroup_directory_inode")
        current_inode=current.get("cgroup_directory_inode")
        if start_inode is not None and current_inode is not None and start_inode!=current_inode:
            self.scope_changed=True
        stats=current.get("memory_stat_bytes") or {}
        values={"memory_current_bytes":current.get("memory_current_bytes"),
                "memory_swap_current_bytes":current.get("memory_swap_current_bytes"),
                "anon_bytes":stats.get("anon"),"file_cache_bytes":stats.get("file")}
        for key,value in values.items():
            if isinstance(value,int):
                self.sampled_peaks[key]=max(self.sampled_peaks[key] or 0,value)
        initial=self.before.get("memory_events") or {}
        latest=current.get("memory_events") or {}
        for key in OOM_COUNTERS:
            if self.observations>1 and not self.scope_changed and key in initial and key in latest and latest[key]>=initial[key]:
                delta=latest[key]-initial[key]
                self.oom_event_deltas[key]=delta
                self.observed_oom_event_deltas[key]=max(self.observed_oom_event_deltas[key] or 0,delta)
            else:
                self.oom_event_deltas[key]=None
        return current

    def sample(self):
        return self._observe(self.capture())

    def failure(self):
        positive={key:value for key,value in self.observed_oom_event_deltas.items() if value is not None and value>0}
        if positive:
            details=", ".join(f"{key}+{value}" for key,value in positive.items())
            return f"Verifier cgroup recorded new OOM events during this execution: {details}."
        return None

    def finish(self):
        self.sample()
        return {
            "schema_version":1,"observer":"atlas-cgroup-v2-v1",
            "peak_time_scope":"memory.peak is a cgroup lifetime high-water counter and was not reset; sampled_peaks cover this attempt's observation window, including verifier and child tools, not process RSS",
            "before":self.before,"after":self.after,"sampled_peaks":self.sampled_peaks,
            "observations":self.observations,"oom_event_deltas":self.oom_event_deltas,
            "observed_oom_event_deltas":self.observed_oom_event_deltas,
            "observation_window":{"start":self.before.get("observed_at"),"end":self.after.get("observed_at")},
            "cgroup_scope_changed":self.scope_changed,
        }
