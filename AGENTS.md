# Noise-Budget 操作与保密指南

本文件是本仓库执行工作的入口。目标是在 Q Labs Noise Track 2 上，以合规的 forward-only 方法缩短达到验证损失 3.5 的训练时间。公开内容可以讨论 forward-only credit assignment、估计器/优化器协同设计和成本记账，但不得加入其他项目的未投稿方法、实验结果、论文计划或内部实现。

## 1. 当前资源与成绩口径

- GitHub：`fabfish/noise-budget`；工作分支：`budget-speedrun`。
- 上游：`qlabs-eng/noise`。提交前重新读取上游 leaderboard；只有真实成绩超过当时纪录才发 PR。
- 官方 Track 2 的正式环境是**单节点 8×H100**。其他硬件只用于功能验证，不能据此声称破纪录。
- 当前 CCI 应用：`Noise-Budget` / `noise-budget`。
- 应用 UID：`d23f37025c03458c96c481c6f268b71d`。
- 集群：`computing_cluster_01g_02` / `computing-cluster-01g-02`。
- 当前规格：`N6lS.Iu.I10.2`，2×H100 80GB、44 vCPU、460GiB。
- 镜像：`lepton-trainingjob/nvidia24.04-ubuntu22.04-py3.10-cuda12.4-cudnn9.1-torch2.3.0-transformerengine1.5`，tag `v1.0.0-20241130-nvdia-base-image`。
- 当前 2 卡实验使用 8 个逻辑 rank，仅验证损失、数据记账和代码正确性。共享卡上的墙钟时间不是比赛结果。
- 不停止、删除或修改其他应用，不恢复旧实验队列。看到其他 GPU/CPU 进程时先辨认，不要按“占用资源”直接清理。

## 2. 仓库布局

- `train/speedrun/run.py`：Noise 训练与诊断入口，默认上游基线保持不变。
- `tools/zhicheng/dnat_read.js`：读取 EIP 全量 DNAT 规则，过滤条件由脚本移除。
- `tools/zhicheng/dnat_add.js`：通过控制台表单添加规则；先 `dry` 后 `save`。
- `tools/zhicheng/dnat_rebind.js`：已有规则解绑、精确重绑并校验目标 UID。
- `tools/zhicheng/noise_sshd.sh`：安装并启动 sshd，配置授权公钥；不包含私钥。
- `.tools/`：本地临时脚本、浏览器依赖和截图，已忽略，不得推送。
- `.kimi-code/`：工具产生的本地截图和状态，已忽略。
- `data/`、`logs/`：固定数据与运行输出，已忽略。正式提交所需日志按上游要求显式加入对应 `train/*/log/`。

## 3. 浏览器与控制台

使用真实 Chrome 的克隆会话，不重启用户主浏览器。推荐独立调试端口 9223，避免复用失效的旧会话。

```bash
NODE="C:/Users/Zhiyuan/.workbuddy/binaries/node/versions/22.22.2/node.exe"
CDP="C:/Users/Zhiyuan/.kimi-code/skills/chrome-cdp/scripts/chrome.js"
npm install --prefix .tools/browser --no-audit --no-fund playwright-core
export PLAYWRIGHT_CORE_PATH="D:/GitHub/noise-budget/.tools/browser/node_modules/playwright-core"

"$NODE" "$CDP" ensure --port 9223 --profile clone
"$NODE" "$CDP" open --port 9223 "https://console.sensecore.cn/cn-sh-01/cci/app"
```

如果登录过期，按本地安全流程在登录表单中输入企业标识、用户名和密码。密码只通过表单的安全文件输入传递，不打印、不写入命令、不提交。使用密码文件的环境变量为 `PW_FILE`；工具默认路径是 `D:/WorkBuddy/zhicheng/pw.txt`，该文件不是仓库资产。

完成操作后关闭克隆实例：

```bash
"$NODE" "$CDP" stop --port 9223
```

## 4. DNAT：10182 与 11182

当前 EIP 池：`202610201_202610300_01g_用于dnat创建`，EIP 为 `118.145.32.163`，资源名 `eip-zhicheng-cd005511`。

两条规则都应为 TCP、目的端口 22，并指向上述 Noise-Budget UID：

- `118.145.32.163:10182 -> Noise-Budget:22`
- `118.145.32.163:11182 -> Noise-Budget:22`

**DNAT 和 sshd 是两件事。** DNAT 为 `ACTIVE` 只证明网络转发存在；`Connection refused` 通常表示目标没有 sshd，`timed out` 才优先检查规则、目标或实例状态。

### 4.1 读取规则

```bash
export PLAYWRIGHT_CORE_PATH="D:/GitHub/noise-budget/.tools/browser/node_modules/playwright-core"
export CDP_PORT=9223
export WANT=10182,11182
"$NODE" tools/zhicheng/dnat_read.js
```

规则以 API 回读为准，不以应用详情页是否显示 DNAT 为准。`CREATED` 且目标为空表示未绑定，`ACTIVE` 且 `inst` 为 Noise-Budget UID 才是完成状态。

### 4.2 重绑已有端口

下面以 11182 为例。解绑会暂时移除原目标的公网入口；执行前必须确认原目标已停止或用户明确要求迁移，不能影响其他正在运行的任务。

```bash
"$NODE" tools/zhicheng/dnat_rebind.js --step=report --ext=11182
"$NODE" tools/zhicheng/dnat_rebind.js --step=unbind --ext=11182
"$NODE" tools/zhicheng/dnat_rebind.js --step=bind --dry --ext=11182
"$NODE" tools/zhicheng/dnat_rebind.js --step=bind --ext=11182
```

