#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Paylode server ACCESS TRACKER + attributable automation identity.
#  Run as root on a server:  sudo bash setup-access-tracker.sh
#
#  What it does (idempotent — safe to re-run):
#   1. Creates a dedicated `claude` sudo user so AUTOMATED (Claude) actions are
#      logged distinctly from human `root` logins. Reuses the existing authorized
#      SSH key (copied from root) — no new key to distribute. NOPASSWD sudo keeps
#      non-interactive deploys working; auditd still records every sudo command.
#   2. Installs + configures auditd (kernel-level): logs every login, every command
#      (execve) from a real login session, privilege escalation, and changes to
#      sudoers / sshd_config / authorized_keys.
#
#  After running, query with:
#     ausearch -k cmd  --start today | aureport -x --summary   # commands by exe
#     ausearch -m USER_LOGIN --start today                     # who logged in
#     aureport --auth --summary                                # auth summary
#  Actions by the automation user:  ausearch -k cmd --uid claude --start today
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }

AUTOMATION_USER="${AUTOMATION_USER:-claude}"

echo "== 1. Dedicated sudo user: ${AUTOMATION_USER} =="
if ! id "${AUTOMATION_USER}" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "${AUTOMATION_USER}"
  echo "   created ${AUTOMATION_USER}"
else
  echo "   ${AUTOMATION_USER} already exists"
fi
# sudo group name differs by distro (Debian/Ubuntu=sudo, RHEL=wheel)
getent group sudo  >/dev/null 2>&1 && usermod -aG sudo  "${AUTOMATION_USER}" || true
getent group wheel >/dev/null 2>&1 && usermod -aG wheel "${AUTOMATION_USER}" || true

# Authorize the SAME key(s) that already authenticate root.
install -d -m 700 -o "${AUTOMATION_USER}" -g "${AUTOMATION_USER}" "/home/${AUTOMATION_USER}/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "/home/${AUTOMATION_USER}/.ssh/authorized_keys"
  chown "${AUTOMATION_USER}:${AUTOMATION_USER}" "/home/${AUTOMATION_USER}/.ssh/authorized_keys"
  chmod 600 "/home/${AUTOMATION_USER}/.ssh/authorized_keys"
  echo "   authorized_keys copied from root ($(wc -l < /home/${AUTOMATION_USER}/.ssh/authorized_keys) key(s))"
else
  echo "   WARNING: /root/.ssh/authorized_keys not found — add ${AUTOMATION_USER}'s key manually"
fi

# NOPASSWD sudo (validated before install so a typo can't break sudo).
TMP_SUDO="$(mktemp)"
echo "${AUTOMATION_USER} ALL=(ALL) NOPASSWD:ALL" > "${TMP_SUDO}"
if visudo -cf "${TMP_SUDO}"; then
  install -m 440 "${TMP_SUDO}" "/etc/sudoers.d/${AUTOMATION_USER}"
  echo "   NOPASSWD sudo granted"
else
  echo "   ERROR: sudoers syntax check failed — NOT installed"; rm -f "${TMP_SUDO}"; exit 1
fi
rm -f "${TMP_SUDO}"

echo "== 2. auditd (kernel-level access + command audit) =="
if ! command -v auditctl >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  # --allow-releaseinfo-change: some boxes have a 3rd-party PPA (e.g. ondrej/php)
  # that changed its Label, which otherwise blocks apt-get update.
  apt-get update -qq || apt-get update --allow-releaseinfo-change -qq || true
  apt-get install -y auditd audispd-plugins
else
  echo "   auditd already installed"
fi

# Additive rules file (does NOT wipe existing rules). auid!=unset limits to real
# login sessions (root + claude) and drops daemon noise. execve = every command.
cat > /etc/audit/rules.d/paylode-access.rules <<'RULES'
## Paylode access tracker — logins, commands, privilege + auth changes.
-b 8192
## Every command run in a real login session (64- and 32-bit)
-a always,exit -F arch=b64 -S execve -F auid!=-1 -k cmd
-a always,exit -F arch=b32 -S execve -F auid!=-1 -k cmd
## Privilege escalation
-w /usr/bin/sudo -p x -k priv
-w /bin/su       -p x -k priv
## Access-control / key changes
-w /etc/sudoers      -p wa -k authchange
-w /etc/sudoers.d/   -p wa -k authchange
-w /etc/ssh/sshd_config -p wa -k sshd
-w /root/.ssh/       -p wa -k sshkeys
RULES
# Add per-automation-user key-file watch dynamically (path depends on the user).
echo "-w /home/${AUTOMATION_USER}/.ssh/ -p wa -k sshkeys" >> /etc/audit/rules.d/paylode-access.rules

augenrules --load
systemctl enable auditd >/dev/null 2>&1 || true
systemctl restart auditd || service auditd restart || true

echo "== DONE =="
echo "   rules loaded: $(auditctl -l | wc -l)   status: $(systemctl is-active auditd 2>/dev/null || echo unknown)"
echo "   Human logs in as root; automation logs in as ${AUTOMATION_USER}."
echo "   Try:  ausearch -k cmd --start recent | aureport -x --summary"
