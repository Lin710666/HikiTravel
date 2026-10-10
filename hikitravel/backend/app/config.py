"""全局配置模块。

所有可变参数都通过环境变量注入，便于「本地部署」：
- Ollama 地址 / 模型名：AI 本地推理的核心配置
- 天气 API Key：可选，缺省时自动使用内置 Mock 天气数据
- 静态目录：生产环境下 FastAPI 托管前端打包产物

使用方式：复制 .env.example 为 .env 后按需修改。
"""
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from dotenv import load_dotenv

# 载入 backend/.env（若存在）。必须在 Settings 默认值求值前调用，
# 否则 os.getenv 会拿到空值。进程环境变量优先，不会被 .env 覆盖。
load_dotenv()


# --------------------------------------------------------------------------
# 与 PosterForge 共用「模型跑在哪」这一份配置
# --------------------------------------------------------------------------
# 为什么旅游规划要去读 posterforge/brain.config.json：
# 用户在设置面板里切一次「外部接口」，期望的是海报、小旅、旅游规划**一起**换，
# 而不是每个页面各配一遍。那份配置本来就是"模型跑在哪"的唯一真相，
# 这里复用它，省得两边各存一份、改了这边忘了那边。
#
# 优先级：显式环境变量 > 共享配置 > 本模块默认值。
# 于是单独部署 HikiTravel（没有 posterforge 目录）时自然退回纯 Ollama，不受影响。
#
# 注意是**按调用时读**而不是 import 时读：用户在网页上点了保存就该立刻生效，
# 不能要求重启 8001。用 mtime 做缓存，文件没动就不重复解析。


@dataclass
class LLMSettings:
    """一次调用实际要用的模型参数（已经把所有来源合并好）。"""

    provider: str          # ollama | openai
    base_url: str          # ollama: 服务地址；openai: 到 /v1 为止的地址
    api_key: str
    model: str
    source: str            # env / shared / default，仅供排查
    #: 外部模型是否开思考模式。见 effective_llm 里的说明，默认关。
    thinking: bool = False
    shared_path: Optional[str] = None


_shared_cache: Dict[str, Any] = {"mtime": None, "data": {}}


def shared_config_path() -> Optional[Path]:
    """找到 PosterForge 的配置文件；找不到就返回 None（纯本地部署的情形）。"""
    raw = os.getenv("PF_BRAIN_CONFIG", "").strip()
    if raw:
        p = Path(raw)
        return p if p.is_file() else None
    # backend/app/config.py → parents[3] 就是仓库根，posterforge 与 hikitravel 平级
    p = Path(__file__).resolve().parents[3] / "posterforge" / "brain.config.json"
    return p if p.is_file() else None


def _read_shared() -> Dict[str, Any]:
    """按 mtime 缓存的共享配置读取。读坏了就当没有，不影响本地推理。"""
    path = shared_config_path()
    if path is None:
        _shared_cache["mtime"] = None
        _shared_cache["data"] = {}
        return {}
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return dict(_shared_cache["data"])
    if _shared_cache["mtime"] == mtime:
        return dict(_shared_cache["data"])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = dict(_shared_cache["data"])   # 正写着读到的半截 JSON：沿用上一份
    _shared_cache["mtime"] = mtime
    _shared_cache["data"] = data
    return dict(data)


def effective_llm() -> LLMSettings:
    """合并出本次调用该用的参数。每次调用前都走一遍（廉价，带 mtime 缓存）。"""
    shared = _read_shared()
    path = shared_config_path()

    env_provider = os.getenv("LLM_PROVIDER", "").strip().lower()
    if env_provider in ("ollama", "openai"):
        provider, source = env_provider, "env"
    elif str(shared.get("provider", "")).strip().lower() in ("ollama", "openai"):
        provider, source = str(shared["provider"]).strip().lower(), "shared"
    else:
        provider, source = "ollama", "default"

    if provider == "openai":
        base = (os.getenv("LLM_BASE_URL") or shared.get("baseUrl") or "").strip()
        key = (os.getenv("LLM_API_KEY") or shared.get("apiKey") or "").strip()
        model = (os.getenv("LLM_MODEL") or shared.get("copy") or "").strip() or settings.ollama_model
    else:
        base = (os.getenv("LLM_BASE_URL") or settings.ollama_base_url).strip()
        key = ""
        # OLLAMA_MODEL 显式设过就用它；否则跟随共享配置里的对话模型
        if os.getenv("OLLAMA_MODEL"):
            model = settings.ollama_model
        else:
            model = (shared.get("copy") or settings.ollama_model).strip()

    # 思考模式：默认关，需要多约束推理时再打开。
    # 为什么默认关（官方文档写的两条）：
    #   1. 开思考时 temperature 不生效，而规划与体检都靠 0.1~0.2 求稳定；
    #   2. reasoning_tokens 算在 completion_tokens 里，会占掉 max_tokens，
    #      我们那点额度（体检 350 / 选点 700）会被思考吃光、正文直接空掉。
    # 打开时 client.py 会同步把 max_tokens 抬高，见那里的说明。
    # 取值顺序：环境变量 LLM_THINKING > 共享配置的 planThinking > 关。
    _think_env = (os.getenv("LLM_THINKING", "") or "").strip().lower()
    if _think_env in ("1", "on", "true", "yes"):
        thinking = True
    elif _think_env in ("0", "off", "false", "no"):
        thinking = False
    else:
        thinking = bool(shared.get("planThinking", False))

    return LLMSettings(
        provider=provider,
        base_url=base.rstrip("/"),
        api_key=key,
        model=model,
        source=source,
        thinking=thinking,
        shared_path=str(path) if path else None,
    )


