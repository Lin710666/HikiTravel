"""LLM 客户端：Ollama 本地推理。

需求文档要求「支持本地部署」，因此默认用 Ollama 运行本地开源模型，
数据不出机器。当 Ollama 未启动/未安装时，chat_json 返回 None，
由上层（planner_skill）自动降级到规则引擎生成，保证演示不中断。
"""
import json
from typing import Any, Dict, Optional

import httpx

from ..config import settings


class LLMClient:
    """Ollama 本地大模型客户端。"""

    def __init__(self) -> None:
        self.base_url = settings.ollama_base_url
        self.model = settings.ollama_model
        self.timeout = settings.ollama_timeout

    def available(self) -> bool:
        """探测 Ollama 服务是否可用。"""
        try:
            resp = httpx.get(f"{self.base_url}/api/tags", timeout=2.0)
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    def chat_text(self, system: str, user: str, temperature: float = 0.7,
                  num_predict: int = 2560, timeout: float = 0.0) -> Optional[str]:
        """调用 Ollama 生成自由文本（Markdown）。

        与 chat_json 的区别：那个用 format=json 强制结构化输出，供规划流水线解析；
        这个不加 format 约束，用来生成「给人看的」Markdown 正文
        （营销文案 / 产品概念卡 / 集中追问）。

        超时单独放宽：OLLAMA_TIMEOUT 默认 30 秒是给「结构化短输出」定的，
        而营销文案要一次生成 A/B 两版、系统提示词又有 20 KB 上下，
        本机 7B 模型实测会超过 30 秒 —— 沿用同一个值会稳定失败。

        失败返回 None，由调用方决定怎么降级。
        """
        eff_timeout = timeout or max(float(self.timeout), 180.0)
        try:
            resp = httpx.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "stream": False,
                    "options": {"temperature": temperature, "num_predict": num_predict},
                },
                timeout=eff_timeout,
            )
            resp.raise_for_status()
            return resp.json()["message"]["content"]
        except (httpx.HTTPError, KeyError, ValueError):
            return None

    def chat_json(self, system: str, user: str) -> Optional[Dict[str, Any]]:
        """调用 Ollama 生成结构化 JSON。

        Args:
            system: 系统提示词（约束输出结构）。
            user: 用户输入。
        Returns:
            解析后的 JSON 字典；失败返回 None（触发上层降级）。
        """
        try:
            resp = httpx.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "format": "json",  # 强制 Ollama 输出合法 JSON
                    "stream": False,
                },
                timeout=self.timeout,
            )
            resp.raise_for_status()
            content = resp.json()["message"]["content"]
            return json.loads(content)
        except (httpx.HTTPError, KeyError, json.JSONDecodeError, ValueError):
            return None
