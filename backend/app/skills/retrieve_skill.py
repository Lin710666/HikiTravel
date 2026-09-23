"""Skill2：多源数据获取与检索（数据层）。

调用真实外部 API 与本地 RAG，收集规划所需数据：
- 天气：高德天气 API（实时）
- 景点 / 餐饮 / 酒店 POI：高德 POI 搜索（实时，含参考票价 biz_ext.cost）
- 本地知识：RAG 检索器（慢变编辑类知识）

推荐排序（**不是只看评分**，公式与权重集中在 skills/scoring.py）：
- 景点综合分     = 热门程度分 × 权重 + 评分 × 权重
- 餐厅/酒店综合分 = 距上一景点 × 权重 + 距下一景点 × 权重 + 评分 × 权重

原则（与用户对齐）：
- 不设静默参数：目的地没填、或高德认不出来，直接结束流程并提示用户，
  绝不猜一个城市继续算（那样会搜出全国结果，等于给用户假数据）。
- 门票价 / 酒店房价等时效性数据全部来自 API，本地不硬编码。
"""
from typing import Any, Dict, List, Optional, Sequence

from ..models.plan import Location, POI
from ..rag.retriever import Retriever
from ..services.amap import AmapClient
from ..services.weather import WeatherService
from .base import Skill
from .errors import MissingRequiredInfoError
from .scoring import distance_km, option_score, order_attractions, popularity_raw

# 兴趣导向 -> 高德 POI 分类码（types）。用分类码而非关键词，避免「公园」搜出餐厅、
# 「博物馆」搜出商场。
#   110101 公园 | 110103 植物园 | 110200 风景名胜(含 110201 世界遗产/110202 国家级)
#   110205 寺庙道观/110208 海滩/110209 观景点 | 110204 纪念馆
#   140100 博物馆 | 140200 展览馆 | 140400 美术馆 | 140600 科技馆 | 140700 天文馆 | 140800 文化宫
#   080501 游乐园/主题乐园 | 080600 影剧院 | 080401 度假村
PREFERENCE_TYPES: Dict[str, str] = {
    "人文历史": "140100|140200|140400|140600|140700|140800|110201|110204|110205",
    "自然风光": "110101|110103|110200|110208|110209",
    "娱乐": "080501|080600|080401",
    # 「美食」不产生景点，走独立餐厅检索，避免餐馆混进景点池
}

# 饮食禁忌 -> 餐厅搜索关键词（用于餐厅推荐时叠加检索，命中的会进入候选池）
DIET_KEYWORDS: Dict[str, str] = {
    "清真": "清真餐厅",
    "素食": "素食",
    "海鲜": "海鲜",
    # 「无辣」没有可直接搜的关键词，忽略（不影响候选池）
}


def _to_rating(value: Any) -> Optional[float]:
    """高德评分字段可能是字符串 '4.7'，也可能是空 list [] 或缺失，统一转 float。"""
    try:
        r = float(value)
    except (TypeError, ValueError):
        return None
    return r if r > 0 else None


def _text(value: Any) -> str:
    """高德字段偶尔返回空 list []（而非空字符串），统一转安全字符串。"""
    return value if isinstance(value, str) else ""


def _photos(item: Dict[str, Any]) -> List[str]:
    """取高德 POI 的图片地址。

    统一升级成 https：应用可能部署在 https 下，http 图片会被浏览器
    当成混合内容拦掉（实测该图床两种协议都支持，所以直接换掉更稳）。
    """
    out: List[str] = []
    for photo in item.get("photos") or []:
        url = photo.get("url") if isinstance(photo, dict) else None
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        out.append(url.replace("http://", "https://", 1))
        if len(out) >= 4:
            break
    return out


def _parse_location(loc: str) -> Location:
    """高德返回的 "lng,lat" 字符串 -> Location。"""
    lng, lat = loc.split(",")
    return Location(lat=float(lat), lng=float(lng))


