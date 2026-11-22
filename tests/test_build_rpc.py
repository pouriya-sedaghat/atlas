"""Typed operation boundary rejects unbounded or caller-selected SQL targets."""
from unittest import TestCase
from uuid import uuid4
from django.core.exceptions import ValidationError

class BuildRPCTests(TestCase):
    def request(self):return {'operation':'create','candidate':str(uuid4()),'execution':str(uuid4()),'token':str(uuid4())}
    def test_typed_envelope_rejects_sql_targets_extra_fields_and_invalid_uuids(self):
        from atlas_build.rpc import envelope
        request=self.request();self.assertEqual(envelope(request),request)
        for invalid in [{**request,'database':'postgres'},{**request,'sql':'DROP DATABASE postgres'},
                        {**request,'operation':'execute'},{**request,'token':'not-a-uuid'},
                        {**request,'candidate':1},{**request,'extra':'x'*5000}]:
            with self.subTest(invalid=invalid),self.assertRaises(ValidationError):envelope(invalid)
    def test_client_authentication_and_response_are_bounded(self):
        from atlas_build.rpc import decode_response
        import json
        self.assertEqual(decode_response(b'{"ok":true,"result":{"state":"FROZEN"}}'),{'state':'FROZEN'})
        for data in [b'x'*65537,b'[]',b'{"ok":false,"error":"operation rejected"}',b'{"ok":true}']:
            with self.assertRaises(ValidationError):decode_response(data)
    def test_http_authentication_limits_and_typed_dispatch(self):
        from atlas_build.rpc import make_server
        import json,threading
        from urllib.request import Request,urlopen
        from urllib.error import HTTPError
        class Admin:
            def __init__(self):self.calls=[]
            def create(self,*args):self.calls.append(args);return {'phase':'LOADING'}
        admin=Admin();server=make_server(('127.0.0.1',0),b'scoped-test-secret',lambda:admin)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        target='http://127.0.0.1:'+str(server.server_port)+'/operation'
        request=self.request()
        def send(body,secret='scoped-test-secret'):
            return urlopen(Request(target,data=body,headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json'}),timeout=3)
        for data,secret,status in [(json.dumps(request).encode(),'wrong',401),(b'x'*4097,'scoped-test-secret',413),
                                    (json.dumps({**request,'sql':'SELECT 1'}).encode(),'scoped-test-secret',400)]:
            with self.assertRaises(HTTPError) as caught:send(data,secret)
            self.assertEqual(caught.exception.code,status)
        self.assertEqual(admin.calls,[])
        with send(json.dumps(request).encode()) as response:self.assertEqual(json.load(response),{'ok':True,'result':{'phase':'LOADING'}})
        self.assertEqual(admin.calls,[(request['candidate'],request['execution'],request['token'])])
