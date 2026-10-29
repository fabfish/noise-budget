#!/bin/bash
set -euo pipefail
export PATH=/root/.local/bin:$PATH
export PYTHONUNBUFFERED=1
export NCCL_DEBUG=WARN
export TORCH_NCCL_ASYNC_ERROR_HANDLING=1
cd /root/work/noise-budget
mkdir -p logs/ranks
nvidia-smi -L > logs/ranks/hardware.txt
printf '{"physical_gpus":2,"logical_ranks":8,"record_eligible":false,"commit":"%s"}\n' "$(git rev-parse HEAD)" > logs/ranks/probe_metadata.json
pids=()
for rank in 0 1 2 3 4 5 6 7; do
  gpu=$((rank % 2))
  RANK=$rank LOCAL_RANK=$gpu WORLD_SIZE=8 MASTER_ADDR=127.0.0.1 MASTER_PORT=29617 \
    timeout 1800 uv run python train/speedrun/run.py \
    --identity-only --identity-updates 1831 --output logs/identity-probe-2h100 \
    > logs/ranks/identity-$rank.log 2>&1 &
  pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    status=1
  fi
done
if [ -f logs/identity-probe-2h100/result.json ]; then
  cat logs/identity-probe-2h100/result.json
fi
exit "$status"
