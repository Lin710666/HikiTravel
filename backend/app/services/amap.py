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


#: 高德业务错误码 → 给用户看的人话。
#: 原始文案（INVALID_PARAMS / ENGINE_RESPONSE_DATA_ERROR …）开发看得懂，用户看不懂，
#: 而且不告诉他"接下来该干什么"。这里按码翻一遍，翻不到就退回带原文的通用说法。
_AMAP_INFO_HINTS = {
    "INVALID_PARAMS": "发给高德的查询参数不合法 —— 多半是目的地或出发地的写法有问题（空值、纯空格、太长），改成「杭州」这样的城市名再试",
    "INVALID_USER_KEY": "高德 Key 无效：请到 backend/.env 里核对 AMAP_API_KEY",
    "USERKEY_PLAT_NOMATCH": "高德 Key 与当前服务类型不匹配：请在 .env 里换成「Web 服务」类型的 Key",
    "SERVICE_NOT_AVAILABLE": "高德这个接口暂时不可用，请稍后再试",
    "DAILY_QUERY_OVER_LIMIT": "高德 Key 今天的调用额度用完了 —— 明天再试，或换个 Key",
    "CUQPS_HAS_EXCEEDED_THE_LIMIT": "请求太快，触发了高德的频率限制 —— 等几秒再点生成",
    "ENGINE_RESPONSE_DATA_ERROR": "高德没返回可用数据 —— 多半是这个地名它不认识，换个更常见的写法试试",
    "INVALID_USER_IP": "高德 Key 绑定了 IP，当前机器 IP 不在白名单里",
    "INVALID_USER_DOMAIN": "高德 Key 绑定了域名，请到高德控制台调整",
}


def _friendly_amap_info(info: str) -> str:
    """把高德的业务错误码翻成人话（翻不到就带上原文，别把信息丢了）。"""
    hint = _AMAP_INFO_HINTS.get(info.strip().upper())
    if hint:
        return f"地图服务出错：{hint}"
    return f"地图服务出错（{info}）—— 换个更常见的城市名或景点名试试"


def _friendly_http_error(exc: Any) -> str:
    """把 HTTP 层的错误翻成人话。"""
    resp = getattr(exc, "response", None)
    code = getattr(resp, "status_code", None)
    if code == 413:
        return "目的地/出发地填得太长了 —— 地名写成「杭州」这样就好，别粘一整段文字"
    if code == 403:
        return "高德拒绝了这次请求（403）—— 多半是 Key 的权限或额度问题，去高德控制台看一下"
    if code == 401:
        return "高德 Key 鉴权失败（401）—— 请到 backend/.env 里核对 AMAP_API_KEY"
    if isinstance(code, int) and code in (500, 502, 503, 504):
        return f"高德服务端暂时不可用（{code}）—— 稍后再点一次生成"
    if code:
        return f"高德接口返回 {code} —— 稍后再试，或检查网络与 Key"
    return f"请求高德失败（{type(exc).__name__}）—— 请检查网络后重试"


class AmapError(Exception):
    """高德接口调用异常（未配 key / 网络异常 / 业务错误）。"""


#: 高德地理编码结果里，**认可为"这确实是个地方"** 的 level。
#
# 正常地名返回的就是这几种（实测）：
#     杭州 → 市 ｜ 上海市 → 省 ｜ 乌鲁木齐 → 市 ｜ 新疆 → 省 ｜ 苏州市沧浪区 → 区县
# 而「美国华盛顿特区」被模糊匹配成「喀什特区」时返回的是 **住宅区** ——
# 一个小区显然不能拿来当初发城市算距离，所以这里要挡掉。
_GEOCODE_OK_LEVELS = ("国家", "省", "市", "区县", "直辖市")

