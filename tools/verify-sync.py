#!/usr/bin/env python3
"""Detect drift between the git repo and the live server.

Nothing syncs server->repo automatically, so a direct edit on the box would make
the repo lie about what's running. Run this any time (and after every deploy) to
prove they match. Exits non-zero if anything differs.

  PAYLODE_SSH_PASS=... python tools/verify-sync.py

The file list is imported from tools/deploy.py's MANIFEST, so the two never drift
apart themselves.
"""
import os, sys, hashlib, importlib.util
import paramiko

HOST = os.environ.get('PAYLODE_HOST', '176.57.188.45')
USER = os.environ.get('PAYLODE_USER', 'root')
PASS = os.environ.get('PAYLODE_SSH_PASS')

# Reuse deploy.py's MANIFEST as the single source of truth for tracked files.
spec = importlib.util.spec_from_file_location('paylode_deploy', os.path.join(os.path.dirname(__file__), 'deploy.py'))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
MANIFEST = mod.MANIFEST

def md5_bytes(b):
    # Normalize CRLF->LF so Windows working-tree (CRLF) vs server/repo (LF) never
    # false-alarms; only real content differences count as drift.
    h = hashlib.md5(); h.update(b.replace(b'\r\n', b'\n')); return h.hexdigest()

def main():
    if not PASS:
        sys.exit('PAYLODE_SSH_PASS env var is required.')
    ssh = paramiko.SSHClient(); ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASS, timeout=40)
    sftp = ssh.open_sftp()

    drift = []
    for local, remote in MANIFEST:
        if not os.path.exists(local):
            continue
        with open(local, 'rb') as f:
            local_md5 = md5_bytes(f.read())
        try:
            with sftp.open(remote, 'rb') as rf:
                remote_md5 = md5_bytes(rf.read())
        except IOError:
            print('  MISSING on server:', remote); drift.append(remote); continue
        if local_md5 == remote_md5:
            print('  in-sync  ', remote)
        else:
            print('  DRIFT    ', remote, '(server differs from repo)'); drift.append(remote)

    sftp.close(); ssh.close()
    if drift:
        print('\n[FAIL] %d file(s) drifted - server and repo are NOT in sync.' % len(drift))
        print('  Pull the server copy into the repo (or redeploy) before trusting git.')
        sys.exit(1)
    print('\n[OK] Repo and server are in sync.')

if __name__ == '__main__':
    main()
