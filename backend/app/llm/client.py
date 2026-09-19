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
