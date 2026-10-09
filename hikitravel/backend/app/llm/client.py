"""LLM 客户端：本机 Ollama 与外部 OpenAI 兼容接口两条路。

需求文档要求「支持本地部署」，因此**默认**用 Ollama 跑本地开源模型，数据不出机器。

但 PosterForge 的设置面板上有一个「服务来源」开关：切到外部接口时，
海报生成、小旅对话、旅游规划应当**一起**换过去，而不是各配一遍。
所以这里的参数不再在 __init__ 里定死，而是每次调用前走 effective_llm() 现取
（它读共享配置、带 mtime 缓存），用户在网页上点完保存就立刻生效，不用重启 8001。

失败处理（与用户对齐）：不再静默降级到规则引擎，chat_json 返回 None，
并把失败原因记录在 last_error 里，由上层抛出带原因的明确提示（超时 / 非 JSON / 网络错误）。
"""
import json
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx

from ..config import effective_llm, settings
from ..http_local import trust_env_for


def _thinking_param(base_url: str) -> Dict[str, Any]:
    """DeepSeek 的思考模式开关。

    官方文档写明：思考模式**默认是开的**，且它「不支持 temperature，
    传了不报错但也没作用」。规划与体检都靠 temperature=0.1~0.2 求稳定，
    被无声忽略会让输出变飘且查不出原因；思考又发生在正文之前，
    一次规划要多等几十秒。

    所以默认关掉。**只对 DeepSeek 的地址发这个字段**：
    别的 OpenAI 兼容网关大多不认识 thinking，发了会直接回 400。
    """
    host = (urlparse(base_url).hostname or "").lower()
    if host == "deepseek.com" or host.endswith(".deepseek.com"):
        return {"thinking": {"type": "disabled"}}
    return {}


