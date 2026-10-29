#!/bin/bash
set -euo pipefail
export PATH=/root/.local/bin:$PATH
export HF_HUB_DISABLE_XET=1
TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p /root/work
cd /root/work
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
if [ ! -d noise-budget/.git ]; then
  git clone --branch budget-speedrun --single-branch https://github.com/fabfish/noise-budget.git
elif [ "${NOISE_UPDATE:-0}" = 1 ]; then
  git -C noise-budget fetch origin budget-speedrun
  git -C noise-budget checkout budget-speedrun
  git -C noise-budget pull --ff-only origin budget-speedrun
fi
cd noise-budget
if [ -f "$TOOLS/use_mirror.py" ]; then
  python3 "$TOOLS/use_mirror.py"
fi
uv sync --frozen
uv run --no-sync python -c "import torch; print({'torch': torch.__version__, 'cuda': torch.cuda.is_available(), 'gpus': torch.cuda.device_count()})"
if [ -f data/train.pt ] && [ -f data/val.pt ]; then
  uv run --no-sync utils/prepare_data.py --verify
else
  uv run --no-sync utils/prepare_data.py
fi
