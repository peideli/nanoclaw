"""
配置管理: 从环境变量 / .env 文件加载 API Key

优先级: 环境变量 > .env 文件

Key 存放规范:
  1. 本地开发: 在项目根目录创建 .env 文件 (参考 .env.example)
  2. 生产部署: 通过环境变量注入 (K8s Secret / 云平台配置中心等)
  3. .env 已被 .gitignore 忽略, 不会进入版本控制
"""

import os
from pathlib import Path


def _load_dotenv():
    """手动解析 .env 文件, 避免额外依赖 python-dotenv"""
    # 从当前工作目录和本文件上两级目录(项目根)查找 .env
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parent.parent / ".env",
    ]
    for env_path in candidates:
        if env_path.is_file():
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        key, _, value = line.partition("=")
                        key = key.strip()
                        value = value.strip().strip("'\"")
                        # 不覆盖已有的环境变量
                        if key and key not in os.environ:
                            os.environ[key] = value
            return


# 模块导入时自动加载 .env
_load_dotenv()


def get_required(name: str) -> str:
    """获取必填的环境变量, 缺失时抛出明确错误"""
    value = os.environ.get(name)
    if not value:
        raise EnvironmentError(
            f"缺少必要的环境变量: {name}\n"
            f"请在 .env 文件中配置或通过 export {name}=xxx 设置\n"
            f"参考 .env.example 模板"
        )
    return value


# --- 火山引擎 ASR ---
VOLC_ASR_APP_KEY = get_required("VOLC_ASR_APP_KEY")
VOLC_ASR_ACCESS_KEY = get_required("VOLC_ASR_ACCESS_KEY")
VOLC_ASR_SUBMIT_URL = "https://openspeech-direct.zijieapi.com/api/v3/auc/bigmodel/submit"
VOLC_ASR_QUERY_URL = "https://openspeech-direct.zijieapi.com/api/v3/auc/bigmodel/query"
VOLC_ASR_RESOURCE_ID = "volc.bigasr.auc"
VOLC_ASR_BOOSTING_TABLE_ID = "edc56ffd-35c3-4cbe-b9a1-40e25c2330d0"

# --- 阿里云百炼 / DashScope ---
DASHSCOPE_API_KEY = get_required("DASHSCOPE_API_KEY")
DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
QC_MODEL_NAME = "qwen3.5-plus"