#: 明显是国外的地名提示词。命中就直接驳回，**不去问接口** ——
#: 问了高德也会"猜"一个国内同名地点回来（见 resolve_place 的说明）。
#: 只列真正的国家 / 国外城市；港澳台是中国的一部分，不在这里。
_FOREIGN_HINTS = (
    "美国", "加拿大", "墨西哥", "巴西", "阿根廷", "智利", "秘鲁",
    "日本", "韩国", "朝鲜", "蒙古", "印度", "尼泊尔", "不丹", "斯里兰卡",
    "泰国", "越南", "老挝", "柬埔寨", "缅甸", "马来西亚", "新加坡",
    "印度尼西亚", "菲律宾", "文莱",
    "英国", "法国", "德国", "意大利", "西班牙", "葡萄牙", "荷兰", "比利时",
    "瑞士", "奥地利", "瑞典", "挪威", "丹麦", "芬兰", "冰岛", "爱尔兰",
    "波兰", "捷克", "匈牙利", "希腊", "土耳其", "俄罗斯", "乌克兰",
    "澳大利亚", "新西兰", "埃及", "南非", "摩洛哥", "肯尼亚", "埃塞俄比亚",
    "以色列", "沙特", "阿联酋", "迪拜", "卡塔尔", "伊朗", "伊拉克",
    # 常见国外城市（有人只写城市、不写国家）
    "纽约", "洛杉矶", "旧金山", "西雅图", "波士顿", "芝加哥", "华盛顿",
    "拉斯维加斯", "夏威夷", "温哥华", "多伦多", "伦敦", "巴黎", "柏林",
    "慕尼黑", "罗马", "米兰", "马德里", "巴塞罗那", "阿姆斯特丹", "苏黎世",
    "维也纳", "斯德哥尔摩", "哥本哈根", "赫尔辛基", "莫斯科", "东京",
    "大阪", "京都", "北海道", "冲绳", "首尔", "釜山", "济州",
    "曼谷", "清迈", "普吉", "吉隆坡", "雅加达", "马尼拉", "河内", "胡志明",
    "悉尼", "墨尔本", "奥克兰", "开罗", "伊斯坦布尔", "雅典",
)