def _to_poi(item: Dict[str, Any], poi_type: str = "景点") -> POI:
    """高德 POI 结果 -> 内部 POI 模型。"""
    biz_ext = item.get("biz_ext") or {}
    cost = biz_ext.get("cost")
    price = float(cost) if cost else None
    rating = _to_rating(biz_ext.get("rating"))
    tips = f"参考消费约 {price:.0f} 元" if price else ""
    return POI(
        name=_text(item.get("name")),
        type=poi_type,
        location=_parse_location(item["location"]),
        city=_text(item.get("cityname")) or _text(item.get("adname")),
        description=_text(item.get("address")),
        tips=tips,
        price=price,
        rating=rating,
        photos=_photos(item),
    )


def _tier_cost(cost: Optional[float]) -> str:
    """人均消费 -> 价位档。"""
    if cost is None:
        return "中档"
    if cost <= 50:
        return "经济"
    if cost <= 150:
        return "中档"
    return "高档"


def _tier_hotel(rating) -> str:
    """酒店评分 -> 价位档（高德无实时房价，用评分近似档次）。"""
    try:
        r = float(rating)
    except (TypeError, ValueError):
        return "中档"
    if r >= 4.7:
        return "高档"
    if r >= 4.3:
        return "中档"
    return "经济"


def _to_recommendation(item: Dict[str, Any], kind: str) -> POI:
    """构建餐饮/酒店推荐项：带价位档 + 参考价/评分。"""
    biz_ext = item.get("biz_ext") or {}
    cost = biz_ext.get("cost")
    price = float(cost) if cost else None
    rating = item.get("rating") or biz_ext.get("rating")
    check_in = ""
    check_out = ""
    if kind == "餐厅":
        tier = _tier_cost(price)
        tips = f"人均约 ¥{price:.0f}" if price else "人均待查"
    else:  # 住宿
        tier = _tier_hotel(rating)
        # 高德不提供实时房价，按档次给每晚估算价，便于预算估算与用户选定后重算
        price = {"经济": 150, "中档": 350, "高档": 600}.get(tier, 350)
        tips = (f"评分 {rating}" if rating else "评分待查") + f" · 约 ¥{price}/晚"
        # 入住/退房时间：高德无逐店实时数据，用行业通行惯例，实际以酒店为准
        check_in = "14:00"
        check_out = "12:00"
    return POI(
        name=_text(item.get("name")),
        type=kind,
        location=_parse_location(item["location"]),
        city=_text(item.get("cityname")) or _text(item.get("adname")),
        description=_text(item.get("address")),
        tips=tips,
        price=price,
        rating=_to_rating(rating),
        tier=tier,
        check_in=check_in,
        check_out=check_out,
        photos=_photos(item),
    )


def _search_multi(
    amap: AmapClient, keywords: str, city: str, offset: int = 25, pages: int = 2
) -> List[Dict[str, Any]]:
    """翻页搜索并按高德 POI id 去重，聚合多页结果（扩大餐厅/酒店候选池）。"""
    items: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for page in range(1, pages + 1):
        for item in amap.search_poi(keywords, city, offset=offset, page=page):
            pid = item.get("id")
            if pid and pid not in seen:
                seen.add(pid)
                items.append(item)
    return items


def _neighbors_by_distance(
    poi: POI, anchors: Sequence[POI], count: int = 2
) -> List[Optional[POI]]:
    """取离该点最近的若干个景点（按直线距离）；坐标缺失的点不参与。"""
    pairs = [(distance_km(poi, a), a) for a in anchors]
    pairs = [(d, a) for d, a in pairs if d is not None]
    pairs.sort(key=lambda pair: pair[0])
    result: List[Optional[POI]] = [a for _, a in pairs[:count]]
    while len(result) < count:  # 景点不足时补 None，交给 option_score 自动降权重
        result.append(None)
    return result


def _option_prescore(poi: POI, anchors: Sequence[POI]) -> float:
    """检索阶段的餐厅 / 酒店综合分（近似版）。

    此阶段还没排出每日行程，因此用「行程景点集合里最近的两个景点」近似
    时间轴上的前后邻居：最近的当上一站，次近的当下一站。
    真正落到每天时间轴上的精确评分（当天真实前后邻居）由 Planner 组装时重算。
    """
    prev_poi, next_poi = _neighbors_by_distance(poi, anchors, 2)
    return option_score(poi, prev_poi, next_poi)