工具要求实例类型、实例名称和目的端口都精确匹配，并最终检查 `ACTIVE + Noise-Budget UID`。dry run 不保存。不要把目标简写成模糊的第一项，否则可能误绑到其他应用。

### 4.3 添加缺失端口

```bash
export EXT_PORT=10182
"$NODE" tools/zhicheng/dnat_add.js dry
"$NODE" tools/zhicheng/dnat_add.js save
```

添加成功后再次读取两条规则。创建规则走控制台 UI，读取走 API；不要凭猜测直接 POST 不完整字段。

## 5. SSH 与启动配置

`tools/zhicheng/noise_sshd.sh` 必须在实例启动流程中执行。DNAT 配置完成后，两个端口都要实测，不能只检查其中一条：

```bash
for port in 10182 11182; do
  ssh -i ~/.ssh/id_ed25519 -p "$port" \
    -o BatchMode=yes -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    root@118.145.32.163 'echo ALIVE; hostname; nvidia-smi -L'
done
```

预期主机名以 `app-d23f37025c03458c96c481c6f268b71d-` 开头。若不是，立即停止后续操作并重新检查 DNAT 目标，不能把代码或数据发往其他容器。

容器重建会更换主机密钥。本操作示例使用独立 `UserKnownHostsFile=/dev/null`，避免污染默认 known_hosts。若使用默认 known_hosts，先备份，再只删除该 EIP:port 的旧条目。

修改实例启动命令时：

1. 停止前确认这是自己的 Noise-Budget，且当前没有需要保留的运行结果。
2. 编辑页可能有多个 ACE 编辑器；所有对应编辑器都要写入并逐一回读长度。
3. 发布后重新打开实例配置，确认新命令确实包含 `noise_scripts.tgz` 和 sshd 初始化，而不是旧版本。
4. 启动后再次检查 DNAT；实例停止曾导致规则消失，不能假设重启会保留。
5. 验证两个 SSH 端口，再发送代码、数据或启动实验。

## 6. 依赖与固定数据

标准流程：

```bash
uv sync
uv run utils/prepare_data.py
uv run utils/prepare_data.py --verify
```

依赖版本以 `pyproject.toml` 和 `uv.lock` 为准。下载源变慢时，可以只在远端临时替换镜像地址，但不得改变版本或 wheel 哈希。原始 `uv.lock` 与 `pyproject.toml` 要保留备份，镜像改动不得进入公开提交。

固定数据的 token SHA256 必须为：

- `train.pt`：`2a92b8e9c3bc418c39880d337951775b9d29d0389bf1059cc826c412c44def37`
- `val.pt`：`5fdb9242ce8ab83e519ab5dd5cf8d64f4d8a99f6e74c137f4ca0f723da5f7437`

形状分别为 `[14648, 2049]` 和 `[544, 2049]`。Windows 的 CRLF 转换会改变 tokenizer 哈希；必须保留 Git 对象中的 LF 原始字节。

GitHub Release `public-data-v1` 只是公开输入数据的传输备份，不是实验结果。数据源与生成规则以官方 `utils/prepare_data.py` 为准。

## 7. 实验与结果

2×H100 功能实验使用 8 个逻辑 rank，并保存 `physical_gpus=2`、`record_eligible=false` 元数据。只有数据验证通过才启动训练。

```bash
uv run torchrun --standalone --nproc_per_node=8 train/speedrun/run.py \
  --identity-only --identity-updates 1831 --output logs/identity-probe
```

该命令是诊断，不是纪录。最终权重必须由未修改的 `utils/eval.py` 严格加载并重新评分。墙钟、硬件、逻辑 rank、物理卡数、seed 和数据使用量必须一起记录。

正式 PR 只允许在真实单节点 8×H100 上取得合规结果后提交，并附官方要求的 `config.json`、`metrics.jsonl` 和 `result.json`。不得把 2 卡共享运行、推算时间或未验证 checkpoint 包装成比赛成绩。

## 8. 常见故障

- **SSH timed out**：检查应用是否 `1/1 运行中`，再用 API 检查 DNAT 是否 `ACTIVE` 且目标 UID 正确。
- **SSH refused**：DNAT 已通，检查并启动 sshd。
- **SSH 连接到陌生主机名**：立即停下，重新绑定到 Noise-Budget；不要传输任何文件。
- **Web Terminal 显示 disconnect**：后台任务应使用实例启动命令或 `setsid` 独立运行；不要依赖浏览器连接作为任务生命周期。
- **实例配置发布后仍是旧命令**：检查所有 ACE 编辑器，重新发布并刷新验证。
- **应用停止后没有 DNAT**：按本文件恢复两条规则，再验证 SSH。
- **下载很慢**：只换镜像，不换依赖版本或哈希。
- **其他任务状态异常**：先读启动命令和事件，不要停止。已确认的 `awsec-test-39466` 只是输出标记文件的探针，不是 Noise 训练。

## 9. 推送前检查

```bash
git status --short --ignored
git diff --check
git diff --stat
```

检查完整 diff，不得包含密码、AK/SK、Bearer token、私钥、其他项目的未投稿方案或实验结果。公开平台文档可以包含资源名称、公开 EIP、应用 UID 和授权公钥；这些不是密码。认证文件、私有结果和临时载荷必须保持在本机或明确的私有存储中。
