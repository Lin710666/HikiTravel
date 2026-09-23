"""本地 RAG 检索器。

检索策略（双层，保证任何环境下可用）：
1. 优先使用 Ollama 本地 embedding 模型（默认 nomic-embed-text），
   对知识库与查询做稠密向量相似度检索。
2. 若 Ollama 不可用，退化为「字符二元组（bigram）稀疏向量」余弦相似度，
   纯 Python 实现、零依赖、离线可用。

知识来源：SQLite 数据库中的慢变编辑类知识（见 repository.py），
不含门票价 / 预约规则等时效性事实。
"""
import math
from typing import Dict, List, Union

import httpx

from ..config import settings
from .repository import get_all_chunks

# 向量可能是稠密 list（Ollama）或稀疏 dict（bigram 兜底）
Vector = Union[List[float], Dict[str, int]]


def _bigram(text: str) -> Dict[str, int]:
    """字符二元组稀疏向量（兜底 embedding）。"""
    text = text.lower()
    vec: Dict[str, int] = {}
    for i in range(len(text) - 1):
        gram = text[i : i + 2]
        vec[gram] = vec.get(gram, 0) + 1
    return vec


def _cosine(a: Vector, b: Vector) -> float:
    """统一余弦相似度：兼容稠密 list 与稀疏 dict。"""
    if isinstance(a, list) and isinstance(b, list):
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(y * y for y in b))
    elif isinstance(a, dict) and isinstance(b, dict):
        dot = sum(v * b.get(k, 0) for k, v in a.items())
        na = math.sqrt(sum(v * v for v in a.values()))
        nb = math.sqrt(sum(v * v for v in b.values()))
    else:
        return 0.0
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class Retriever:
    """知识库检索器：启动时对知识建索引，查询时按相似度返回 top_k。"""

    def __init__(self) -> None:
        self.chunks = get_all_chunks()
        self._ollama_ok: bool | None = None  # 缓存 Ollama 可用性
        self._index: List[Vector] = [
            self._embed(c["text"] + " " + " ".join(c["tags"])) for c in self.chunks
        ]

    def _ollama_embed(self, text: str) -> List[float] | None:
        """调用 Ollama embedding 接口，失败返回 None。"""
        try:
            resp = httpx.post(
                f"{settings.ollama_base_url}/api/embeddings",
                json={"model": settings.ollama_embed_model, "prompt": text},
                timeout=10.0,
            )
            resp.raise_for_status()
            return resp.json().get("embedding")
        except Exception:
            return None

    def _embed(self, text: str) -> Vector:
        """对文本向量化：优先 Ollama，失败回退 bigram。"""
        if self._ollama_ok is not False:
            dense = self._ollama_embed(text)
            if dense is not None:
                self._ollama_ok = True
                return dense
            self._ollama_ok = False
        return _bigram(text)

    def search(self, query: str, top_k: int = 3, city: str = "") -> List[str]:
        """检索与查询最相关的知识片段正文。

        city：目的地城市级名称（如「杭州」）。用于过滤知识库——
        只保留「通用知识（city 为空）」或「与目的地城市匹配」的片段，
        避免给非杭州目的地返回杭州西湖的写死贴士。
        """
        q_vec = self._embed(query)

        def _match(city_of_chunk: str) -> bool:
            if not city_of_chunk:
                return True  # 通用知识
            if not city:
                return True  # 未解析出城市时不额外过滤
            return city_of_chunk in city or city in city_of_chunk

        scored = sorted(
            (
                (i, _cosine(q_vec, vec))
                for i, vec in enumerate(self._index)
                if _match(self.chunks[i].get("city", ""))
            ),
            key=lambda x: x[1],
            reverse=True,
        )
        return [self.chunks[i]["text"] for i, _ in scored[:top_k]]
