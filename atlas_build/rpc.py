"""Small authenticated typed provisioner protocol; no caller-selected SQL/names."""
import hmac,json,os,socket,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError
from uuid import UUID
from django.core.exceptions import ValidationError

class ProvisionerUnavailable(ValidationError):
    pass


OPERATIONS={'create','freeze','inspect','reader_access','metrics','cancel','drop'}
MAX_REQUEST=4096
MAX_RESPONSE=65536


def envelope(value):
    if (not isinstance(value,dict) or set(value)!={'operation','candidate','execution','token'}
            or value['operation'] not in OPERATIONS):raise ValidationError('Unsupported typed provisioner request.')
    for field in ['candidate','execution','token']:
        try:
            if not isinstance(value[field],str) or str(UUID(value[field]))!=value[field]:raise ValueError()
        except (ValueError,TypeError,AttributeError):raise ValidationError('Invalid recorded execution identity.') from None
    return value


def decode_response(data):
    try:
        if len(data)>MAX_RESPONSE:raise ValueError()
        value=json.loads(data)
        if not isinstance(value,dict) or value.get('ok') is not True or 'result' not in value:raise ValueError()
        return value['result']
    except (ValueError,UnicodeError):raise ProvisionerUnavailable('Provisioner returned an unavailable or invalid bounded response.') from None


def call(operation,candidate,execution,token,*,timeout=35,attempts=3):
    if type(attempts) is not int or not 1<=attempts<=3:raise ValidationError('Operation retry bound exceeds three.')
    value=envelope({'operation':operation,'candidate':str(candidate),'execution':str(execution),'token':str(token)})
    secret=Path(os.environ['ATLAS_PROVISIONER_SECRET_FILE']).read_bytes().strip()
    body=json.dumps(value,separators=(',',':')).encode()
    for attempt in range(attempts):
        try:
            request=Request(os.environ.get('ATLAS_PROVISIONER_URL','http://provisioner:8010')+'/operation',data=body,
                 headers={'Authorization':'Bearer '+secret.decode('ascii'),'Content-Type':'application/json'})
            with urlopen(request,timeout=timeout) as response:return decode_response(response.read(MAX_RESPONSE+1))
        except HTTPError as error:
            if error.code not in [500,502,503,504]:raise ValidationError('Provisioner rejected the typed operation.') from None
            if attempt==attempts-1:raise ProvisionerUnavailable('Provisioner transport retries exhausted; operation is temporarily unavailable.') from None
        except (URLError,TimeoutError,socket.timeout,OSError):
            if attempt==attempts-1:raise ProvisionerUnavailable('Provisioner transport retries exhausted; reconcile recorded intent.') from None
        time.sleep(0.2*(2**attempt))


def make_server(address,secret,admin_factory):
    class Handler(BaseHTTPRequestHandler):
        protocol_version='HTTP/1.0'
        def setup(self):super().setup();self.connection.settimeout(5)
        def log_message(self,*args):pass # Never log auth, role credentials or request/response bodies.
        def reply(self,status,value):
            data=json.dumps(value,separators=(',',':'),default=str).encode()
            if len(data)>MAX_RESPONSE:status=500;data=b'{"ok":false,"error":"response limit"}'
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            if self.path=='/health/':self.reply(200,{'ok':True})
            else:self.reply(404,{'ok':False})
        def do_POST(self):
            if self.path!='/operation':return self.reply(404,{'ok':False})
            auth=self.headers.get('Authorization','').encode()
            if not hmac.compare_digest(auth,b'Bearer '+secret):return self.reply(401,{'ok':False})
            try:
                length=int(self.headers.get('Content-Length','-1'))
                if length<0 or length>MAX_REQUEST:return self.reply(413,{'ok':False})
                if self.headers.get('Transfer-Encoding'):return self.reply(400,{'ok':False})
                raw=self.rfile.read(length)
                if len(raw)!=length:raise ValueError()
                value=envelope(json.loads(raw))
            except (ValueError,UnicodeError,ValidationError):return self.reply(400,{'ok':False,'error':'invalid envelope'})
            from django.db import close_old_connections
            close_old_connections()
            try:
                admin=admin_factory()
                result=getattr(admin,value['operation'])(value['candidate'],value['execution'],value['token'])
                self.reply(200,{'ok':True,'result':result})
            except ValidationError:self.reply(409,{'ok':False,'error':'ownership, fence or operation check rejected'})
            except Exception:self.reply(503,{'ok':False,'error':'operation incomplete; reconcile its journal'})
            finally:close_old_connections()
    class Server(ThreadingHTTPServer):
        daemon_threads=True
        def __init__(self,*args):self.slots=threading.BoundedSemaphore(4);super().__init__(*args)
        def process_request(self,request,address):
            if not self.slots.acquire(blocking=False):
                request.sendall(b'HTTP/1.0 503 Busy\r\nContent-Length: 0\r\n\r\n');self.shutdown_request(request);return
            try:super().process_request(request,address)
            except BaseException:self.slots.release();raise
        def process_request_thread(self,*args):
            try:super().process_request_thread(*args)
            finally:self.slots.release()
    return Server(address,Handler)
