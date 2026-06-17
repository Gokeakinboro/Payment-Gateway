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

# local -> remote.  Keep this list in sync with what actually ships.
MANIFEST = [
    ('onboarding.html',                            '/var/www/paylode/onboarding.html'),
    ('app.js',                                     '/var/www/paylode/app.js'),
    ('api-wiring.js',                              '/var/www/paylode/api-wiring.js'),
    ('dashboard.html',                             '/var/www/paylode/dashboard.html'),
    ('sandbox.html',                               '/var/www/paylode/sandbox.html'),
    ('backend/src/routes/onboarding.js',           '/opt/paylode-api/backend/src/routes/onboarding.js'),
    ('backend/src/routes/deferrals.js',            '/opt/paylode-api/backend/src/routes/deferrals.js'),
    ('backend/src/routes/documents.js',            '/opt/paylode-api/backend/src/routes/documents.js'),
    ('backend/src/routes/users.js',                '/opt/paylode-api/backend/src/routes/users.js'),
    ('backend/src/routes/aggregators.js',          '/opt/paylode-api/backend/src/routes/aggregators.js'),
    ('backend/src/routes/merchants.js',            '/opt/paylode-api/backend/src/routes/merchants.js'),
    ('backend/src/routes/payouts.js',              '/opt/paylode-api/backend/src/routes/payouts.js'),
    ('backend/src/data/nibssBanks.js',             '/opt/paylode-api/backend/src/data/nibssBanks.js'),
    ('backend/src/routes/support.js',              '/opt/paylode-api/backend/src/routes/support.js'),
    ('backend/src/routes/auth.js',                 '/opt/paylode-api/backend/src/routes/auth.js'),
    ('backend/src/routes/admin.js',                '/opt/paylode-api/backend/src/routes/admin.js'),
    ('backend/src/routes/reports.js',              '/opt/paylode-api/backend/src/routes/reports.js'),
    ('backend/src/routes/transactions.js',         '/opt/paylode-api/backend/src/routes/transactions.js'),
    ('backend/src/routes/settlements.js',          '/opt/paylode-api/backend/src/routes/settlements.js'),
    ('backend/src/routes/kyc.js',                  '/opt/paylode-api/backend/src/routes/kyc.js'),
    ('backend/src/config/permissions.js',          '/opt/paylode-api/backend/src/config/permissions.js'),
    ('backend/src/middleware/auth.js',             '/opt/paylode-api/backend/src/middleware/auth.js'),
    ('backend/src/services/deferralExpiryService.js', '/opt/paylode-api/backend/src/services/deferralExpiryService.js'),
    ('backend/src/services/emailService.js',       '/opt/paylode-api/backend/src/services/emailService.js'),
    ('backend/src/services/feeEngine.js',          '/opt/paylode-api/backend/src/services/feeEngine.js'),
    ('backend/src/services/railHealth.js',         '/opt/paylode-api/backend/src/services/railHealth.js'),
    ('backend/src/routes/checkout.js',             '/opt/paylode-api/backend/src/routes/checkout.js'),
    ('backend/src/routes/compliance.js',           '/opt/paylode-api/backend/src/routes/compliance.js'),
    ('backend/src/config/complianceRules.js',      '/opt/paylode-api/backend/src/config/complianceRules.js'),
    ('backend/src/data/sanctionsList.js',          '/opt/paylode-api/backend/src/data/sanctionsList.js'),
    ('backend/src/services/complianceService.js',  '/opt/paylode-api/backend/src/services/complianceService.js'),
    ('backend/src/services/palmpayService.js',     '/opt/paylode-api/backend/src/services/palmpayService.js'),
    ('backend/src/services/railFloat.js',          '/opt/paylode-api/backend/src/services/railFloat.js'),
    ('backend/src/routes/palmpay-webhook.js',      '/opt/paylode-api/backend/src/routes/palmpay-webhook.js'),
    ('backend/src/server.js',                      '/opt/paylode-api/backend/src/server.js'),
    ('backend/prisma/schema.prisma',               '/opt/paylode-api/backend/prisma/schema.prisma'),
]

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
    # 2) backup + 3) binary upload
    for local, remote in files:
        run('cp -p "%s" "%s/" 2>/dev/null' % (remote, bak))
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
