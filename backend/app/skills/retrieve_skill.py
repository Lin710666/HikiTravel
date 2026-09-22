"""Skill2：多源数据获取与检索（数据层）。

调用真实外部 API 与本地 RAG，收集规划所需数据：
- 天气：高德天气 API（实时）
- 景点 / 餐饮 POI：高德 POI 搜索（实时，含参考票价 biz_ext.cost）
- 本地知识：RAG 检索器（慢变编辑类知识）

说明：门票价 / 酒店房价等时效性数据全部来自 API，不在本地硬编码。
"""
from typing import Any, Dict, List, Optional

from ..models.plan import Location, POI
from ..rag.retriever import Retriever
from ..services.amap import AmapClient
from ..services.weather import WeatherService
from .base import Skill

# 兴趣导向 -> 高德 POI 分类码（types）。用分类码而非关键词，避免「公园灌满」「餐厅混入景点」。
# 分类码说明（高德三级分类，传中类/小类码即可，多个用 | 分割）：
#   110101 公园 | 110103 植物园 | 110200 风景名胜(含 110201 世界遗产/110202 国家级景点/
#   110205 寺庙道观/110208 海滩/110209 观景点) | 110204 纪念馆
#   140100 博物馆 | 140200 展览馆 | 140400 美术馆 | 140600 科技馆 | 140700 天文馆 | 140800 文化宫
#   080501 游乐园/主题乐园 | 080600 影剧院(080601 电影院/080603 剧院) | 080401 度假村
PREFERENCE_TYPES: Dict[str, str] = {
    "人文历史": "140100|140200|140400|140600|140700|140800|110201|110204|110205",
    "自然风光": "110101|110103|110200|110208|110209",
    "娱乐": "080501|080600|080401",
    # 「美食」不产出景点，走独立的餐厅推荐（见下方 dining 检索），避免餐厅混入景点池
}

