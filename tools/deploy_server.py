"""Deploy verified server JARs to existing services; preserve world data and TLS.

Credentials are environment-only. SSH host keys and public TLS are mandatory.
Experimental lanes verify before main lanes. Same executable entries skip restart;
changed code under the same runtime version is rejected rather than overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from check_release_assets import inspect_server_jar, verify_release_directory
from prepare_release import ROOT, load_plan
from readonly_game_outputs import atomic_write_text, validate_output


class DeploymentError(RuntimeError):
    pass


# One migration baseline, checked against the recorded four-lane 0.4.3 rollout.
# Different javac versions can produce different bytecode for identical Java.
LEGACY_043_JAR_SHA256 = 'c7db04fc11a6f1160d4dd2775e79e7daa8ec5c3b2dca9a964d07f55fc10198c4'
LEGACY_043_JAVA_SHA256 = 'b3d4ec2c5546218ef8e9f64dc73b1880ec88784fa88a5f3c39caa25c4e1a0908'


def java_source_digest():
    result = hashlib.sha256()
    for path in sorted((ROOT / 'server/src/main/java').rglob('*.java')):
        result.update(path.relative_to(ROOT).as_posix().encode() + b'\0' + path.read_text(encoding='utf-8').encode() + b'\0')
    return result.hexdigest()


def deployment_decision(installed, expected, candidate_entries):
    current = installed['health']['server_version']
    if (current == expected == '0.4.3-world-experimental'
            and installed['jar_sha256'] == LEGACY_043_JAR_SHA256
            and java_source_digest() == LEGACY_043_JAVA_SHA256):
        return 'skip', 'recorded_0.4.3_jar_and_identical_java_sources'
    return decision(current, expected, installed['entries'], candidate_entries), 'uncompressed_jar_entries'


def jar_entries(body):
    """Ignore ZIP timestamps/compression, but include every executable/resource byte."""
    with zipfile.ZipFile(io.BytesIO(body)) as jar:
        names = [item.filename for item in jar.infolist() if not item.is_dir()]
        if len(names) != len(set(names)) or jar.testzip() is not None:
            raise DeploymentError('Invalid or duplicate JAR entries')
        return {name: hashlib.sha256(jar.read(name)).hexdigest() for name in sorted(names)}


def decision(current_version, expected_version, installed_entries, candidate_entries):
    if installed_entries == candidate_entries:
        if current_version != expected_version:
            raise DeploymentError('Running version and installed JAR disagree; inspect the service')
        return 'skip'
    if current_version == expected_version:
        raise DeploymentError('Changed server code requires a new server version; same-version replacement refused')
    parse = lambda value: tuple(map(int, re.fullmatch(r'(\d+)\.(\d+)\.(\d+)-world-experimental', value).groups()))
    try:
        if parse(expected_version) <= parse(current_version):
            raise DeploymentError('Server version must increase for changed code')
    except AttributeError:
        raise DeploymentError('Unrecognized installed server version') from None
    return 'deploy'


def settings():
    import paramiko
    known = os.environ.get('GTA_SSH_KNOWN_HOSTS', '')
    host_keys = paramiko.HostKeys()
    for line in known.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        entry = paramiko.hostkeys.HostKeyEntry.from_line(line)
        if entry is None:
            raise DeploymentError('GTA_SSH_KNOWN_HOSTS contains an invalid entry')
        for hostname in entry.hostnames:
            host_keys.add(hostname, entry.key.get_name(), entry.key)
    regions = {}
    for region in ('us', 'cn'):
        prefix = f'GTA_{region.upper()}_SSH_'
        values = {name: os.environ.get(prefix + name, '') for name in ('HOST', 'PORT', 'USER', 'PASSWORD')}
        if not all(values.values()):
            raise DeploymentError(f'Missing required {region.upper()} SSH secrets')
        if not re.fullmatch(r'[A-Za-z0-9.-]+', values['HOST']) or not re.fullmatch(r'[A-Za-z0-9_-]+', values['USER']):
            raise DeploymentError('Invalid SSH host/user configuration')
        if not values['PORT'].isdecimal() or not 1 <= int(values['PORT']) <= 65535:
            raise DeploymentError('Invalid SSH port configuration')
        identity = values['HOST'] if int(values['PORT']) == 22 else f"[{values['HOST']}]:{values['PORT']}"
        if host_keys.lookup(identity) is None:
            raise DeploymentError(f'Missing trusted SSH host key for {region.upper()}')
        domain = os.environ.get(f'GTA_{region.upper()}_PUBLIC_DOMAIN', '') or f'gtaserver-{region}.2t.hk'
        if not re.fullmatch(r'[A-Za-z0-9.-]+', domain):
            raise DeploymentError('Invalid public domain configuration')
        regions[region] = {**values, 'domain': domain}
    base = os.environ.get('GTA_SERVER_BASE', '') or '/opt/gta5data-server'
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', base) or '..' in Path(base).parts or base.endswith('/'):
        raise DeploymentError('Invalid server installation root')
    return regions, host_keys, base


def ssh_error_category(error, paramiko):
    """Return fixed diagnostic categories without exposing exception contents."""
    if isinstance(error, paramiko.BadHostKeyException):
        return 'host_key_mismatch'
    if isinstance(error, paramiko.AuthenticationException):
        return 'authentication_failed'
    if isinstance(error, paramiko.ssh_exception.NoValidConnectionsError):
        return 'connection_unavailable'
    if isinstance(error, (socket.timeout, TimeoutError)):
        return 'connection_or_auth_timeout'
    if isinstance(error, paramiko.ssh_exception.IncompatiblePeer):
        return 'algorithm_negotiation_failed'
    if isinstance(error, paramiko.SSHException):
        return 'ssh_protocol_error'
    if isinstance(error, OSError):
        return 'network_io_error'
    return 'unexpected_ssh_error'


def connect(config, host_keys, region=None):
    import paramiko
    client = paramiko.SSHClient()
    client._host_keys = host_keys
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(config['HOST'], port=int(config['PORT']), username=config['USER'],
                       password=config['PASSWORD'], look_for_keys=False, allow_agent=False,
                       timeout=15, auth_timeout=15, banner_timeout=15,
                       disabled_algorithms={'kex': ['curve25519-sha256', 'curve25519-sha256@libssh.org']})
    except Exception as error:
        client.close()
        category = ssh_error_category(error, paramiko)
        label = region.upper() if region in ('us', 'cn') else 'unspecified'
        raise DeploymentError(f'{label} SSH failed: {category}') from None
    return client


def check_ssh():
    """Authenticate both pinned hosts and close; no remote commands or writes."""
    try:
        regions, host_keys, _ = settings()
    except Exception:
        print(json.dumps({'region': 'all', 'status': 'failed', 'error': 'ssh_configuration_invalid'}), flush=True)
        return 1
    failed = False
    for region in ('us', 'cn'):
        client = None
        try:
            client = connect(regions[region], host_keys, region)
            row = {'region': region, 'status': 'connected'}
        except DeploymentError as error:
            failed = True
            row = {'region': region, 'status': 'failed', 'error': str(error)}
        except Exception:
            failed = True
            row = {'region': region, 'status': 'failed', 'error': 'unexpected_ssh_error'}
        finally:
            if client is not None:
                client.close()
        print(json.dumps(row), flush=True)
    return 1 if failed else 0


def remote(client, code, *args, timeout=60):
    command = 'python3 - ' + ' '.join(shlex.quote(str(arg)) for arg in args) + " <<'PY'\n" + code + '\nPY'
    try:
        _, stdout, stderr = client.exec_command(command, timeout=timeout)
        output = stdout.read()
        # Never return remote stderr or configuration/environment contents to logs.
        stderr.read()
        if stdout.channel.recv_exit_status():
            raise DeploymentError('Remote deployment operation failed')
        return json.loads(output)
    except DeploymentError:
        raise
    except Exception:
        raise DeploymentError('Remote operation/response failed') from None


INSPECT = r'''
import hashlib,json,pathlib,re,shlex,subprocess,sys,urllib.request,zipfile
unit,base,port=sys.argv[1:4]
base=pathlib.Path(base)
def ordinary(p):
 p=pathlib.Path(p)
 assert p.is_absolute() and not any(x.is_symlink() for x in [p,*p.parents])
 return p
def digest(p):
 h=hashlib.sha256()
 with pathlib.Path(p).open('rb') as f:
  for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
 return h.hexdigest()
def prop(name):return subprocess.check_output(['systemctl','show',unit,'--value','--property='+name],text=True).strip()
assert prop('LoadState')=='loaded' and prop('ActiveState')=='active'
raw=prop('ExecStart'); match=re.search(r'argv\[\]=(.*?)(?: ; [a-z_]+=|$)',raw)
assert match, 'Cannot parse existing ExecStart'
args=shlex.split(match.group(1));jar=ordinary(args[args.index('-jar')+1])
assert jar.is_relative_to(ordinary(base)) and jar.is_file()
assert jar==base/('experimental/multiplayer-server.jar' if unit=='gta5data-world-experimental.service' else 'multiplayer-server.jar')
assert args[args.index('--port')+1]==port and args[args.index('--host')+1]=='127.0.0.1'
working=pathlib.Path(prop('WorkingDirectory') or jar.parent)
world=args[args.index('--world-data')+1] if '--world-data' in args else str(jar.parent/'world-data')
worldroot=None if world=='none' else pathlib.Path(world)
if worldroot is not None and not worldroot.is_absolute():worldroot=working/worldroot
worldhashes={}
if worldroot is not None:
 assert worldroot.is_dir()
 for p in sorted(worldroot.rglob('*')):
  if p.is_file():worldhashes[str(p.relative_to(worldroot))]=digest(p)
files=set()
fragment=prop('FragmentPath');assert fragment
files.add(fragment);files.update(prop('DropInPaths').split())
files.update(re.findall(r'(?:^|\s)(/[^\s;()]+)',prop('EnvironmentFiles')))
config={str(p):digest(p) for p in sorted(files)}
with zipfile.ZipFile(jar) as z:
 names=[i.filename for i in z.infolist() if not i.is_dir()]
 assert len(names)==len(set(names)) and z.testzip() is None
 entries={n:hashlib.sha256(z.read(n)).hexdigest() for n in sorted(names)}
with urllib.request.urlopen('http://127.0.0.1:'+port+'/health',timeout=8) as response:health=json.load(response)
print(json.dumps({'jar':str(jar),'jar_sha256':digest(jar),'entries':entries,'configuration':config,'world_root':str(worldroot) if worldroot else None,'world_data':worldhashes,'health':{k:health[k] for k in ('server_version','players','clients')}}))
'''

HEALTH = r'''
import json,pathlib,sys,urllib.request
with urllib.request.urlopen('http://127.0.0.1:'+sys.argv[1]+'/health',timeout=8) as response:value=json.load(response)
result={k:value[k] for k in ('server_version','players','clients')}
port=int(sys.argv[1]);pending=0
for name in ('tcp','tcp6'):
 for row in pathlib.Path('/proc/net/'+name).read_text().splitlines()[1:]:
  fields=row.split()
  if int(fields[1].rsplit(':',1)[1],16)==port and fields[3] in ('01','02','03'):pending+=1
result['pending_connections']=pending
print(json.dumps(result))
'''

CONNECTIONS = r'''
import json,pathlib,sys
port=int(sys.argv[1]);pending=0
for name in ('tcp','tcp6'):
 for row in pathlib.Path('/proc/net/'+name).read_text().splitlines()[1:]:
  fields=row.split()
  if int(fields[1].rsplit(':',1)[1],16)==port and fields[3] in ('01','02','03'):pending+=1
print(json.dumps({'pending_connections':pending}))
'''

GATE = r'''
import json,os,pathlib,re,shutil,subprocess,sys
operation,port,token=sys.argv[1:4]
assert os.geteuid()==0 and port in ('17485','17486') and re.fullmatch(r'[A-Za-z0-9-]+',token)
iptables=shutil.which('iptables');runner=shutil.which('systemd-run');assert iptables and runner
unit='gtav-ci-gate-'+token+'-'+port
rule=['OUTPUT','-p','tcp','-d','127.0.0.1','--dport',port,'-m','conntrack','--ctstate','NEW','-m','owner','!','--uid-owner','0','-m','comment','--comment',unit,'-j','REJECT','--reject-with','tcp-reset']
def call(args,check=True):return subprocess.run(args,check=check,capture_output=True,timeout=15)
def exists():return call([iptables,'-w','5','-C',*rule],False).returncode==0
if operation in ('preflight','on'):
 workers=[]
 for row in subprocess.check_output(['ps','-eo','uid,args'],text=True).splitlines():
  if 'nginx: worker process' in row:workers.append(int(row.split(None,1)[0]))
 assert workers and all(uid!=0 for uid in workers), 'Nginx workers must not run as root'
 call([iptables,'-w','5','-S','OUTPUT'])
if operation=='on':
 assert not exists()
 # Transient watchdog also removes the gate if the runner disappears.
 call([runner,'--quiet','--unit='+unit,'--on-active=25m',iptables,'-w','5','-D',*rule])
 try:call([iptables,'-w','5','-I','OUTPUT','1',*rule[1:]])
 except Exception:
  call(['systemctl','stop',unit+'.timer'],False)
  raise
elif operation=='off':
 if exists():call([iptables,'-w','5','-D',*rule])
 call(['systemctl','stop',unit+'.timer'],False)
 assert not exists()
elif operation=='check':assert exists(), 'Deployment admission gate disappeared'
else:assert operation=='preflight'
print(json.dumps({'gate':unit,'operation':operation,'active':exists() if operation!='preflight' else False}))
'''

ACTIVATE = r'''
import json,pathlib,shutil,subprocess,sys,urllib.request
unit,port,gate=sys.argv[1:4]
iptables=shutil.which('iptables');assert iptables
assert unit in ('gta5data-server.service','gta5data-world-experimental.service') and port in ('17485','17486')
rule=['OUTPUT','-p','tcp','-d','127.0.0.1','--dport',port,'-m','conntrack','--ctstate','NEW','-m','owner','!','--uid-owner','0','-m','comment','--comment',gate,'-j','REJECT','--reject-with','tcp-reset']
subprocess.run([iptables,'-w','5','-C',*rule],check=True,capture_output=True,timeout=15)
with urllib.request.urlopen('http://127.0.0.1:'+port+'/health',timeout=8) as response:value=json.load(response)
assert value['players']==value['clients']==0
for name in ('tcp','tcp6'):
 for row in pathlib.Path('/proc/net/'+name).read_text().splitlines()[1:]:
  fields=row.split()
  assert not (int(fields[1].rsplit(':',1)[1],16)==int(port) and fields[3] in ('01','02','03')), 'Pending connection'
subprocess.run(['systemctl','restart',unit],check=True,timeout=45)
print(json.dumps({'active':subprocess.check_output(['systemctl','is-active',unit],text=True).strip()=='active'}))
'''

BACKUP = r'''
import hashlib,json,os,pathlib,shutil,subprocess,sys,tarfile
target,base,unit,stamp,expected=sys.argv[1:6]
target=pathlib.Path(target);base=pathlib.Path(base)
folder=base/'backups'/('ci-'+stamp+'-'+unit.removesuffix('.service'))
assert not any(p.is_symlink() for p in [folder,*folder.parents])
folder.mkdir(mode=0o700,parents=True,exist_ok=False)
assert hashlib.sha256(target.read_bytes()).hexdigest()==expected
previous=folder/'previous.jar'
with previous.open('xb') as f:f.write(target.read_bytes());f.flush();os.fsync(f.fileno())
os.chmod(previous,0o600)
props=lambda name:subprocess.check_output(['systemctl','show',unit,'--value','--property='+name],text=True).strip()
import re
files={props('FragmentPath'),*props('DropInPaths').split(),*re.findall(r'(?:^|\s)(/[^\s;()]+)',props('EnvironmentFiles'))}
with tarfile.open(folder/'configuration.tar.gz','x:gz') as archive:
 for name in sorted(files):archive.add(name,arcname=name.lstrip('/'),recursive=False)
os.chmod(folder/'configuration.tar.gz',0o600)
with (folder/'unit.txt').open('xb') as f:f.write(subprocess.check_output(['systemctl','cat',unit]));f.flush();os.fsync(f.fileno())
os.chmod(folder/'unit.txt',0o600)
stage=folder/'candidate.jar'
assert not stage.exists()
print(json.dumps({'backup':str(folder),'previous':str(previous),'stage':str(stage)}))
'''

REPLACE = r'''
import hashlib,json,os,pathlib,sys,tempfile
source,target,expected,old=sys.argv[1:5]
source=pathlib.Path(source);target=pathlib.Path(target)
assert not any(p.is_symlink() for p in [source,target,*source.parents,*target.parents])
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert source.is_file() and target.is_file() and digest(source)==expected and digest(target)==old
mode=target.stat();descriptor,name=tempfile.mkstemp(prefix='.ci-jar-',suffix='.tmp',dir=target.parent)
temporary=pathlib.Path(name)
try:
 with os.fdopen(descriptor,'wb') as f:f.write(source.read_bytes());f.flush();os.fsync(f.fileno())
 os.chmod(temporary,mode.st_mode & 0o777);os.chown(temporary,mode.st_uid,mode.st_gid)
 assert digest(temporary)==expected
 os.replace(temporary,target)
 directory=os.open(target.parent,os.O_DIRECTORY)
 try:os.fsync(directory)
 finally:os.close(directory)
finally:temporary.unlink(missing_ok=True)
print(json.dumps({'sha256':digest(target)}))
'''

RESTART = r'''
import json,subprocess,sys
subprocess.run(['systemctl','restart',sys.argv[1]],check=True,timeout=45)
print(json.dumps({'active':subprocess.check_output(['systemctl','is-active',sys.argv[1]],text=True).strip()=='active'}))
'''


def invariants(value):
    return {key: value[key] for key in ('jar', 'configuration', 'world_root', 'world_data')}


def idle(health):
    return health['players'] == 0 and health['clients'] == 0 and health.get('pending_connections', 0) == 0


def wait_idle(client, port, timeout):
    deadline = time.monotonic() + timeout
    while True:
        value = remote(client, HEALTH, port, timeout=15)
        if idle(value):
            return value
        if time.monotonic() >= deadline:
            raise DeploymentError('Online players/connections still present; service was not interrupted')
        time.sleep(min(5, max(0, deadline - time.monotonic())))


def wait_health(client, port, version):
    for _ in range(20):
        try:
            value = remote(client, HEALTH, port, timeout=15)
            if value['server_version'] == version:
                return value
        except DeploymentError:
            pass
        time.sleep(1)
    raise DeploymentError('Restarted service did not become healthy at the expected version')


def wait_closed(client, port, timeout):
    """Rollback also works when health is unavailable, without dropping sockets."""
    deadline = time.monotonic() + timeout
    while remote(client, CONNECTIONS, port)['pending_connections']:
        if time.monotonic() >= deadline:
            raise DeploymentError('Rollback waits for existing connections; service was not interrupted')
        time.sleep(min(5, max(0, deadline - time.monotonic())))


def public_check(config, port, version, full=True):
    origin = f"https://{config['domain']}:{port}/{port}"
    try:
        result = subprocess.run(['node', str(ROOT / 'tools/server_protocol_check.mjs'), origin,
                                 version, 'full' if full else 'health'], capture_output=True,
                                text=True, timeout=55)
        if result.returncode:
            raise DeploymentError('Certificate-verified public HTTPS/WSS verification failed')
        return json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError):
        raise DeploymentError('Public HTTPS/WSS verification failed') from None


def rollout(client, config, lane, candidate, expected, base, stamp, timeout, row):
    unit = 'gta5data-world-experimental.service' if lane == 'experimental' else 'gta5data-server.service'
    port = 17486 if lane == 'experimental' else 17485
    public_port = 47486 if lane == 'experimental' else 47485
    before = remote(client, INSPECT, unit, base, port)
    action, identity = deployment_decision(before, expected, jar_entries(candidate.read_bytes()))
    row.update(unit=unit, before_version=before['health']['server_version'], before_jar_sha256=before['jar_sha256'])
    row['identity_basis'] = identity
    if action == 'skip':
        row['public'] = public_check(config, public_port, expected, full=idle(before['health']))
        row['protocol_check'] = 'snapshot_and_heartbeat' if idle(before['health']) else 'health_only_service_occupied'
        row['status'] = 'same_code_verified_no_restart'
        return
    wait_idle(client, port, timeout)
    assert invariants(remote(client, INSPECT, unit, base, port)) == invariants(before), 'Pre-deployment inputs changed'
    backup = remote(client, BACKUP, before['jar'], base, unit, stamp, before['jar_sha256'])
    row['backup'] = backup['backup']
    sha = hashlib.sha256(candidate.read_bytes()).hexdigest()
    with client.open_sftp() as sftp:
        sftp.get_channel().settimeout(60)
        with sftp.open(backup['stage'], 'wx') as output:
            output.write(candidate.read_bytes())
            output.flush()
        sftp.chmod(backup['stage'], 0o600)
    changed = False
    restarted = False
    gated = False
    try:
        # Block only NEW non-root loopback connections; existing players keep playing.
        gated = True
        remote(client, GATE, 'on', port, stamp)
        row['admission_gated'] = True
        wait_idle(client, port, timeout)
        if not idle(remote(client, HEALTH, port)):
            raise DeploymentError('A player connected before activation; no restart performed')
        assert invariants(remote(client, INSPECT, unit, base, port)) == invariants(before), 'Deployment inputs changed'
        remote(client, GATE, 'check', port, stamp)
        # Mark before replacing so interrupted remote operations also enter rollback.
        changed = True
        remote(client, REPLACE, backup['stage'], before['jar'], sha, before['jar_sha256'])
        if not idle(remote(client, HEALTH, port)):
            raise DeploymentError('A player connected before restart; restoring JAR without interruption')
        remote(client, GATE, 'check', port, stamp)
        restarted = True
        gate_unit = 'gtav-ci-gate-' + stamp + '-' + str(port)
        if not remote(client, ACTIVATE, unit, port, gate_unit)['active']:
            raise DeploymentError('Service restart failed')
        wait_health(client, port, expected)
        remote(client, GATE, 'off', port, stamp)
        gated = False
        row['public'] = public_check(config, public_port, expected)
        after = remote(client, INSPECT, unit, base, port)
        if invariants(after) != invariants(before) or after['jar_sha256'] != sha:
            raise DeploymentError('Installed JAR/configuration/world-data verification failed')
        row.update(status='deployed_verified', installed_jar_sha256=sha)
    except Exception:
        row['status'] = 'failed'
        if changed:
            try:
                if restarted:
                    if not gated:
                        gated = True
                        remote(client, GATE, 'on', port, stamp)
                    remote(client, GATE, 'check', port, stamp)
                    wait_closed(client, port, timeout)
                current = remote(client, "import hashlib,json,pathlib,sys\nprint(json.dumps({'sha256':hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()}))", before['jar'])['sha256']
                if current not in (sha, before['jar_sha256']):
                    raise DeploymentError('Installed JAR changed outside the deployment')
                remote(client, REPLACE, backup['previous'], before['jar'], before['jar_sha256'], current)
                if restarted:
                    if not remote(client, RESTART, unit)['active']:
                        raise DeploymentError('Restored service restart failed')
                wait_health(client, port, before['health']['server_version'])
                if gated:
                    remote(client, GATE, 'off', port, stamp)
                    gated = False
                occupied = not idle(remote(client, HEALTH, port))
                row['rollback_public'] = public_check(config, public_port, before['health']['server_version'], full=not occupied)
                if invariants(remote(client, INSPECT, unit, base, port)) != invariants(before):
                    raise DeploymentError('Rollback invariants changed')
                row['status'] = 'rolled_back_verified'
            except Exception:
                row['status'] = 'rollback_failed_requires_operator'
        raise DeploymentError('Lane rollout failed; ' + row['status']) from None
    finally:
        if gated:
            try:
                remote(client, GATE, 'off', port, stamp)
                row['admission_gate_cleaned'] = True
            except Exception:
                row['admission_gate_cleanup_failed'] = True
                raise DeploymentError('Admission gate cleanup failed; transient watchdog will remove it') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-ssh', action='store_true', help='Only check both pinned SSH connections; no remote commands or changes')
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--assets-directory', type=Path)
    parser.add_argument('--report', type=Path, default=ROOT / 'archive/deployment/server-deployment.json')
    parser.add_argument('--idle-timeout', type=int, default=120)
    args = parser.parse_args()
    if args.check_ssh:
        return check_ssh()
    if args.plan is None or args.assets_directory is None:
        parser.error('--plan and --assets-directory are required unless --check-ssh is used')
    if not 0 <= args.idle_timeout <= 120:
        parser.error('--idle-timeout must be between 0 and 120 seconds')
    sources = (args.plan, *[p for p in args.assets_directory.glob('*') if p.is_file()])
    validate_output(args.report, sources=sources)
    audit = {'started_utc': datetime.now(timezone.utc).isoformat(), 'lanes': [], 'result': 'failed'}
    clients = {}
    try:
        plan = load_plan(args.plan)
        item = plan['components']['server']
        verify_release_directory(plan, 'server', args.assets_directory)
        candidate = args.assets_directory / f"multiplayer-server-v{item['version']}.jar"
        inspect_server_jar(candidate.read_bytes(), item['runtime_version'], execute=True)
        regions, host_keys, base = settings()  # Check every credential before any remote change.
        audit.update(source_commit=plan['commit'], server_version=item['runtime_version'],
                     candidate_sha256=hashlib.sha256(candidate.read_bytes()).hexdigest())
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + plan['commit'][:12]
        for region in ('us', 'cn'):
            clients[region] = connect(regions[region], host_keys, region)
            for lane in ('experimental', 'main'):
                unit = 'gta5data-world-experimental.service' if lane == 'experimental' else 'gta5data-server.service'
                value = remote(clients[region], INSPECT, unit, base, 17486 if lane == 'experimental' else 17485)
                action, _ = deployment_decision(value, item['runtime_version'], jar_entries(candidate.read_bytes()))
                if action == 'deploy':
                    remote(clients[region], GATE, 'preflight', 17486 if lane == 'experimental' else 17485, stamp)
        for lane in ('experimental', 'main'):
            for region in ('us', 'cn'):
                row = {'region': region, 'lane': lane, 'status': 'preflight'}
                audit['lanes'].append(row)
                rollout(clients[region], regions[region], lane, candidate, item['runtime_version'], base, stamp, args.idle_timeout, row)
                print(json.dumps({key: row[key] for key in ('region', 'lane', 'status')}), flush=True)
        audit['result'] = 'success'
    except Exception as error:
        # Only deliberate sanitized errors may enter audit/logs; no Paramiko traceback.
        if audit['lanes'] and audit['lanes'][-1]['status'] == 'preflight':
            audit['lanes'][-1]['status'] = 'preflight_failed_no_restart'
        audit['error'] = str(error) if isinstance(error, DeploymentError) else 'Local input or deployment validation failed'
        print('Server deployment failed: ' + audit['error'], file=sys.stderr)
    finally:
        for client in clients.values():
            client.close()
        atomic_write_text(args.report, json.dumps(audit, indent=2) + '\n', sources=sources)
    return 0 if audit['result'] == 'success' else 1


if __name__ == '__main__':
    raise SystemExit(main())