@dataclass
class Settings:
    # ---- AI 本地推理（Ollama）----
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")
    # 需求抽取可以单独指定模型：它是"照着说明填空"，对模型能力的要求低于
    # 规划与体检，换个小模型能省掉每次生成开头的一次长耗时调用。
    ollama_intent_model: str = os.getenv("OLLAMA_INTENT_MODEL", "")
    # 规划体检可以单独指定模型：换个小模型能明显提速（体检是"挑毛病"，
    # 对模型能力的要求低于规划本身）
    ollama_check_model: str = os.getenv("OLLAMA_CHECK_MODEL", "")
    # 本地 7B 模型在 CPU 上生成一份完整规划可能需要 1~3 分钟，
    # 超时设太短会把"模型还在写"误判成失败，因此默认给足 180 秒。
    ollama_timeout: float = float(os.getenv("OLLAMA_TIMEOUT", "180"))
    # 模型常驻时长（Ollama keep_alive）：一次生成要多次调用大模型，
    # 保持常驻可以省掉两次调用之间的模型加载时间（本地 7B 冷启动可达几十秒）
    ollama_keep_alive: str = os.getenv("OLLAMA_KEEP_ALIVE", "30m")
    # 启动预热：在后台把模型加载进内存，并把各 Skill 的系统提示词预填进上下文缓存。
    # Ollama 的缓存按前缀命中，所以预热之后第一次「生成」就能直接进入稳态速度
    # （本机实测：第一次请求约 108s → 约 44s）。设成 0 可关闭。
    ollama_prewarm: bool = os.getenv("OLLAMA_PREWARM", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )

    # ---- 高德开放平台（POI / 天气 / 路线 / 周边酒店餐饮 实时数据）----
    # 三把密钥都**已内置**，clone 下来不配 .env 也能直接跑；
    # 想换成自己的，就复制 .env.example 为 .env 填同名变量覆盖（.env 不入库）。
    amap_api_key: str = os.getenv("AMAP_API_KEY", "e15977855225aaaedebd91c466a3c39e")
    # 浏览器端交互地图（高德 JS API）单独一套凭据：
    # 类型是「Web端(JS API)」，与上面的 Web服务 Key 不通用。
    # 缺失时前端自动退回静态地图，不会开天窗。
    # 安全提醒：JS Key 按设计必然出现在浏览器里，安全密钥同理，藏不住也没必要藏。
    # 真正的防滥用是在高德控制台给该 Key 配「安全域名白名单」。
    amap_js_key: str = os.getenv("AMAP_JS_KEY", "2b8f3210dc65ebae33324896c40150cf")
    amap_security_code: str = os.getenv("AMAP_SECURITY_CODE", "20d4d829c08555735655a2c35707a444")

    # ---- 前端静态目录（生产环境托管 dist/）----
    static_dir: str = os.getenv("STATIC_DIR", "")

    # ---- 实时攻略检索（可选，默认关闭）----
    # 接公开搜索 API 做"搜索 + 阅读"，把攻略摘要作为**偏好提示**喂给选点提示词。
    # 三项都配齐才启用；不配就完全跳过，主流程不受影响。
    # 遵守四条底线，见 services/web_search.py 的模块说明（只发城市名、实体必须能在高德找到等）。
    search_api_mode: str = os.getenv("SEARCH_API_MODE", "")  # serper / bocha（其它值走通用 GET）
    search_api_url: str = os.getenv("SEARCH_API_URL", "")
    search_api_key: str = os.getenv("SEARCH_API_KEY", "")
    search_timeout: float = float(os.getenv("SEARCH_TIMEOUT", "8"))

    # ---- 规划体检：允许带反馈重新生成的最大次数（0 = 只体检不重生成）----
    # 重新生成要多花一次大模型调用（本地 7B 约 1 分钟），因此默认只允许 1 次，
    # 且只在"硬伤"（系统判定的严重问题 / 优化后仍存在的超长路线）时才触发。
    plan_max_regenerate: int = int(os.getenv("PLAN_MAX_REGENERATE", "1"))

    # ---- 成链之后的「跨度 + 配套」校验（见 planner_skill._fix_day_quality）----
    # 一天内部跨度超过这个值就认为"这一天的点集本身不合理"：链可以在这一组点里
    # 排出最优顺序，但排不出紧凑的一天。
    # 口径是**真实驾车距离**（取不到时才用直线 × 绕行系数），不是直线距离，
    # 平潭实测驾车约为直线的 1.6~2 倍，所以 15 公里驾车 ≈ 8 公里直线，
    # 正好对上"一天横跨 8~10 公里直线"这种用户能直接感觉到的离谱排法。
    plan_day_span_limit: float = float(os.getenv("PLAN_DAY_SPAN_LIMIT", "15"))
    # 当天某个景点在这个距离（公里）内没有任何餐厅/酒店候选 → 配套不足，
    # 说明把它排在这天会导致"跑很远去吃饭/住宿"。
    plan_amenity_km: float = float(os.getenv("PLAN_AMENITY_KM", "5"))
    # 定向修补最多做几轮（每轮可能替换一个点；换完要重新串链分天）
    plan_fix_rounds: int = int(os.getenv("PLAN_FIX_ROUNDS", "2"))


settings = Settings()
