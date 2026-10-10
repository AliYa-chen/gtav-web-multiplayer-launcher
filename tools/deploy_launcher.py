"""Deploy verified launcher downloads and generated PHP config to an OSS site.

Credentials remain in the environment, SSH host keys and TLS are mandatory.
A private, locked transaction stages files and backups outside the public site.
Downloads are verified before switching index.php; only strictly older managed
launcher files are removed from the public site after full HTTPS verification.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import shlex
import socket
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from check_release_assets import all_asset_names, inspect_payloads, sha256
from prepare_release import ROOT, source_fingerprint, version
from readonly_game_outputs import atomic_write_text, validate_outputs


class LauncherDeploymentError(RuntimeError):
    pass


def download_mirror(value):
    if not value:
        return ''
    if not isinstance(value, str) or re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/', value) is None:
        raise LauncherDeploymentError('OSS download mirror must be a plain HTTPS origin ending with /')
    parsed = urllib.parse.urlsplit(value)
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise LauncherDeploymentError('OSS download mirror has an invalid port')
    return value


def download_mirrors(value, legacy=''):
    try:
        values = json.loads(value) if value else []
    except (TypeError, json.JSONDecodeError):
        raise LauncherDeploymentError('OSS download mirrors must be a JSON array of HTTPS origins') from None
    if not isinstance(values, list) or len(values) > 5 or any(not isinstance(item, str) or not item for item in values):
        raise LauncherDeploymentError('OSS download mirrors must list at most five HTTPS origins')
    mirrors = [download_mirror(item) for item in values]
    if legacy:
        mirrors.append(download_mirror(legacy))
    return list(dict.fromkeys(mirrors))


def public_release_urls(metadata, name, mirrors):
    repository = metadata.get('repository')
    if (not isinstance(repository, str) or re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) is None
            or any(part in ('.', '..') for part in repository.split('/'))):
        raise LauncherDeploymentError('Launcher repository must identify a public owner/repository')
    candidate = version(metadata.get('version'))
    if metadata.get('tag') != f'launcher-v{candidate}' or name not in {row['name'] for row in metadata['payloads']}:
        raise LauncherDeploymentError('Launcher download must identify an exact verified release asset')
    official = f'https://github.com/{repository}/releases/download/launcher-v{candidate}/{name}'
    mirrors = [download_mirror(mirror) for mirror in mirrors]
    return [mirror + official for mirror in mirrors] + [official]


def validate_local(assets_directory, config, metadata):
    assets_directory, config, metadata = map(Path, (assets_directory, config, metadata))
    if assets_directory.is_symlink() or not assets_directory.is_dir():
        raise LauncherDeploymentError('Launcher assets directory must be ordinary')
    for path in (config, metadata):
        if path.is_symlink() or not path.is_file():
            raise LauncherDeploymentError('Candidate config and metadata must be ordinary files')
    description = json.loads(metadata.read_text(encoding='utf-8'))
    candidate = version(description.get('version'))
    tag = f'launcher-v{candidate}'
    if description.get('schema') != 1 or description.get('tag') != tag:
        raise LauncherDeploymentError('Candidate launcher metadata schema/tag is invalid')
    provenance_path = assets_directory / f'provenance-{tag}.json'
    if provenance_path.is_symlink() or not provenance_path.is_file():
        raise LauncherDeploymentError('Launcher build provenance is missing')
    provenance = json.loads(provenance_path.read_text(encoding='utf-8'))
    for field, expected in {'schema': 1, 'component': 'launcher', 'tag': tag, 'version': candidate,
                            'runtime_version': candidate, 'repository': description.get('repository'),
                            'source_commit': description.get('source_commit'),
                            'source_sha256': description.get('source_sha256')}.items():
        if provenance.get(field) != expected:
            raise LauncherDeploymentError('Candidate metadata differs from launcher build provenance')
    commit = provenance.get('source_commit')
    if not isinstance(commit, str) or re.fullmatch(r'[0-9a-f]{40}', commit) is None:
        raise LauncherDeploymentError('Launcher provenance must identify an exact build commit')
    digest = provenance.get('source_sha256')
    if not isinstance(digest, str) or re.fullmatch(r'[0-9a-f]{64}', digest) is None:
        raise LauncherDeploymentError('Launcher provenance source digest is invalid')
    source_available = subprocess.run(['git', 'cat-file', '-e', f'{commit}^{{commit}}'], cwd=ROOT,
                                      capture_output=True, check=False).returncode == 0
    if source_available and source_fingerprint('launcher', commit)[0] != digest:
        raise LauncherDeploymentError('Original launcher source fingerprint does not match its provenance')
    item = {'version': candidate, 'runtime_version': candidate, 'tag': tag}
    expected_names = set(all_asset_names('launcher', item))
    if {path.name for path in assets_directory.iterdir()} != expected_names:
        raise LauncherDeploymentError('Expected exactly the seven published launcher assets')
    paths = {name: assets_directory / name for name in expected_names}
    for path in paths.values():
        if path.is_symlink() or not path.is_file():
            raise LauncherDeploymentError('Launcher assets must be ordinary files')
    payloads = inspect_payloads({'components': {'launcher': item}}, 'launcher', assets_directory)
    expected_payloads = {path.name: path for path in payloads}
    for rows in (description.get('payloads'), provenance.get('assets')):
        if not isinstance(rows, list) or len(rows) != 2 or {row.get('name') for row in rows} != set(expected_payloads):
            raise LauncherDeploymentError('Both published platform assets must be listed exactly once')
        for row in rows:
            path = expected_payloads[row['name']]
            if row.get('bytes') != path.stat().st_size or row.get('sha256') != sha256(path):
                raise LauncherDeploymentError('Launcher payload differs from its original SHA-256 or size')
    rows = description['payloads']
    for row in rows:
        public_release_urls(description, row['name'], [])
    if {row.get('platform') for row in rows} != {'windows_x64', 'macos_arm64'}:
        raise LauncherDeploymentError('Launcher metadata must contain Windows x64 and macOS ARM64')
    mapping = {'windows_x64': payloads[0].name, 'macos_arm64': payloads[1].name}
    if any(row['name'] != mapping[row['platform']] for row in rows):
        raise LauncherDeploymentError('Launcher metadata platform does not match its executable architecture')
    if description.get('config_sha256') != sha256(config):
        raise LauncherDeploymentError('Candidate PHP differs from its generated metadata SHA-256')
    covered = set()
    for line in paths[f'SHA256SUMS-{tag}.txt'].read_text(encoding='utf-8').splitlines():
        digest, name = line.split('  ', 1)
        if name not in paths or name in covered or re.fullmatch(r'[0-9a-f]{64}', digest) is None:
            raise LauncherDeploymentError('Launcher checksum manifest is malformed')
        if sha256(paths[name]) != digest:
            raise LauncherDeploymentError('Published launcher asset checksum verification failed')
        covered.add(name)
    if covered != expected_names - {f'SHA256SUMS-{tag}.txt'}:
        raise LauncherDeploymentError('Published launcher checksums do not cover all assets')
    return description, payloads, source_available


def settings():
    import paramiko
    values = {name: os.environ.get('GTA_OSS_SSH_' + name, '')
              for name in ('HOST', 'PORT', 'USER', 'PASSWORD', 'KNOWN_HOSTS')}
    if not all(values.values()):
        raise LauncherDeploymentError('Missing required OSS SSH environment credentials')
    if (re.fullmatch(r'[A-Za-z0-9.-]+', values['HOST']) is None
            or re.fullmatch(r'[A-Za-z0-9_-]+', values['USER']) is None
            or not values['PORT'].isdecimal() or not 1 <= int(values['PORT']) <= 65535):
        raise LauncherDeploymentError('Invalid OSS SSH host/user/port configuration')
    keys = paramiko.HostKeys()
    for line in values['KNOWN_HOSTS'].splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        entry = paramiko.hostkeys.HostKeyEntry.from_line(line)
        if entry is None:
            raise LauncherDeploymentError('Invalid OSS trusted SSH host key entry')
        for hostname in entry.hostnames:
            keys.add(hostname, entry.key.get_name(), entry.key)
    identity = values['HOST'] if int(values['PORT']) == 22 else f"[{values['HOST']}]:{values['PORT']}"
    if keys.lookup(identity) is None:
        raise LauncherDeploymentError('Missing pinned OSS SSH host key')
    site = os.environ.get('GTA_OSS_SITE_ROOT') or '/opt/1panel/www/sites/oss.2t.hk/index/gtav'
    private = os.environ.get('GTA_OSS_DEPLOY_ROOT') or '/opt/gta5data-launcher-deploy'
    for path in (site, private):
        if (re.fullmatch(r'/[A-Za-z0-9_./-]+', path) is None
                or '..' in Path(path).parts or path.endswith('/')):
            raise LauncherDeploymentError('Invalid OSS site/private deployment path')
    if Path(private).is_relative_to(Path(site)) or Path(site).is_relative_to(Path(private)):
        raise LauncherDeploymentError('Deployment backups/staging must be outside the public site')
    origin = os.environ.get('GTA_OSS_PUBLIC_ORIGIN') or 'https://oss.2t.hk/gtav'
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or '\\' in origin):
        raise LauncherDeploymentError('OSS public origin must be a plain HTTPS URL')
    container = os.environ.get('GTA_OSS_PHP_CONTAINER') or ''
    if container and re.fullmatch(r'[A-Za-z0-9_.-]+', container) is None:
        raise LauncherDeploymentError('Invalid OSS PHP container name')
    mirrors = download_mirrors(os.environ.get('GTA_OSS_DOWNLOAD_MIRRORS', ''),
                               os.environ.get('GTA_OSS_DOWNLOAD_MIRROR', ''))
    return values, keys, {'site': site, 'private': private, 'origin': origin.rstrip('/'),
                          'php_container': container, 'download_mirrors': mirrors}


def connect(values, keys):
    import paramiko
    from deploy_server import ssh_error_category
    client = paramiko.SSHClient()
    client._host_keys = keys
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(values['HOST'], port=int(values['PORT']), username=values['USER'],
                       password=values['PASSWORD'], look_for_keys=False, allow_agent=False,
                       timeout=15, auth_timeout=15, banner_timeout=15, compress=True)
        client.get_transport().set_keepalive(30)
    except Exception as error:
        client.close()
        raise LauncherDeploymentError('OSS SSH failed: ' + ssh_error_category(error, paramiko)) from None
    return client


# Runs in one SSH process. Its exclusive flock spans staging, HTTPS checks and
# publication, including deployments started outside this GitHub workflow.
REMOTE_TRANSACTION = r'''
import fcntl,hashlib,json,os,pathlib,re,shutil,signal,stat,subprocess,sys,tempfile,urllib.parse
class Fail(Exception):pass
state=None
def interrupted(signum,frame):raise SystemExit(1)
for number in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):signal.signal(number,interrupted)
def ordinary(path,kind=None,missing=False):
 p=pathlib.Path(path)
 if not p.is_absolute() or '..' in p.parts:raise Fail('unsafe_path')
 for node in [*reversed(p.parents),p]:
  if node.is_symlink():raise Fail('symlink_path_rejected')
 if not p.exists():
  if missing:return p
  raise Fail('missing_path')
 s=p.stat()
 if kind=='file' and (not stat.S_ISREG(s.st_mode) or s.st_nlink!=1):raise Fail('nonordinary_or_linked_file')
 if kind=='directory' and not stat.S_ISDIR(s.st_mode):raise Fail('nonordinary_directory')
 return p
def digest(path):
 ordinary(path,'file');h=hashlib.sha256()
 with open(path,'rb') as f:
  for body in iter(lambda:f.read(1048576),b''):h.update(body)
 return h.hexdigest()
def mkdir(path):
 ordinary(path,missing=True);pathlib.Path(path).mkdir(parents=True,exist_ok=True);ordinary(path,'directory')
def fresh_copy(source,target,attrs):
 source=ordinary(source,'file');target=ordinary(target,missing=True)
 if target.exists():ordinary(target,'file')
 ordinary(target.parent,'directory')
 fd,name=tempfile.mkstemp(prefix='.'+target.name+'.launcher-',dir=target.parent);temporary=pathlib.Path(name)
 try:
  with os.fdopen(fd,'wb') as output,source.open('rb') as input:
   shutil.copyfileobj(input,output,1048576);output.flush();os.fsync(output.fileno());os.fchmod(output.fileno(),attrs['mode']);os.fchown(output.fileno(),attrs['uid'],attrs['gid'])
  ordinary(target,missing=True)
  if target.exists():ordinary(target,'file')
  os.replace(temporary,target)
 finally:
  temporary.unlink(missing_ok=True)
def attributes(path):
 s=ordinary(path).stat();return {'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)}
def journal(value=None):
 body=json.dumps(state if value is None else value,sort_keys=True).encode();path=pathlib.Path(state['transaction'])/'journal.json';ordinary(path,missing=True)
 if path.exists():ordinary(path,'file')
 fd,name=tempfile.mkstemp(prefix='.journal-',dir=path.parent)
 with os.fdopen(fd,'wb') as f:f.write(body);f.flush();os.fsync(f.fileno())
 os.chmod(name,0o600);os.replace(name,path)
def php(body,container):
 base=['docker','exec','-i',container,'php'] if container else ['php']
 info=subprocess.run(base+['-r','echo PHP_VERSION_ID;'],capture_output=True,timeout=20)
 if info.returncode or not info.stdout.strip().isdigit() or int(info.stdout.strip())<70400:raise Fail('php_7_4_required')
 lint=subprocess.run(base+['-l'],input=body,capture_output=True,timeout=30)
 if lint.returncode:raise Fail('candidate_php_lint_failed')
 rendered=subprocess.run(base,input=body,capture_output=True,timeout=30)
 if rendered.returncode or len(rendered.stdout)>262144:raise Fail('candidate_php_render_failed')
 try:result=json.loads(rendered.stdout)
 except Exception:raise Fail('candidate_php_json_invalid')
 if not isinstance(result,dict):raise Fail('candidate_php_json_invalid')
 return result
def semver(value):
 if not isinstance(value,str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)',value):raise Fail('invalid_version')
 return tuple(map(int,value.split('.')))
def managed_version(name):
 match=re.fullmatch(r'GTA5Data-Launcher-(?:Windows-x64-v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\.exe|macOS-arm64-v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-development)?\.zip)',name)
 return semver(match.group(1) or match.group(2)) if match else None
def rollback():
 if state is None or state['committed']:return
 site=pathlib.Path(state['site']);backup=pathlib.Path(state['backup'])
 # Make old downloads available before restoring their advertised config; new
 # downloads remain available until the previous configuration is back in place.
 for row in reversed(state['removed']):
  target=site/row['name'];stored=backup/('removed-'+row['name'])
  if digest(stored)!=row['sha256']:raise Fail('rollback_backup_hash_changed')
  if target.exists():
   if digest(target)!=row['sha256']:raise Fail('rollback_target_changed')
  else:fresh_copy(stored,target,row['attrs'])
 if state['switched']:
  target=site/'index.php';current=digest(target)
  if current not in (state['config_sha256'],state['index_original_sha256']):raise Fail('rollback_live_config_changed')
  if digest(backup/'index.php')!=state['index_original_sha256']:raise Fail('rollback_original_config_backup_changed')
  if current!=state['index_original_sha256']:fresh_copy(backup/'index.php',target,state['index_attrs'])
  state['switched']=False
 for row in reversed(state['added']):
  path=site/row['name']
  if path.exists():
   if digest(path)!=row['sha256']:raise Fail('rollback_payload_changed')
   ordinary(path,'file');path.unlink()
 state['rolled_back']=True;journal()
def begin(request):
 global state
 repository=request.get('repository')
 if not isinstance(repository,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repository) or any(part in ('.','..') for part in repository.split('/')):raise Fail('invalid_release_repository')
 mirrors=request.get('download_mirrors',[])
 if not isinstance(mirrors,list) or len(mirrors)>6:raise Fail('invalid_download_mirror')
 for mirror in mirrors:
  if not isinstance(mirror,str) or not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/',mirror):raise Fail('invalid_download_mirror')
  if urllib.parse.urlsplit(mirror).port is not None and not 1<=urllib.parse.urlsplit(mirror).port<=65535:raise Fail('invalid_download_mirror')
 site=ordinary(request['site'],'directory');private=ordinary(request['private'],'directory')
 if private==site or private.is_relative_to(site) or site.is_relative_to(private):raise Fail('private_storage_must_be_outside_site')
 # A hard kill/power loss cannot run Python finally. Preserve its journal and
 # refuse a new deployment until the unfinished transaction is inspected.
 for previous in private.glob('transaction-*'):
  ordinary(previous,'directory');record=previous/'journal.json'
  if not record.exists():continue
  ordinary(record,'file')
  if record.stat().st_size>262144:raise Fail('invalid_previous_transaction_journal')
  try:prior=json.loads(record.read_text())
  except Exception:raise Fail('invalid_previous_transaction_journal')
  if not isinstance(prior,dict) or prior.get('site')!=str(site):continue
  if not prior.get('committed') and not prior.get('rolled_back'):raise Fail('unfinished_previous_transaction_requires_recovery')
 index=ordinary(site/'index.php','file');attrs=attributes(index);candidate=semver(request['version']);older=[]
 for entry in site.iterdir():
  found=managed_version(entry.name)
  if found is None:continue
  ordinary(entry,'file')
  if found>candidate:raise Fail('newer_launcher_file_already_present')
  if found<candidate:older.append({'name':entry.name,'sha256':digest(entry),'attrs':attributes(entry)})
 existing_names=[]
 for row in request['payloads']:
  target=ordinary(site/row['name'],missing=True)
  if target.exists():
   ordinary(target,'file')
   if target.stat().st_size!=row['bytes'] or digest(target)!=row['sha256']:raise Fail('same_version_payload_is_immutable')
   existing_names.append(row['name'])
 transaction=pathlib.Path(tempfile.mkdtemp(prefix='transaction-',dir=private));os.chmod(transaction,0o700)
 stage=transaction/'stage';backup=transaction/'backup';mkdir(stage);mkdir(backup)
 state={'site':str(site),'transaction':str(transaction),'stage':str(stage),'backup':str(backup),
  'version':request['version'],'payloads':request['payloads'],'config_sha256':request['config_sha256'],
  'index_attrs':attrs,'index_original_sha256':digest(index),'older':older,'added':[],'removed':[],
  'switched':False,'committed':False,'rolled_back':False,'php_container':request['php_container'],
  'repository':repository,'download_mirrors':mirrors}
 fresh_copy(index,backup/'index.php',attrs);journal()
 return {'stage':str(stage),'backup':str(backup),'current':php(index.read_bytes(),request['php_container']), 'older_files':len(older),'existing_names':existing_names}
def fetch(request):
 row=next((row for row in state['payloads'] if row['name']==request.get('name')),None)
 if row is None or managed_version(row['name'])!=semver(state['version']):raise Fail('invalid_fetch_payload')
 official='https://github.com/'+state['repository']+'/releases/download/launcher-v'+state['version']+'/'+row['name']
 permitted=[official]+[mirror+official for mirror in state['download_mirrors']]
 url=request.get('url')
 if not isinstance(url,str) or url not in permitted:raise Fail('invalid_fetch_url')
 stage=ordinary(state['stage'],'directory');target=ordinary(stage/row['name'],missing=True)
 if target.exists():raise Fail('staged_payload_already_exists')
 descriptor,name=tempfile.mkstemp(prefix='.fetch-',dir=stage);os.close(descriptor);temporary=pathlib.Path(name)
 try:
  ordinary(temporary,'file')
  try:
   result=subprocess.run(['curl','--proto','=https','--proto-redir','=https','--fail','--location','--silent','--show-error','--connect-timeout','8','--max-time','120','--max-filesize',str(row['bytes']),'--output',str(temporary),url],capture_output=True,timeout=130)
  except (OSError,subprocess.TimeoutExpired):return {'fetched':False,'reason':'download_failed'}
  if result.returncode:return {'fetched':False,'reason':'download_failed'}
  ordinary(temporary,'file')
  if temporary.stat().st_size!=row['bytes'] or digest(temporary)!=row['sha256']:return {'fetched':False,'reason':'download_integrity_failed'}
  with temporary.open('rb') as downloaded:os.fsync(downloaded.fileno())
  ordinary(target,missing=True)
  if target.exists():raise Fail('staged_payload_already_exists')
  os.replace(temporary,target)
  return {'fetched':True,'source_host':urllib.parse.urlsplit(url).hostname}
 finally:temporary.unlink(missing_ok=True)
def install():
 site=pathlib.Path(state['site']);stage=pathlib.Path(state['stage'])
 config=ordinary(stage/'candidate-index.php','file')
 if digest(config)!=state['config_sha256']:raise Fail('staged_config_hash_mismatch')
 expected=php(config.read_bytes(),state['php_container'])
 for row in state['payloads']:
  target=ordinary(site/row['name'],missing=True)
  if target.exists():
   ordinary(target,'file')
   if target.stat().st_size!=row['bytes'] or digest(target)!=row['sha256']:raise Fail('same_version_payload_is_immutable')
   continue
  source=ordinary(stage/row['name'],'file')
  if source.stat().st_size!=row['bytes'] or digest(source)!=row['sha256']:raise Fail('staged_payload_hash_mismatch')
  state['added'].append({'name':row['name'],'sha256':row['sha256']});journal();fresh_copy(source,target,state['index_attrs'])
 return {'candidate':expected,'payloads_ready':True}
def switch():
 site=pathlib.Path(state['site']);target=ordinary(site/'index.php','file')
 if digest(target)!=state['index_original_sha256']:raise Fail('live_config_changed_during_deployment')
 if digest(pathlib.Path(state['stage'])/'candidate-index.php')!=state['config_sha256']:raise Fail('staged_config_hash_mismatch')
 if digest(pathlib.Path(state['backup'])/'index.php')!=state['index_original_sha256']:raise Fail('original_config_backup_changed')
 # Record intent before publication so interruption can recover the original.
 state['switched']=True;journal()
 fresh_copy(pathlib.Path(state['stage'])/'candidate-index.php',target,state['index_attrs'])
 return {'config_installed':True}
def cleanup():
 site=pathlib.Path(state['site']);backup=pathlib.Path(state['backup'])
 for row in state['older']:
  target=ordinary(site/row['name'],'file')
  if digest(target)!=row['sha256']:raise Fail('older_payload_changed_during_deployment')
  stored=backup/('removed-'+row['name']);fresh_copy(target,stored,row['attrs'])
  if digest(stored)!=row['sha256']:raise Fail('older_payload_backup_hash_mismatch')
  state['removed'].append(row);journal();ordinary(target,'file');target.unlink()
 return {'old_files_removed':len(state['removed'])}
def finalize():
 journal({**state,'committed':True});state['committed']=True
 return {'committed':True,'backup':state['backup']}
lock=None
try:
 request=json.loads(sys.stdin.readline());private=pathlib.Path(request['private']);mkdir(private)
 lockpath=ordinary(private/'deployment.lock',missing=True)
 descriptor=os.open(lockpath,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);lock=os.fdopen(descriptor,'a+')
 ordinary(lockpath,'file');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 print(json.dumps({'ok':True,'result':{'locked':True}}),flush=True)
 for line in sys.stdin:
  try:
   request=json.loads(line);operation=request['operation']
   if operation=='begin':result=begin(request)
   elif operation=='fetch':result=fetch(request)
   elif operation=='install':result=install()
   elif operation=='switch':result=switch()
   elif operation=='cleanup':result=cleanup()
   elif operation=='finalize':result=finalize()
   elif operation=='rollback':rollback();result={'rolled_back':bool(state and state['rolled_back']),'committed':bool(state and state['committed'])}
   else:raise Fail('unknown_transaction_operation')
   print(json.dumps({'ok':True,'result':result}),flush=True)
  except Exception as error:
   code=str(error) if isinstance(error,Fail) else 'remote_transaction_failed'
   print(json.dumps({'ok':False,'error':code}),flush=True)
finally:
 try:rollback()
 except Exception:
  try:
   if state is not None:state['rollback_error']='automatic_rollback_failed';journal()
  except Exception:pass
 if lock is not None:lock.close()
'''


class RemoteTransaction:
    def __init__(self, client, private):
        self.stdin, self.stdout, self.stderr = client.exec_command(
            'python3 -u -c ' + shlex.quote(REMOTE_TRANSACTION), timeout=160)
        self.stdin.write(json.dumps({'private': private}) + '\n')
        self.stdin.flush()
        self.read()

    def read(self):
        body = self.stdout.readline()
        if not body or len(body) > 512 * 1024:
            raise LauncherDeploymentError('OSS transaction connection ended or returned invalid data')
        try:
            response = json.loads(body)
        except Exception:
            raise LauncherDeploymentError('OSS transaction response is invalid') from None
        if response.get('ok') is not True:
            code = response.get('error')
            if not isinstance(code, str) or re.fullmatch(r'[a-z0-9_]+', code) is None:
                code = 'remote_transaction_failed'
            raise LauncherDeploymentError('OSS transaction failed: ' + code)
        return response['result']

    def call(self, operation, **arguments):
        self.stdin.write(json.dumps({'operation': operation, **arguments}, ensure_ascii=False) + '\n')
        self.stdin.flush()
        return self.read()

    def close(self):
        try:
            self.stdin.channel.shutdown_write()
        except Exception:
            pass


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin):
        self.origin = urllib.parse.urlsplit(origin)

    def redirect_request(self, request, response, code, message, headers, new_url):
        parsed = urllib.parse.urlsplit(new_url)
        if (parsed.scheme != 'https' or parsed.netloc != self.origin.netloc
                or parsed.username or parsed.password):
            raise LauncherDeploymentError('OSS HTTPS redirect changed the trusted origin')
        return super().redirect_request(request, response, code, message, headers, new_url)


def https_failure(error):
    if isinstance(error, urllib.error.HTTPError):
        return f'http_{error.code}', error.code in (408, 429) or 500 <= error.code <= 599
    if isinstance(error, urllib.error.URLError):
        if isinstance(error.reason, BaseException):
            category, retry = https_failure(error.reason)
            if category == 'transport_error' and isinstance(error.reason, OSError):
                return 'network_error', True
            return category, retry
        return 'network_error', True
    if isinstance(error, ssl.SSLCertVerificationError):
        return 'certificate_verification_failed', False
    if isinstance(error, ssl.SSLError):
        return 'tls_error', False
    if isinstance(error, TimeoutError):
        return 'timeout', True
    if isinstance(error, (http.client.IncompleteRead, http.client.RemoteDisconnected)):
        return 'incomplete_response', True
    if isinstance(error, (ConnectionError, socket.gaierror)):
        return 'connection_error', True
    return 'transport_error', False


def https_body(origin, url, *, maximum=None, digest=None, request_timeout=60,
               attempts=1, attempt_timeout=120, verification_phase='config'):
    parsed, trusted = urllib.parse.urlsplit(url), urllib.parse.urlsplit(origin)
    if parsed.scheme != 'https' or parsed.netloc != trusted.netloc or parsed.username or parsed.password:
        raise LauncherDeploymentError('Launcher public URL differs from the configured HTTPS origin')
    opener = urllib.request.build_opener(SameOriginRedirect(origin), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'GTAV-Launcher-Deploy/1'})
    name = Path(parsed.path).name
    if re.fullmatch(r'[A-Za-z0-9_.-]+', name) is None:
        name = 'config'
    for attempt in range(1, attempts + 1):
        # Restart from byte zero and a fresh digest after any interrupted read.
        hasher, total, chunks = hashlib.sha256(), 0, []
        deadline = time.monotonic() + attempt_timeout
        try:
            with opener.open(request, timeout=min(request_timeout, attempt_timeout)) as response:
                if response.status != 200:
                    raise LauncherDeploymentError('OSS HTTPS verification did not return HTTP 200')
                read = getattr(response, 'read1', response.read)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError('HTTPS verification attempt deadline exceeded')
                    # urllib's HTTPResponse uses a buffered SocketIO. Limit each
                    # read to the remaining total deadline as well as idle time.
                    raw = getattr(getattr(response, 'fp', None), 'raw', None)
                    connection = getattr(raw, '_sock', None)
                    if connection is not None:
                        connection.settimeout(min(request_timeout, remaining))
                    chunk = read(1024 * 1024)
                    if not chunk:
                        outstanding = getattr(response, 'length', None)
                        if isinstance(outstanding, int) and outstanding > 0:
                            raise http.client.IncompleteRead(b'', outstanding)
                        break
                    total += len(chunk)
                    if maximum is not None and total > maximum:
                        raise LauncherDeploymentError('OSS HTTPS verification exceeded its expected size')
                    hasher.update(chunk)
                    if digest is None:
                        chunks.append(chunk)
            if digest is not None:
                if hasher.hexdigest() != digest or maximum is not None and total != maximum:
                    raise LauncherDeploymentError('Public launcher download SHA-256 or size verification failed')
                return total
            return b''.join(chunks)
        except LauncherDeploymentError:
            raise
        except Exception as error:
            category, retry = https_failure(error)
            print(f'HTTPS verification phase={verification_phase} file={name} '
                  f'attempt={attempt}/{attempts} category={category}', flush=True)
            if not retry or attempt == attempts:
                raise LauncherDeploymentError('OSS HTTPS/TLS verification failed: ' + category) from None
            time.sleep(min(3 * attempt, 6))


def verify_downloads(metadata, origin, phase, audit):
    audit['phase'] = phase
    for row in metadata['payloads']:
        audit['last_download'] = row['name']
        print(f'Verifying HTTPS download phase={phase} file={row["name"]}', flush=True)
        https_body(origin, row['url'], maximum=row['bytes'], digest=row['sha256'],
                   request_timeout=45, attempts=3, attempt_timeout=120, verification_phase=phase)
        audit['last_verified_download'] = row['name']
        print(f'Verified HTTPS download phase={phase} file={row["name"]}', flush=True)


def verify_candidate(candidate, metadata, origin):
    if not isinstance(candidate, dict) or not isinstance(candidate.get('update'), dict):
        raise LauncherDeploymentError('Candidate PHP must emit the launcher update JSON')
    update = candidate['update']
    if update.get('latest_version') != metadata['version']:
        raise LauncherDeploymentError('Candidate PHP launcher version differs from its metadata')
    expected = {row['platform']: {'url': origin + '/' + row['name'], 'sha256': row['sha256']}
                for row in metadata['payloads']}
    if update.get('downloads') != expected:
        raise LauncherDeploymentError('Candidate PHP download URLs/hashes differ from the verified assets')
    notes = metadata.get('release_notes')
    if (not isinstance(notes, dict) or not isinstance(notes.get('en'), str)
            or not isinstance(notes.get('zh-CN'), str) or not notes['en'].strip() or not notes['zh-CN'].strip()):
        raise LauncherDeploymentError('Candidate metadata must include nonempty English and Chinese release notes')
    if update.get('release_notes') != notes['zh-CN']:
        raise LauncherDeploymentError('Candidate default release notes differ from the generated Chinese notes')
    for language in ('en', 'zh-CN'):
        if candidate.get('i18n', {}).get(language, {}).get('release_notes') != notes[language]:
            raise LauncherDeploymentError('Candidate translated release notes differ from generated metadata')
    for row in metadata['payloads']:
        if row.get('url') != origin + '/' + row['name']:
            raise LauncherDeploymentError('Candidate metadata public URL differs from configured origin')


def verify_public_config(origin, expected, timeout=45):
    deadline = time.monotonic() + timeout
    while True:
        try:
            served = json.loads(https_body(origin, origin + '/?launcher_deployment=' + str(time.time_ns()),
                                           maximum=262144, request_timeout=max(1, min(10, deadline - time.monotonic()))))
            if served == expected:
                return
        except (LauncherDeploymentError, json.JSONDecodeError):
            pass
        if time.monotonic() >= deadline:
            raise LauncherDeploymentError('Live OSS JSON differs from the complete generated candidate configuration')
        time.sleep(min(3, max(0, deadline - time.monotonic())))


def upload(client, stage, files):
    sftp = client.open_sftp()
    try:
        sftp.get_channel().settimeout(60)
        for source, name in files:
            size = source.stat().st_size
            print(f'Uploading {name} ({size} bytes)', flush=True)
            destination = stage + '/' + name
            with sftp.open(destination, 'wx') as target, source.open('rb') as stream:
                target.set_pipelined(True)
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    target.write(chunk)
            sftp.chmod(destination, 0o600)
            print(f'Uploaded {name} ({size} bytes)', flush=True)
    finally:
        sftp.close()


def fetch_payloads(transaction, metadata, mirrors, payloads):
    fetched, sources = set(), {}
    for path in payloads:
        for url in public_release_urls(metadata, path.name, mirrors):
            host = urllib.parse.urlsplit(url).hostname
            print(f'Fetching {path.name} from {host}', flush=True)
            result = transaction.call('fetch', name=path.name, url=url)
            if result.get('fetched') is True:
                fetched.add(path.name)
                sources[path.name] = host
                print(f'Fetched {path.name} from {host}', flush=True)
                break
            print(f'Fetch failed for {path.name} from {host}; trying next source or SSH upload', flush=True)
    return fetched, sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-directory', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--report', type=Path, default=ROOT / 'archive/deployment/launcher-deployment.json')
    args = parser.parse_args()
    sources = (args.config, args.metadata, *[path for path in args.assets_directory.glob('*') if path.is_file()])
    validate_outputs((args.report,), sources=sources)
    audit = {'started_utc': datetime.now(timezone.utc).isoformat(), 'result': 'failed',
             'rollback': 'not_needed', 'phase': 'validate_inputs'}
    client, transaction = None, None
    try:
        metadata, payloads, source_available = validate_local(args.assets_directory, args.config, args.metadata)
        values, keys, config = settings()
        audit.update(version=metadata['version'], source_commit=metadata['source_commit'],
                     original_source_checked=source_available, config_sha256=metadata['config_sha256'])
        audit['phase'] = 'connect'
        client = connect(values, keys)
        transaction = RemoteTransaction(client, config['private'])
        audit['phase'] = 'begin'
        begin = transaction.call('begin', **config, version=metadata['version'], payloads=metadata['payloads'],
                                 config_sha256=metadata['config_sha256'], repository=metadata['repository'])
        audit['backup'] = begin['backup']
        live_version = begin['current'].get('update', {}).get('latest_version')
        if tuple(map(int, version(live_version).split('.'))) > tuple(map(int, metadata['version'].split('.'))):
            raise LauncherDeploymentError('Live launcher version is newer; downgrade refused')
        existing_names = set(begin['existing_names'])
        audit['reused_payloads'] = len(existing_names)
        missing = [path for path in payloads if path.name not in existing_names]
        audit['phase'] = 'stage_downloads'
        fetched, sources = fetch_payloads(transaction, metadata, config['download_mirrors'], missing)
        audit.update(fetched_payloads=len(fetched), payload_sources=sources)
        upload(client, begin['stage'], [(path, path.name) for path in missing if path.name not in fetched]
               + [(args.config, 'candidate-index.php')])
        audit['phase'] = 'install'
        installed = transaction.call('install')
        expected = installed['candidate']
        verify_candidate(expected, metadata, config['origin'])
        verify_downloads(metadata, config['origin'], 'before_config', audit)
        audit['downloads_verified_before_config'] = True
        audit['phase'] = 'switch_config'
        transaction.call('switch')
        audit['phase'] = 'verify_config'
        verify_public_config(config['origin'], expected)
        verify_downloads(metadata, config['origin'], 'after_config', audit)
        audit['complete_config_and_downloads_verified'] = True
        audit['phase'] = 'cleanup'
        removed = transaction.call('cleanup')
        audit['phase'] = 'finalize'
        completed = transaction.call('finalize')
        audit.update(result='success', phase='complete', removed_old_files=removed['old_files_removed'], backup=completed['backup'])
        print(json.dumps({'launcher_version': metadata['version'], 'result': 'success',
                          'removed_old_files': removed['old_files_removed']}), flush=True)
    except Exception as error:
        audit['error'] = str(error) if isinstance(error, LauncherDeploymentError) else 'Launcher input or deployment validation failed'
        if transaction is not None:
            try:
                result = transaction.call('rollback')
                audit['rollback'] = ('not_performed_already_committed' if result.get('committed')
                                     else 'restored' if result.get('rolled_back') else 'not_needed')
            except Exception:
                audit['rollback'] = 'failed_requires_operator'
        print('Launcher deployment failed: ' + audit['error'], file=sys.stderr)
    finally:
        if transaction is not None:
            transaction.close()
        if client is not None:
            client.close()
        atomic_write_text(args.report, json.dumps(audit, ensure_ascii=False, indent=2) + '\n', sources=sources)
    return 0 if audit['result'] == 'success' else 1


if __name__ == '__main__':
    raise SystemExit(main())