class LLMClient:
    """按 effective_llm() 分发到 Ollama 或外部接口。"""

    def __init__(self) -> None:
        # 下面两个只是**构造时**的快照，给日志和排查看；
        # 真正发请求用的参数一律每次现取 effective_llm()，
        # 否则用户在网页上改了设置，已经建好的这些实例（orchestrator 里是常驻的）
        # 会一直用着旧配置。
        eff = effective_llm()
        self.base_url = eff.base_url
        self.model = eff.model
        self.timeout = settings.ollama_timeout
        #: 最近一次调用的失败原因，供上层拼进用户提示
        self.last_error: str = ""

    # ------------------------------------------------------------------ 探测
    def available(self) -> bool:
        """服务是否可用。两条路的探测方式不同。"""
        eff = effective_llm()
        if eff.provider == "openai":
            if not (eff.base_url and eff.api_key):
                self.last_error = "外部接口还没配齐（需要地址与密钥）"
                return False
            try:
                resp = httpx.get(
                    f"{eff.base_url}/models",
                    headers={"authorization": f"Bearer {eff.api_key}"},
                    timeout=3.0,
                    trust_env=trust_env_for(eff.base_url),
                )
            except httpx.HTTPError as exc:
                self.last_error = f"连不上外部接口（{exc}）"
                return False
            # 401/403 是密钥问题，值得直接报出来；
            # 而 404/405 只是这个网关没实现 /models（很常见），
            # 不能因此判“不可用”，真正能不能用由 chat_json 的实际调用去定。
            if resp.status_code in (401, 403):
                self.last_error = f"外部接口拒绝了这个密钥（HTTP {resp.status_code}）"
                return False
            return True
        try:
            resp = httpx.get(
                f"{eff.base_url}/api/tags", timeout=2.0, trust_env=trust_env_for(eff.base_url)
            )
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    # ------------------------------------------------------------------ 预热
    def prefill(
        self, system: str, user: str = "预热。", model: Optional[str] = None
    ) -> bool:
        """把一段系统提示词预先填进模型上下文缓存（不取值、不解析 JSON）。

        供启动预热使用（见 llm/warmup.py）。Ollama 的上下文缓存按前缀命中，
        因此只要系统提示词与真实调用逐字一致，后续请求就能跳过这段预填充，
        实测 788 token 的系统提示词由此从 19.0s 降到 0.7s。

        所以这里只要请求成功就达到目的；num_predict=1 把生成开销压到可忽略，
        也刻意不带 format="json"（不需要约束输出，省掉语法开销）。
        注意 num_ctx 必须与真实调用一致，否则上下文缓存对不上。

        走外部接口时这套前缀缓存由对方自己管，我们没有预热的手段，直接算成功。
        """
        self.last_error = ""
        eff = effective_llm()
        if eff.provider == "openai":
            return True
        payload = {
            "model": model or eff.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "keep_alive": settings.ollama_keep_alive,
            "options": {"num_predict": 1, "num_ctx": 4096},
        }
        try:
            resp = httpx.post(
                f"{eff.base_url}/api/chat",
                json=payload,
                timeout=self.timeout,
                trust_env=trust_env_for(eff.base_url),
            )
            resp.raise_for_status()
            return True
        except httpx.HTTPError as exc:
            self.last_error = f"预热请求失败（{exc}）"
            return False

    # ------------------------------------------------------------------ 主调用
    def chat_json(
        self,
        system: str,
        user: str,
        options: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        model: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """生成结构化 JSON。

        Args:
            system: 系统提示词（约束输出结构）。
            user: 用户输入。
            options: 采样参数。Ollama 用 temperature/num_predict/num_ctx；
                     外部接口会把前两个翻成 temperature/max_tokens。
            timeout: 本次调用的超时秒数，缺省用配置里的 OLLAMA_TIMEOUT。
            model: 本次使用的模型名，缺省用当前生效的模型
                   （规划体检可以换个更小的模型来提速）。
                   **走外部接口时这个参数被忽略**：那些覆盖名（intent / check）
                   都是本机 Ollama 的模型名，发给外部网关只会换回一个"模型不存在"。
        Returns:
            解析后的 JSON 字典；失败返回 None 并写入 last_error（由上层提示用户）。
        """
        self.last_error = ""
        wait = timeout or self.timeout
        eff = effective_llm()
        if eff.provider == "openai":
            return self._chat_json_openai(eff, system, user, options, wait)
        return self._chat_json_ollama(eff, system, user, options, wait, model)

    def _parse(self, content: str) -> Optional[Dict[str, Any]]:
        """把模型回的内容解析成字典，失败时写好 last_error。"""
        try:
            data = json.loads(content)
        except (json.JSONDecodeError, ValueError) as exc:
            self.last_error = f"大模型返回的内容不是合法 JSON（{exc}）"
            return None
        if not isinstance(data, dict):
            self.last_error = "大模型返回的 JSON 不是对象"
            return None
        return data

    def _chat_json_ollama(
        self, eff, system: str, user: str, options, wait: float, model: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        payload: Dict[str, Any] = {
            "model": model or eff.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "format": "json",  # 强制 Ollama 输出合法 JSON
            "stream": False,
            # 让模型在一段时间内常驻内存：一次生成要调 2~3 次大模型，
            # 不保持常驻的话两次调用之间模型会被卸载，又要重新加载（几十秒冷启动）
            "keep_alive": settings.ollama_keep_alive,
        }
        if options:
            payload["options"] = options
        try:
            resp = httpx.post(
                f"{eff.base_url}/api/chat",
                json=payload,
                timeout=wait,
                trust_env=trust_env_for(eff.base_url),
            )
            resp.raise_for_status()
            return self._parse(resp.json()["message"]["content"])
        except httpx.TimeoutException:
            self.last_error = f"调用大模型超时（超过 {wait:.0f} 秒）"
            return None
        except httpx.HTTPError as exc:
            self.last_error = f"调用大模型失败（{exc}）"
            return None
        except (KeyError, ValueError) as exc:
            self.last_error = f"大模型返回的内容不是合法 JSON（{exc}）"
            return None

    def _chat_json_openai(
        self, eff, system: str, user: str, options, wait: float
    ) -> Optional[Dict[str, Any]]:
        opts = options or {}
        payload: Dict[str, Any] = {
            "model": eff.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            # 要 JSON 用官方字段，而不是把"请输出 JSON"塞进提示词。
            # 注意 DeepSeek 额外要求提示词里出现 "json" 字样（我们的提示词都有）。
            "response_format": {"type": "json_object"},
            "stream": False,
            # 关掉 DeepSeek 的思考模式，否则下面这个 temperature 会被静默忽略
            **_thinking_param(eff.base_url),
        }
        # 采样参数改名：Ollama 的 num_predict 在 OpenAI 这边叫 max_tokens。
        # num_ctx 没有对应概念，忽略即可。
        if "temperature" in opts:
            payload["temperature"] = opts["temperature"]
        if opts.get("num_predict"):
            payload["max_tokens"] = opts["num_predict"]
        try:
            resp = httpx.post(
                f"{eff.base_url}/chat/completions",
                json=payload,
                headers={"authorization": f"Bearer {eff.api_key}"},
                timeout=wait,
                # 外部接口通常要走系统代理，不能像本机 Ollama 那样绕开
                trust_env=trust_env_for(eff.base_url),
            )
            resp.raise_for_status()
            body = resp.json()
            if isinstance(body, dict) and body.get("error"):
                msg = body["error"].get("message") if isinstance(body["error"], dict) else body["error"]
                self.last_error = f"外部接口报错（{str(msg)[:200]}）"
                return None
            choice = (body.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            content = str(message.get("content") or "").strip()
            # DeepSeek 的 JSON 模式官方就承认"偶尔会返回空内容"。
            # 空串原样丢去解析只会得到一句莫名的"不是合法 JSON"，
            # 这里说清楚，并带上 finish_reason：是 length 就说明被 max_tokens 截断了。
            if not content:
                reasoning = message.get("reasoning_content") or ""
                extra = f"，另有 {len(reasoning)} 字思考内容" if reasoning else ""
                self.last_error = (
                    f"外部接口返回了空内容（finish_reason={choice.get('finish_reason')}{extra}）"
                )
                return None
            return self._parse(content)
        except httpx.TimeoutException:
            self.last_error = f"调用外部接口超时（超过 {wait:.0f} 秒）"
            return None
        except httpx.HTTPStatusError as exc:
            detail = ""
            try:
                detail = exc.response.text[:200]
            except Exception:  # noqa: BLE001 - 读不到就算了，别掩盖原始错误
                pass
            self.last_error = f"外部接口返回 {exc.response.status_code}（{detail}）"
            return None
        except httpx.HTTPError as exc:
            self.last_error = f"调用外部接口失败（{exc}）"
            return None
        except (KeyError, IndexError, ValueError) as exc:
            self.last_error = f"外部接口返回的内容不是预期结构（{exc}）"
            return None
