"""高德开放平台客户端（真实 API 调用）。

提供能力：
- search_poi   ：关键词搜索 POI（景点/餐厅/商场等）
- get_weather  ：天气查询（逐日预报）
- get_route    ：路线规划（步行 / 驾车 / 公交），含距离、耗时、打车费用
- geocode      ：地址/城市名 → 经纬度（算城际距离用）

使用前需在 .env 配置 AMAP_API_KEY（高德开放平台免费申请：https://console.amap.com/）。
"""
from typing import Any, Dict, List, Optional, Tuple

import threading
import time

import httpx

from ..config import settings

BASE_URL = "https://restapi.amap.com/v3"

# ---- 简单限流：个人开发者免费额度 QPS 较低，避免触发 CUQPS_HAS_EXCEEDED_THE_LIMIT ----
_MIN_INTERVAL = 0.4  # 秒；约 2.5 QPS，低于免费额度常见 3 QPS
_throttle_lock = threading.Lock()
_last_call_at = 0.0


def _throttle() -> None:
    """确保相邻两次高德请求至少间隔 _MIN_INTERVAL 秒。"""
    global _last_call_at
    with _throttle_lock:
        now = time.monotonic()
        wait = _MIN_INTERVAL - (now - _last_call_at)
        if wait > 0:
            time.sleep(wait)
        _last_call_at = time.monotonic()


class AmapError(Exception):
    """高德接口调用异常（未配 key / 网络异常 / 业务错误）。"""


class AmapClient:
    """高德开放平台 REST API 客户端。"""

    def __init__(self, key: Optional[str] = None, timeout: float = 10.0):
        self.key = key or settings.amap_api_key
        self.timeout = timeout

    def _get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """发起 GET 请求并统一处理错误，返回业务数据。"""
        if not self.key:
            raise AmapError("未配置 AMAP_API_KEY，请在 .env 中填写高德开放平台密钥")
        params = {**params, "key": self.key}
        _throttle()
        try:
            resp = httpx.get(f"{BASE_URL}{path}", params=params, timeout=self.timeout)
            resp.raise_for_status()
        except httpx.HTTPError as exc:  # 网络异常兜底
            raise AmapError(f"高德接口网络异常：{exc}") from exc

        data = resp.json()
        if data.get("status") != "1":
            raise AmapError(f"高德接口返回错误：{data.get('info', '未知错误')}")
        return data

    def search_poi(
        self,
        keywords: Optional[str] = None,
        city: Optional[str] = None,
        types: Optional[str] = None,
        offset: int = 20,
        page: int = 1,
    ) -> List[Dict[str, Any]]:
        """关键词 / 分类码搜索 POI。

        keywords 与 types 二选一（高德规定至少传其一）：
        - 传 keywords：按关键词搜索（可搭配 city 限定城市）。
        - 传 types：按 POI 分类码搜索（如 "110200" 风景名胜，多个用 | 分割）。
        offset 单页最多 25 条；需要更多结果时用 page 翻页（1 起）。
        """
        params: Dict[str, Any] = {"offset": offset, "page": page}
        if keywords:
            params["keywords"] = keywords
        if city:
            params["city"] = city
        if types:
            params["types"] = types
        data = self._get("/place/text", params)
        return data.get("pois", [])

    def resolve_region(self, destination: str) -> tuple[str, str]:
        """把目的地解析为 (区县名 adname, 城市名 cityname)。

        高德 place/text 的 city 参数只认「城市名/区县名/adcode」；像「东山岛」
        这类景区名会静默失效，导致返回全国结果（例如关键词「公园」搜出北京公园）。
        策略：
        1. 先用风景名胜类型探测 destination 能否直接当 city 用（城市名命中则直接用，
           保留城市粒度，避免「杭州」被缩小到某个区）；
        2. 不行则按关键词搜一次，取首个结果的所在区县（adname）与城市（cityname），
           例如 东山岛 -> (东山县, 漳州市)：区县级用于 POI 搜索更聚焦，城市级用于
           天气 / 知识库匹配。
        都失败时返回 (destination, destination)，由后续搜索兜底。
        """
        try:
            probe = self._get(
                "/place/text",
                {"types": "110000", "city": destination, "offset": "1"},
            )
            if probe.get("count") and int(probe["count"]) > 0:
                return destination, destination
        except AmapError:
            pass
        try:
            hits = self._get(
                "/place/text", {"keywords": destination, "offset": "5"}
            ).get("pois", [])
            for p in hits:
                adname = p.get("adname")
                if adname:
                    return adname, p.get("cityname") or adname
        except AmapError:
            pass
        return destination, destination

    def resolve_city(self, destination: str) -> str:
        """兼容旧接口：返回区县级城市名（POI 搜索用）。"""
        adname, _ = self.resolve_region(destination)
        return adname

    def get_weather(self, city: str, extensions: str = "all") -> Dict[str, Any]:
        """逐日天气查询。extensions="all" 返回多日预报。"""
        return self._get("/weather/weatherInfo", {"city": city, "extensions": extensions})

    def geocode(self, address: str) -> Optional[Tuple[float, float]]:
        """地址/城市名 → (纬度, 经度)。查不到返回 None。

        为什么要用地理编码而不是 let 用户填坐标：用户填的是「杭州」「上海」这种
        城市名，而算城际距离必须先变成长度单位。原来往返大交通是拍脑袋的固定值
        （高铁一律 150 元/人），就是因为**根本不知道出发地和目的地隔多远**。
        """
        name = (address or "").strip()
        if not name:
            return None
        try:
            data = self._get("/geocode/geo", {"address": name})
        except AmapError:
            return None
        geocodes = data.get("geocodes") or []
        if not geocodes:
            return None
        loc = str(geocodes[0].get("location") or "")
        if "," not in loc:
            return None
        try:
            lng_s, lat_s = loc.split(",", 1)
            return (float(lat_s), float(lng_s))
        except (TypeError, ValueError):
            return None

    def get_route(
        self, origin: str, destination: str, mode: str = "walking"
    ) -> Dict[str, Any]:
        """路线规划。origin/destination 形如 "lng,lat"。

        mode: walking(步行) / driving(驾车) / transit(公交)。
        驾车结果含 taxi_cost（打车费用，元）。
        """
        path_map = {
            "walking": "/direction/walking",
            "driving": "/direction/driving",
            "transit": "/direction/transit/integrated",
        }
        if mode not in path_map:
            raise AmapError(f"不支持的出行方式：{mode}")
        return self._get(
            path_map[mode], {"origin": origin, "destination": destination}
        )


#: 模块级默认客户端（便于各 Skill 复用）
default_client = AmapClient()
