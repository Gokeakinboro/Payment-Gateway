#!/usr/bin/env python3
"""Safe deploy for the Paylode gateway.

Fixes the class of incident where a mangled file (e.g. over-escaped apostrophes)
was shipped and broke the dashboard:
  1. Runs the syntax gate (tools/check-syntax.mjs) and ABORTS on any failure.
  2. Transfers in BINARY (sftp) — no shell/text escaping that can corrupt files.
  3. Backs up every remote file before overwriting (rollback path).
  4. Verifies md5(local) == md5(remote) after upload.

Credentials come from the environment (never commit them):
  PAYLODE_HOST   (default 176.57.188.45)
  PAYLODE_USER   (default root)
  PAYLODE_SSH_PASS   (required)

Usage:
  PAYLODE_SSH_PASS=... python tools/deploy.py            # deploy default manifest
  PAYLODE_SSH_PASS=... python tools/deploy.py --frontend # only static frontend
"""
import os, sys, time, hashlib, subprocess, posixpath
import paramiko

HOST = os.environ.get('PAYLODE_HOST', '176.57.188.45')
USER = os.environ.get('PAYLODE_USER', 'root')
PASS = os.environ.get('PAYLODE_SSH_PASS')

# Static frontend (live box = 45) — explicit list.
FRONTEND = [
    ('onboarding.html',                            '/var/www/paylode/onboarding.html'),
    ('app.js',                                     '/var/www/paylode/app.js'),
    ('api-wiring.js',                              '/var/www/paylode/api-wiring.js'),
    ('dashboard.html',                             '/var/www/paylode/dashboard.html'),
    ('sandbox.html',                               '/var/www/paylode/sandbox.html'),
]

# Backend (176) is derived by WALKING the tree rather than an explicit list, so a
# refactor that moves/adds files can never silently drop one (which would ship a
# server.js that require()s files that never landed — see the 2026-07-03 incident).
# Ships: every backend/src/**/*.js, the prisma schema + migrations, ecosystem.config.js.
REMOTE_BASE = '/opt/paylode-api'

def _walk(base, suffixes):
    out = []
    for root, _dirs, fnames in os.walk(base):
        if 'node_modules' in root.split(os.sep):
            continue
        for fn in fnames:
            if fn.endswith(suffixes):
                lp = os.path.join(root, fn).replace('\\', '/')
                out.append((lp, REMOTE_BASE + '/' + lp))
    return sorted(out)

def backend_manifest():
    files = _walk('backend/src', ('.js',))
    files += _walk('backend/prisma/migrations', ('.sql',))
    for single in ('backend/prisma/schema.prisma', 'backend/ecosystem.config.js'):
        if os.path.exists(single):
            files.append((single, REMOTE_BASE + '/' + single))
    return files

MANIFEST = FRONTEND + backend_manifest()

def md5_local(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(65536), b''): h.update(c)
    return h.hexdigest()

def main():
    if not PASS:
        sys.exit('PAYLODE_SSH_PASS env var is required.')

    files = [m for m in MANIFEST if os.path.exists(m[0])]
    if '--frontend' in sys.argv:
        files = [m for m in files if m[1].startswith('/var/www/')]

    # 1) SYNTAX GATE — abort the whole deploy if anything fails to parse.
    checkable = [l for l, _ in files if l.endswith(('.js', '.html'))]
    print('Running syntax gate...')
    rc = subprocess.run(['node', 'tools/check-syntax.mjs', *checkable]).returncode
    if rc != 0:
        sys.exit('Syntax gate failed — nothing deployed.')

    # 1b) GIT-CLEAN GATE — never ship code that isn't committed, so the repo is
    # always a faithful record of what's on the server. Override with --allow-dirty.
    if '--allow-dirty' not in sys.argv:
        locals_ = [l for l, _ in files]
        dirty = subprocess.run(['git', 'status', '--porcelain', '--', *locals_],
                               capture_output=True, text=True).stdout.strip()
        if dirty:
            print(dirty)
            sys.exit('Uncommitted changes in files being deployed. Commit first (or pass --allow-dirty).')

    ssh = paramiko.SSHClient(); ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASS, timeout=40)
    def run(cmd, t=240):
        _, o, e = ssh.exec_command(cmd, timeout=t)
        return o.read().decode('utf-8', 'replace'), e.read().decode('utf-8', 'replace')
    sftp = ssh.open_sftp()

    ts = time.strftime('%Y%m%d-%H%M%S'); bak = '/root/deploy-backup-' + ts
    run('mkdir -p ' + bak)
    # 2) backup + 3) binary upload. Ensure the remote directory exists (new module
    # dirs like modules/gateway-core/routes won't exist on first split deploy), and
    # mirror the path under the backup dir so same-named files can't clobber.
    for local, remote in files:
        rdir = posixpath.dirname(remote)
        bdir = bak + rdir
        run('mkdir -p "%s" "%s"' % (rdir, bdir))
        run('cp -p "%s" "%s/" 2>/dev/null' % (remote, bdir))
        sftp.put(local, remote)
        print('  uploaded', remote)
    sftp.close()

    # 4) md5 verify
    print('Verifying checksums...')
    bad = 0
    for local, remote in files:
        o, _ = run('md5sum "%s"' % remote)
        remote_md5 = o.strip().split()[0] if o.strip() else '?'
        if remote_md5 != md5_local(local):
            print('  MISMATCH', remote); bad += 1
        else:
            print('  ok', remote)
    if bad:
        sys.exit('%d checksum mismatch(es) — investigate (backup at %s).' % (bad, bak))

    print('\nBackup: %s' % bak)
    print('All files deployed + verified. Run prisma generate / pm2 restart if backend changed.')
    ssh.close()

if __name__ == '__main__':
    main()