class AmapClient:
    """高德开放平台 REST API 客户端。"""

    def __init__(self, key: Optional[str] = None, timeout: float = 10.0):
        self.key = key or settings.amap_api_key
        self.timeout = timeout

    def _get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """发起 GET 请求并统一处理错误，返回业务数据。

        ★ 报错信息要**写给用户看**，不是写给开发看。
          原来直接把高德的原始文案抛出去，用户看到的是
              HTTP 503  高德接口返回错误：INVALID_PARAMS
              HTTP 503  高德接口网络异常：Client error '413 Request Entity Too Large' ...
          这两句对用户毫无意义（实测踩到：目的地填三个空格、或粘一段长文本）。
          现在按错误码翻译成人话，并给出「下一步该怎么办」。
        """
        if not self.key:
            raise AmapError("未配置高德 Key：请在 backend/.env 里填写 AMAP_API_KEY 后重启后端")
        params = {**params, "key": self.key}
        _throttle()
        try:
            resp = httpx.get(f"{BASE_URL}{path}", params=params, timeout=self.timeout)
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            # 保留状态码，好按码翻译（413 就是参数太长）
            raise AmapError(_friendly_http_error(exc)) from exc
        except httpx.HTTPError as exc:  # 网络异常兜底
            raise AmapError(
                f"连不上高德接口（{type(exc).__name__}）——"
                "请检查网络，或稍后再点一次生成"
            ) from exc

        data = resp.json()
        if data.get("status") != "1":
            info = str(data.get("info") or "未知错误")
            raise AmapError(_friendly_amap_info(info))
        return data

    def search_poi(
        self, keywords: str, city: str, types: Optional[str] = None, offset: int = 20
    ) -> List[Dict[str, Any]]:
        """关键词搜索 POI。"""
        params: Dict[str, Any] = {"keywords": keywords, "city": city, "offset": offset}
        if types:
            params["types"] = types
        data = self._get("/place/text", params)
        return data.get("pois", [])

    def get_weather(self, city: str, extensions: str = "all") -> Dict[str, Any]:
        """逐日天气查询。extensions="all" 返回多日预报。"""
        return self._get("/weather/weatherInfo", {"city": city, "extensions": extensions})

    def resolve_place(self, address: str) -> Dict[str, Any]:
        """把地名解析成一个**可信的**经纬度，并说明为什么可信/不可信。

        返回：
            {"ok": True,  "location": (lat, lng), "level": "市", "formatted": "浙江省杭州市"}
            {"ok": False, "reason": "foreign" | "unreliable" | "not_found" | "error",
             "detail": "...", "formatted": "..."}

        ★ 为什么要校验，而不是拿到 location 就用：
        高德是国内图商，对**它不认识的**地名会做模糊匹配，返回一个国内的同名地点，
        而且返回值看起来完全正常。实测（这是真事）：
            输入「美国华盛顿特区」→ 高德拿「特区」两个字去匹配
            → 返回「新疆维吾尔自治区喀什地区喀什市喀什特区」
              level = 住宅区，坐标 (39.4674, 75.9987)
        于是"美国华盛顿特区 → 新疆"被算成「喀什 → 乌鲁木齐」1078km 的境内高铁，
        往返 1941 元 —— 数字看着很合理，其实跟华盛顿毫无关系。

        两道校验：
          1. `level` 必须是 国家 / 省 / 市 / 区县 —— 正常城市名返回的就是这几种；
             "住宅区"说明匹配到了一个小区，不是城市。
          2. 地名里带明显的国名时直接判为国外（本系统的城际交通只覆盖国内）。
        """
        name = (address or "").strip()
        if not name:
            return {"ok": False, "reason": "not_found", "detail": "没填地名"}

        # 明显的国外地名：直接驳回，不去问接口（问了也会被模糊匹配到国内）
        for hint in _FOREIGN_HINTS:
            if hint in name:
                return {
                    "ok": False, "reason": "foreign",
                    "detail": f"「{name}」看起来是国外地点（含「{hint}」）",
                }

        try:
            data = self._get("/geocode/geo", {"address": name})
        except AmapError as exc:
            return {"ok": False, "reason": "error", "detail": str(exc)}

        geocodes = data.get("geocodes") or []
        if not geocodes:
            return {"ok": False, "reason": "not_found", "detail": "高德查不到这个地名"}

        g = geocodes[0]
        formatted = str(g.get("formatted_address") or "")
        level = str(g.get("level") or "")
        province = str(g.get("province") or "")
        city = str(g.get("city") or "")
        loc = str(g.get("location") or "")
        if "," not in loc:
            return {"ok": False, "reason": "not_found",
                    "detail": "高德没给出坐标", "formatted": formatted}
        try:
            lng_s, lat_s = loc.split(",", 1)
            location = (float(lat_s), float(lng_s))
        except (TypeError, ValueError):
            return {"ok": False, "reason": "not_found",
                    "detail": "高德返回的坐标格式不对", "formatted": formatted}

        if level and level not in _GEOCODE_OK_LEVELS:
            return {
                "ok": False, "reason": "unreliable", "formatted": formatted, "level": level,
                "province": province, "city": city,
                "detail": (f"「{name}」被高德模糊匹配成了「{formatted}」"
                           f"（级别是「{level}」，不是城市）"),
            }
        return {
            "ok": True, "location": location, "level": level, "formatted": formatted,
            # 省 / 市 也带上：检索回来之后要拿它校验"这批 POI 是不是真在目的地"
            # （高德在 city 参数匹配不上时会**默认返回北京**，见 retrieve_skill）
            "province": province, "city": city,
        }

    def geocode(self, address: str) -> Optional[Tuple[float, float]]:
        """地址/城市名 → (纬度, 经度)。**不可信就返回 None**（见 resolve_place）。

        为什么要用地理编码而不是让用户填坐标：用户填的是「杭州」「上海」这种
        城市名，而算城际距离必须先变成长度单位。原来往返大交通是拍脑袋的固定值
        （高铁一律 150 元/人），就是因为**根本不知道出发地和目的地隔多远**。
        """
        r = self.resolve_place(address)
        return r.get("location") if r.get("ok") else None

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
