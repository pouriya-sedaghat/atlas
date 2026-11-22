"""Bounded host-only read-only diagnostic sessions for the five retained stacks.

Only Python process startup is reused. Each observation executes the identical
legacy QUERY in a new transaction explicitly set READ ONLY. No older source,
configuration, schedule or data is written, and no socket is mounted in an app.
"""
import json,os,selectors,subprocess,time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from .legacy import LEGACY,QUERY

class LegacyProbe:
    def __init__(self,scope,evidence):
        if scope not in LEGACY:raise ValueError('Diagnostic scope is not a retained deployment.')
        self.pending=bytearray();self.errors=(Path(evidence)/(scope+'-readonly-probe.stderr')).open('ab')
        code=('import sys\nquery=compile('+repr(QUERY)+",'<bounded-readonly-legacy-probe>','exec')\n"
              "while True:\n request=sys.stdin.readline(16)\n if not request:break\n"
              " if request!='observe\\n':raise ValueError('Unexpected diagnostic request')\n"
              " exec(query)\n sys.stdout.flush()\n")
        try:
            self.process=subprocess.Popen(['docker','exec','-i',scope+'-web-1','python','manage.py','shell','-c',code],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.errors,bufsize=0)
            self.selector=selectors.DefaultSelector();self.selector.register(self.process.stdout,selectors.EVENT_READ)
        except BaseException:self.errors.close();raise

    def read(self):
        if self.process.poll() is not None:raise ValueError('Read-only diagnostic process ended.')
        self.process.stdin.write(b'observe\n');self.process.stdin.flush();deadline=time.monotonic()+6
        while time.monotonic()<deadline:
            while b'\n' in self.pending:
                line,_,rest=self.pending.partition(b'\n');self.pending=bytearray(rest)
                if line.startswith(b'ATLAS_EVIDENCE='):return json.loads(line[len(b'ATLAS_EVIDENCE='):])
            if not self.selector.select(timeout=max(0,deadline-time.monotonic())):break
            data=os.read(self.process.stdout.fileno(),65536)
            if not data:raise ValueError('Read-only diagnostic stream ended.')
            self.pending.extend(data)
            if len(self.pending)>1024**2:raise ValueError('Read-only diagnostic response exceeded its bound.')
        raise ValueError('Read-only diagnostic exceeded six seconds.')

    def close(self):
        try:
            self.process.stdin.close();self.process.wait(timeout=5)
        except (BrokenPipeError,subprocess.TimeoutExpired):
            self.process.terminate();self.process.wait(timeout=5)
        finally:
            self.process.stdout.close();self.selector.close();self.errors.close()

class LegacyProbePool:
    def __init__(self,evidence):self.evidence=evidence;self.probes={}
    def warm(self):
        for scope in LEGACY:self.probes[scope]=LegacyProbe(scope,self.evidence)
        with ThreadPoolExecutor(max_workers=5) as pool:list(pool.map(lambda p:p.read(),self.probes.values()))
    def observe(self,scope):return self.probes[scope].read()
    def close(self):
        for probe in self.probes.values():probe.close()
