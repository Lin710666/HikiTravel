"""全局配置模块。

所有可变参数都通过环境变量注入，便于「本地部署」：
- Ollama 地址 / 模型名：AI 本地推理的核心配置
- 天气 API Key：可选，缺省时自动使用内置 Mock 天气数据
- 静态目录：生产环境下 FastAPI 托管前端打包产物

使用方式：复制 .env.example 为 .env 后按需修改。
"""
import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 载入 backend/.env（若存在）。必须在 Settings 默认值求值前调用，
# 否则 os.getenv 会拿到空值。进程环境变量优先，不会被 .env 覆盖。
load_dotenv()


@dataclass
class Settings:
    # ---- AI 本地推理（Ollama）----
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")
    ollama_embed_model: str = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
    # 规划体检可以单独指定模型：换个小模型能明显提速（体检是"挑毛病"，
    # 对模型能力的要求低于规划本身）
    ollama_check_model: str = os.getenv("OLLAMA_CHECK_MODEL", "")
    # 本地 7B 模型在 CPU 上生成一份完整规划可能需要 1~3 分钟，
    # 超时设太短会把"模型还在写"误判成失败，因此默认给足 180 秒。
    ollama_timeout: float = float(os.getenv("OLLAMA_TIMEOUT", "180"))
    # 模型常驻时长（Ollama keep_alive）：一次生成要多次调用大模型，
    # 保持常驻可以省掉两次调用之间的模型加载时间（本地 7B 冷启动可达几十秒）
    ollama_keep_alive: str = os.getenv("OLLAMA_KEEP_ALIVE", "30m")

    # ---- 高德开放平台（POI / 天气 / 路线 / 周边酒店餐饮 实时数据）----
    amap_api_key: str = os.getenv("AMAP_API_KEY", "")

    # ---- 前端静态目录（生产环境托管 dist/）----
    static_dir: str = os.getenv("STATIC_DIR", "")

    # ---- 规划体检：允许带反馈重新生成的最大次数（0 = 只体检不重生成）----
    # 重新生成要多花一次大模型调用（本地 7B 约 1 分钟），因此默认只允许 1 次，
    # 且只在"硬伤"（系统判定的严重问题 / 优化后仍存在的超长路线）时才触发。
    plan_max_regenerate: int = int(os.getenv("PLAN_MAX_REGENERATE", "1"))


settings = Settings()
