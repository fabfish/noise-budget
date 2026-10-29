#!/bin/bash
set -u
export PATH=/root/.local/bin:$PATH
TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ready=0
for _ in $(seq 1 90); do
  if cd /root/work/noise-budget && uv run --no-sync utils/prepare_data.py --verify >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 20
done
if [ "$ready" != 1 ]; then
  echo SETUP_NOT_READY
  exit 1
fi
echo DATA_VERIFIED_STARTING_PROBE
bash "$TOOLS/remote_identity_probe_mig.sh"