# 饮食禁忌 -> 餐厅搜索关键词（用于餐厅推荐时叠加检索，命中项会进入候选池）
DIET_KEYWORDS: Dict[str, str] = {
    "清真": "清真餐厅",
    "素食": "素食",
    "海鲜": "海鲜",
    # 「无辣」无直接可搜关键词，忽略（不影响候选池）
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


def _as_price(value: Any) -> Optional[float]:
    """把高德的 `biz_ext.cost` 安全地转成价格。

    ★ 这条是合并两条线时补回来的：原来两处都写的是

        price = _as_price(cost)

    而高德这个字段**不保证是数字** —— 实测会遇到空 list `[]`、
    字符串（如 `"暂无"`）、甚至一个 dict。`float([])` / `float("暂无")`
    会直接抛 TypeError / ValueError，而这两处都在 POI 转换的主干上，
    一抛整条 `/api/plan` 就 500，报的还是看不懂的类型错误。
    （组员那条线的 `_to_rating` 已经做了同样的防御，价格这里漏了。）
    """
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    if isinstance(value, str):
        try:
            f = float(value.strip())
        except ValueError:
            return None
        return f if f > 0 else None
    return None      # 空 list / dict / None 都算"拿不到价"


def _parse_location(loc: str) -> Location:
    """高德返回的 "lng,lat" 字符串 -> Location。"""
    lng, lat = loc.split(",")
    return Location(lat=float(lat), lng=float(lng))


def _to_poi(item: Dict[str, Any], poi_type: str = "景点") -> POI:
    """高德 POI 结果 -> 内部 POI 模型。"""
    biz_ext = item.get("biz_ext") or {}
    cost = biz_ext.get("cost")
    price = _as_price(cost)
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
    price = _as_price(cost)
    rating = item.get("rating") or biz_ext.get("rating")
    check_in = ""
    check_out = ""
    if kind == "餐厅":
        tier = _tier_cost(price)
        tips = f"人均约 ¥{price:.0f}" if price else "人均待查"
    else:  # 住宿
        tier = _tier_hotel(rating)
        # 高德无实时房价，按档次给每晚估算价，供预算估算与用户选定后重算
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


def _tiered(items: List[Dict[str, Any]], kind: str) -> List[POI]:
    """按价位分档，档内按评分降序，每档最多取 10 个，返回「经济→中档→高档」推荐列表。"""
    buckets: Dict[str, List[POI]] = {"经济": [], "中档": [], "高档": []}
    for item in items:
        poi = _to_recommendation(item, kind)
        buckets[poi.tier].append(poi)
    result: List[POI] = []
    for tier in ("经济", "中档", "高档"):
        ranked = sorted(
            buckets[tier],
            key=lambda p: p.rating if p.rating is not None else -1,
            reverse=True,
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

        # 先把目的地解析成高德可识别的区县/城市；否则「东山岛」这类景区名会让 city
        # 参数静默失效，导致关键词搜索返回全国结果（如「公园」搜出北京公园）。
        # city 为区县级（POI 搜索更聚焦），city_name 为城市级（知识库匹配用）。
        city, city_name = self.amap.resolve_region(pref.destination)

        # 1. 实时天气（多拉 3 天，覆盖 start_date 相对今天最多 3 天的偏移；
        #    高德 extensions=all 最多返回未来 4 天，超出则无法预报）
        ctx["weather"] = self.weather_svc.forecast(city, pref.duration_days + 3)

        # 2. 景点 POI（按兴趣分类码搜索，去重后按评分/热度排序）
        attractions: List[POI] = []
        seen: set[str] = set()
        for tag in pref.preferences:
            types = PREFERENCE_TYPES.get(tag, "")
            if not types:
                continue
            for item in self.amap.search_poi(types=types, city=city, offset=25):
                # 用高德 POI id 去重：同一地点在不同分类下可能返回不同名称，id 才是唯一键
                pid = item.get("id") or item.get("name", "")
                if pid and pid not in seen:
                    seen.add(pid)
                    attractions.append(_to_poi(item))

        # 按高德评分降序（无评分排最后）：让高分景点（海滩、热门景区）浮到前面，
        # 避免高德默认的「距市中心距离」顺序把冷门低分点顶上来。
        attractions.sort(key=lambda p: p.rating if p.rating is not None else -1, reverse=True)

        # 3. 餐饮 / 酒店 POI：多关键词 + 翻页扩大候选池，按评分排序 + 饮食禁忌叠加检索，
        #    供跨天轮换与「换一家」面板提供更丰富选择
        restaurant_items = _search_multi(self.amap, "餐厅", city, pages=2)
        seen_rids = {it.get("id") for it in restaurant_items}
        # 通用风味（小吃/本地菜）+「美食」兴趣 + 饮食禁忌：叠加针对性检索，
        # 既丰富种类，又贴合用户画像
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
        restaurants = [_to_poi(item, poi_type="餐厅") for item in restaurant_items]
        # 按高德评分降序：高分餐厅优先进规划，保证「综合评分」推荐
        restaurants.sort(key=lambda p: p.rating if p.rating is not None else -1, reverse=True)
        ctx["dining_options"] = _tiered(restaurant_items, "餐厅")

        # 酒店：除「酒店」外叠加「民宿/客栈」，翻页扩大候选池并去重
        hotel_items = _search_multi(self.amap, "酒店", city, pages=2)
        seen_hids = {it.get("id") for it in hotel_items}
        for kw, pages in (("民宿", 2), ("客栈", 1)):
            for item in _search_multi(self.amap, kw, city, pages=pages):
                if item.get("id") and item.get("id") not in seen_hids:
                    seen_hids.add(item.get("id"))
                    hotel_items.append(item)
        ctx["hotel_options"] = _tiered(hotel_items, "住宿")

        # 4. 特别想去的景点（必去）：优先复用已搜到的 POI，否则按名称单独搜索；
        #    解析失败用占位 POI（无坐标）保证仍出现在规划中
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
                        name=name, type="景点", location=Location(lat=0, lng=0), city=city,
                        tips="未能定位坐标，建议到地后地图搜索",
                    )
                )
        ctx["must_visit_pois"] = must_pois
        # 必去景点置顶，规划按顺序优先选取
        attractions = must_pois + [
            p for p in attractions if p.name not in {m.name for m in must_pois}
        ]

        # 5. 本地 RAG 知识（防坑 / 拍照 / 动线），按城市过滤避免串到别的目的地
        #
        # ★ 查询里**不再拼城市名**（合并两条线时把这一点带过来的）。
        # 城市过滤由 search(..., city=...) 自己做，而把城市名拼进查询反而会把
        # 低相关条目的分数拉高 —— 原来就是这么把杭州的贴士送进成都方案的
        # （实测："去成都玩"的贴士是「杭帮菜代表有西湖醋鱼、东坡肉、龙井虾仁」）。
        rag_query = " ".join(pref.preferences) or city_name
        ctx["rag_tips"] = self.retriever.search(rag_query, top_k=5, city=city_name)

        ctx["attractions"] = attractions
        # 景点备选池：完整去重后的景点列表（含必去），供前端编辑时「换景点」
        ctx["attraction_options"] = attractions
        ctx["restaurants"] = restaurants
        return ctx
