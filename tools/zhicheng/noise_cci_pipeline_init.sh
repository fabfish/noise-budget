#!/bin/bash
set -u
mkdir -p /root/work
cd /root/work
tar -xzf noise_scripts.tgz
bash noise_sshd.sh
bash remote_setup.sh
status=$?
if [ "$status" -eq 0 ]; then
  bash remote_pipeline.sh
  status=$?
fi
echo NOISE_PIPELINE_EXIT=$status
if [ -d /root/work/noise-budget/logs/ranks ]; then
  for log in /root/work/noise-budget/logs/ranks/identity-*.log; do
    echo "===== $log ====="
    tail -n 80 "$log"
  done
fi
sleep infinity
