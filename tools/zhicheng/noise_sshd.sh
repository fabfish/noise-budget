#!/bin/bash
set -euo pipefail
mkdir -p /root/.ssh /run/sshd
printf '%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFvLA6lYdw6wy8pcr573vjE+vvLTWfJl/q9i2j8YXrtr zhiyuan@fish' > /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
if ! command -v sshd >/dev/null 2>&1; then
  sed -i 's|http://archive.ubuntu.com|https://mirrors.cloud.tencent.com|g; s|http://security.ubuntu.com|https://mirrors.cloud.tencent.com|g' /etc/apt/sources.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server curl git ca-certificates
fi
ssh-keygen -A
if ! pgrep -x sshd >/dev/null 2>&1; then
  /usr/sbin/sshd
fi