def _tiered(items: List[Dict[str, Any]], kind: str, anchors: Sequence[POI]) -> List[POI]:
    """按价位分档（经济→中档→高档），档内按综合分排序，每档最多取 10 个。

    分档是为了让用户在「换一家」时既能降级也能升级；
    档内排序用综合分（距离前后景点 + 评分），而不是只看评分。
    """
    buckets: Dict[str, List[POI]] = {"经济": [], "中档": [], "高档": []}
    for item in items:
        poi = _to_recommendation(item, kind)
        buckets[poi.tier].append(poi)
    result: List[POI] = []
    for tier in ("经济", "中档", "高档"):
        ranked = sorted(
            buckets[tier], key=lambda p: _option_prescore(p, anchors), reverse=True
        )
        result.extend(ranked[:10])
    return result


class RetrieveSkill(Skill):
    """多源数据获取与检索。"""

    name = "retrieve"
    description = "调用天气/POI API 与本地 RAG，收集规划所需数据"

    def __init__(
        self,
        amap: AmapClient | None = None,
        weather: WeatherService | None = None,
        retriever: Retriever | None = None,
    ):
        self.amap = amap or AmapClient()
        self.weather_svc = weather or WeatherService()
        self.retriever = retriever or Retriever()

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        pref = ctx["preference"]

        # 0. 目的地必填：没填就结束流程并提示用户，不静默默认某个城市
        destination = (pref.destination or "").strip()
        if not destination:
            raise MissingRequiredInfoError(
                "请先告诉我目的地城市（例如「杭州」），我再为你规划行程。"
            )

        # 把目的地解析成高德认的「区县名 + 城市名」；解析不出来直接抛
        # AmapDestinationError，由 API 层提示用户确认目的地，绝不拿全国结果凑数。
        city, city_name = self.amap.resolve_region(destination, pref.destination_adcode)
        ctx["resolved_region"] = {
            "input": destination,
            "city": city,
            "city_name": city_name,
        }

        # 1. 实时天气（多拿 3 天：高德 extensions=all 最多返回未来 4 天）
        ctx["weather"] = self.weather_svc.forecast(city, pref.duration_days + 3)

        # 2. 景点 POI：按兴趣分类码搜索，计算综合分（热门程度 + 评分）后排序
        items_by_id: Dict[str, Dict[str, Any]] = {}
        hit_counts: Dict[str, int] = {}
        # 没填兴趣导向就搜全部类别，保证"没选也能出规划"。
        # 少了这一句，preferences 为空时这个循环一次都不执行，
        # 结果是规划里一个景点都没有——这也是后端一度把兴趣设成必填的原因。
        for tag in (pref.preferences or list(PREFERENCE_TYPES.keys())):
            types = PREFERENCE_TYPES.get(tag, "")
            if not types:
                continue
            for item in self.amap.search_poi(types=types, city=city, offset=25):
                pid = item.get("id") or item.get("name", "")
                if not pid:
                    continue
                if pid not in items_by_id:
                    items_by_id[pid] = item
                # 跨分类命中次数本身就是热度信号：同一点在多个兴趣主题里都排得上号
                hit_counts[pid] = hit_counts.get(pid, 0) + 1

        max_raw = max(
            (
                popularity_raw(item, hit_counts[pid])
                for pid, item in items_by_id.items()
            ),
            default=0.0,
        )
        if not items_by_id and not pref.must_visit:
            # 例：兴趣只选了「美食」——没有可对应的景点分类，不静默换成别的兴趣去搜
            raise MissingRequiredInfoError(
                "你的兴趣导向里没有能对应景点的分类（人文历史 / 自然风光 / 娱乐），"
                "也没有填写想去的景点，所以无法推荐景点。请补充兴趣或直接填写想去的地方。"
            )
        # 综合分 = 距上一景点 × 权重 + 热门程度 × 权重 + 评分 × 权重，
        # 贪心排出一条顺路的候选链（而不是只按评分/热度把相隔很远的点堆在前面）
        attractions: List[POI] = [
            _to_poi(item)
            for item in order_attractions(list(items_by_id.values()), hit_counts, max_raw)
        ]

        # 3. 餐饮 / 酒店 POI：多关键词 + 翻页扩大候选池，按综合分排序分档
        restaurant_items = _search_multi(self.amap, "餐厅", city, pages=2)
        seen_rids = {it.get("id") for it in restaurant_items}
        extra_keywords: List[str] = ["小吃", "本地菜"]
        if "美食" in pref.preferences:
            extra_keywords.append("特色美食")
        extra_keywords.extend(
            DIET_KEYWORDS[r] for r in pref.dietary_restrictions if r in DIET_KEYWORDS
        )
        for kw in extra_keywords:
            for item in _search_multi(self.amap, kw, city, pages=2):
                if item.get("id") and item.get("id") not in seen_rids:
                    seen_rids.add(item.get("id"))
                    restaurant_items.append(item)
        dining_options = _tiered(restaurant_items, "餐厅", attractions)
        # 同样留一份未截断的全量餐厅候选给 planner。
        # _tiered 每档只留 10 个（界面上的「备选池」够用，但选餐不够用）：
        # 三天行程要吃 6 顿，再从 20 家里去掉已用过的，后半程几乎没有近的可用。
        # 实测平潭那份规划：分档池里最后一餐只能选到 16 公里外的店，
        # 放开全量后能选到 1.7 公里的——差了一个数量级。
        ctx["dining_pool"] = [
            _to_recommendation(item, "餐厅") for item in restaurant_items if item.get("location")
        ]

        hotel_items = _search_multi(self.amap, "酒店", city, pages=2)
        seen_hids = {it.get("id") for it in hotel_items}
        for kw, pages in (("民宿", 2), ("客栈", 1)):
            for item in _search_multi(self.amap, kw, city, pages=pages):
                if item.get("id") and item.get("id") not in seen_hids:
                    seen_hids.add(item.get("id"))
                    hotel_items.append(item)
        hotel_options = _tiered(hotel_items, "住宿", attractions)
        # 另外留一份**未截断**的全量酒店候选，专供 planner 选酒店用。
        #
        # 为什么需要它：_tiered 为了让「换一家」能升级/降级，每个价位档只留 10 个，
        # 而档内排序用的锚点是「全部候选景点」。于是会出现这种情况：
        # 一家恰好贴近最终活动区的酒店，因为离其他候选景点远而被挤出前 10，
        # planner 根本看不到它。实测平潭那份规划，全量里有一家离当日活动区
        # 4.14 公里的民宿，分档后池子里最近的只剩 5.22 公里——近 1.1 公里的选择被丢掉了。
        ctx["hotel_pool"] = [
            _to_recommendation(item, "住宿") for item in hotel_items if item.get("location")
        ]

        # 4. 特别想去的景点（必去）：优先复用已搜到的 POI，否则按名称单独搜索；
        #    仍定位不到就保留占位数据（无坐标）并在体检中提示，不让它凭空消失。
        must_pois: List[POI] = []
        for name in pref.must_visit:
            matched = next(
                (p for p in attractions if p.name == name or name in p.name or p.name in name),
                None,
            )
            if matched:
                must_pois.append(matched)
                continue
            hits = self.amap.search_poi(name, city)
            if hits:
                must_pois.append(_to_poi(hits[0]))
            else:
                must_pois.append(
                    POI(
                        name=name,
                        type="景点",
                        location=Location(lat=0, lng=0),
                        city=city,
                        tips="未能在高德定位到坐标，建议到地后在地图中搜索确认",
                    )
                )

        # 必去景点置于候选池最前，规划阶段优先安排
        must_names = {m.name for m in must_pois}
        attraction_pool = must_pois + [p for p in attractions if p.name not in must_names]

        # 5. 本地 RAG 知识（防坑 / 拍照 / 动线），按城市过滤避免串到别的目的地
        rag_query = " ".join(pref.preferences) + " " + city_name
        ctx["rag_tips"] = self.retriever.search(rag_query, top_k=5, city=city_name)

        ctx["attractions"] = attraction_pool
        ctx["attraction_options"] = attraction_pool
        ctx["must_visit_pois"] = must_pois
        ctx["dining_options"] = dining_options
        ctx["hotel_options"] = hotel_options
        ctx["restaurants"] = dining_options
        return ctx
