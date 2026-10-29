#!/bin/bash
set -euo pipefail
export PATH=/root/.local/bin:$PATH
export PYTHONUNBUFFERED=1
export NCCL_DEBUG=WARN
export TORCH_NCCL_ASYNC_ERROR_HANDLING=1
export RANK=0 WORLD_SIZE=1 LOCAL_RANK=0 MASTER_ADDR=127.0.0.1 MASTER_PORT=29617
cd /root/work/noise-budget
mkdir -p logs/ranks
nvidia-smi -L > logs/ranks/hardware-serial-mig.txt
printf '{"physical_gpus":1,"logical_ranks":1,"serial_heads":8,"record_eligible":false,"commit":"%s"}\n' "$(git rev-parse HEAD)" > logs/ranks/probe_metadata-serial-mig.json
timeout 1800 uv run --no-sync python train/speedrun/run.py \
  --identity-only --identity-updates "${NOISE_UPDATES:-1831}" --output "${NOISE_OUTPUT:-logs/identity-probe-mig-serial}"
