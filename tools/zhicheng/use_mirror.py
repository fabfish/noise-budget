from pathlib import Path
import shutil

root = Path('/root/work/noise-budget')
for name in ('uv.lock', 'pyproject.toml'):
    backup = root / (name + '.official')
    if not backup.exists():
        shutil.copy2(root / name, backup)
lock = root / 'uv.lock'
text = lock.read_text()
for old, new in (
    ('https://download-r2.pytorch.org/whl/cu128', 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128'),
    ('https://download.pytorch.org/whl/cu128', 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128'),
    ('https://files.pythonhosted.org/packages', 'https://mirrors.cloud.tencent.com/pypi/packages'),
    ('https://pypi.org/simple', 'https://mirrors.cloud.tencent.com/pypi/simple'),
):
    text = text.replace(old, new)
lock.write_text(text)
project = root / 'pyproject.toml'
project.write_text(project.read_text().replace(
    'https://download.pytorch.org/whl/cu128', 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128'))
