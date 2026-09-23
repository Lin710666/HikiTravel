"""综合分计算：景点 / 餐厅 / 酒店 的推荐排序依据。

为什么不能只看评分：
- 景点：评分高的常常是小众好评点，真正值得去的热门大景点评分未必最高，
  所以要把「热门程度」和「评分」一起算。
- 餐厅 / 酒店：好不好不只看口碑，还要看「顺不顺路」——离前后两个景点越近，
  用户来回折腾的时间越少，体验越好。

公式（权重集中在本模块顶部，便于调参）：
- 景点综合分     = 距上一景点 × ATTRACTION_DIST_WEIGHT + 热门程度分 × ATTRACTION_HOT_WEIGHT
                   + 评分 × ATTRACTION_RATING_WEIGHT
- 餐厅/酒店综合分 = 距上一景点 × OPTION_PREV_WEIGHT + 距下一景点 × OPTION_NEXT_WEIGHT
                   + 评分 × OPTION_RATING_WEIGHT

细节说明：
- 距离项先用 proximity(km) = 1 / (1 + km) 转成「顺路分」（越近越高，落在 0~1），
  再乘权重。没有坐标的点（占位数据）不参与距离项，权重在剩余项之间自动重新分配。
- 评分统一归一化为 rating / 5；高德未给评分时该项不参与，避免"没评分"被当成"评分 0"
  而误伤冷门但优质的点。
- 热门程度分按「高德 weight 字段 → 照片数 → 跨分类命中次数」逐级取用，
  最后按本轮候选池的最大值归一化到 0~1。
"""
import math
from typing import Any, Dict, List, Optional

from ..models.plan import Location, POI

# ---- 景点综合分权重 ----
# 距离项：推荐下一个景点时，优先顺路的，避免把行程排成折返跑
ATTRACTION_DIST_WEIGHT = 0.3
ATTRACTION_HOT_WEIGHT = 0.4
ATTRACTION_RATING_WEIGHT = 0.3

# ---- 餐厅 / 酒店综合分权重（两项距离合计 0.6，评分 0.4）----
OPTION_PREV_WEIGHT = 0.3
OPTION_NEXT_WEIGHT = 0.3
OPTION_RATING_WEIGHT = 0.4

# ---- 酒店综合分权重（先定酒店、再排路线：既看当天活动区，也看次日活动区）----
HOTEL_RATING_WEIGHT = 0.4
HOTEL_GROUP_WEIGHT = 0.3
HOTEL_NEXT_GROUP_WEIGHT = 0.3


def haversine(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    """两点球面距离（公里）。"""
    r = 6371.0
    lat1, lng1 = math.radians(a_lat), math.radians(a_lng)
    lat2, lng2 = math.radians(b_lat), math.radians(b_lng)
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


def proximity(km: float) -> float:
    """距离 → 顺路分（0~1）：越近越接近 1。"""
    return 1.0 / (1.0 + max(km, 0.0))


def _as_float(value: Any) -> Optional[float]:
    """把可能是字符串 / 空 list 的字段安全转成 float，转不了返回 None。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalized_rating(rating: Any) -> Optional[float]:
    """评分 → 0~1。无评分返回 None（表示该项不参与加权）。"""
    r = _as_float(rating)
    if r is None or r <= 0:
        return None
    return min(r / 5.0, 1.0)


def has_location(poi: POI) -> bool:
    """POI 是否有有效坐标（占位数据是 0,0）。"""
    return not (poi.location.lat == 0 and poi.location.lng == 0)


def distance_km(a: POI, b: POI) -> Optional[float]:
    """两个 POI 的直线距离（公里）；任一缺坐标返回 None。"""
    if not has_location(a) or not has_location(b):
        return None
    return haversine(a.location.lat, a.location.lng, b.location.lat, b.location.lng)


def popularity_raw(item: Dict[str, Any], hits: int = 1) -> float:
    """热门程度原始分（未归一）。

    取值优先级：
    1. 高德 POI 自带的 weight 字段（若接口返回）——最直接的热度信号；
    2. 照片数量——热门点通常有更多实拍图；
    3. 跨分类命中次数——同一个点被多个兴趣分类搜到，说明它在多个主题里都排得上号。
    """
    weight = _as_float(item.get("weight"))
    if weight is not None and weight > 0:
        return weight
    photos = item.get("photos")
    if isinstance(photos, list) and photos:
        return float(len(photos))
    return float(max(hits - 1, 0))


def hotness(item: Dict[str, Any], hits: int, max_raw: float) -> float:
    """热门程度分（0~1）。"""
    if max_raw <= 0:
        return 0.0
    return min(popularity_raw(item, hits) / max_raw, 1.0)


def item_location(item: Dict[str, Any]) -> Optional[Location]:
    """高德 POI 的 "lng,lat" 字段 -> Location；解析不出来返回 None。"""
    loc = item.get("location")
    if not isinstance(loc, str) or "," not in loc:
        return None
    lng, lat = loc.split(",", 1)
    try:
        return Location(lat=float(lat), lng=float(lng))
    except ValueError:
        return None


def attraction_score(
    item: Dict[str, Any],
    hits: int,
    max_raw: float,
    prev_location: Optional[Location] = None,
) -> float:
    """景点综合分 = 距上一景点 × 权重 + 热门程度分 × 权重 + 评分 × 权重。

    prev_location 是「上一个已选中的景点」：推荐第一个点时没有上一站，
    距离项不参与（权重在热门与评分之间重新分配），所以不会因为缺坐标被判 0 分。
    高德没给评分时同理，权重自动落到其余项上。
    """
    terms: List[tuple[float, float]] = []
    if prev_location is not None:
        loc = item_location(item)
        if loc is not None and not (loc.lat == 0 and loc.lng == 0):
            d = haversine(loc.lat, loc.lng, prev_location.lat, prev_location.lng)
            terms.append((proximity(d), ATTRACTION_DIST_WEIGHT))
    terms.append((hotness(item, hits, max_raw), ATTRACTION_HOT_WEIGHT))
    rating = normalized_rating((item.get("biz_ext") or {}).get("rating"))
    if rating is not None:
        terms.append((rating, ATTRACTION_RATING_WEIGHT))
    total_weight = sum(w for _, w in terms)
    return sum(v * w for v, w in terms) / total_weight if total_weight else 0.0


def order_attractions(
    pool: List[Dict[str, Any]], hit_counts: Dict[str, int], max_raw: float
) -> List[Dict[str, Any]]:
    """按综合分贪心排出一条「顺路的候选链」。

    做法：先选出综合分最高（热门 + 评分，且没有上一站）的作为第一站，
    之后每一次都在剩下的点里选「离上一站近 + 本身热门 + 评分高」综合分最高的，
    于是候选项按地理位置自然串成一条链，而不是按热度把全城最热但相隔很远的点
    排在最前面。Planner 每日内部的重排也基于同一套距离逻辑。
    """
    remaining = list(pool)
    ordered: List[Dict[str, Any]] = []
    prev_location: Optional[Location] = None
    while remaining:
        best = max(
            remaining,
            key=lambda it: attraction_score(
                it,
                hit_counts.get(it.get("id") or it.get("name", ""), 1),
                max_raw,
                prev_location,
            ),
        )
        remaining.remove(best)
        ordered.append(best)
        prev_location = item_location(best)
    return ordered


def option_score(
    poi: POI,
    prev_poi: Optional[POI],
    next_poi: Optional[POI],
) -> float:
    """餐厅 / 酒店综合分 = 距上一景点 × 权重 + 距下一景点 × 权重 + 评分 × 权重。

    prev_poi / next_poi 为该点在行程中的前后邻居（可能为空）。
    缺坐标或没有邻居时，对应项不参与，权重在剩余项之间重新分配，
    保证任何数据条件下都能给出可比的分值。
    """
    terms: List[tuple[float, float]] = []

    if prev_poi is not None:
        d = distance_km(poi, prev_poi)
        if d is not None:
            terms.append((proximity(d), OPTION_PREV_WEIGHT))
    if next_poi is not None:
        d = distance_km(poi, next_poi)
        if d is not None:
            terms.append((proximity(d), OPTION_NEXT_WEIGHT))

    rating = normalized_rating(poi.rating)
    if rating is not None:
        terms.append((rating, OPTION_RATING_WEIGHT))

    if not terms:
        return 0.0
    total_weight = sum(w for _, w in terms)
    return sum(value * weight for value, weight in terms) / total_weight


def group_center(pois: List[POI]) -> Optional[Location]:
    """一组景点的地理中心（简单取经纬度平均）；都没有坐标时返回 None。"""
    points = [p.location for p in pois if has_location(p)]
    if not points:
        return None
    return Location(
        lat=sum(p.lat for p in points) / len(points),
        lng=sum(p.lng for p in points) / len(points),
    )


def hotel_score(
    hotel: POI,
    group: List[POI],
    next_group: Optional[List[POI]] = None,
) -> float:
    """酒店综合分 = 评分 × 权重 + 离当天活动区中心 × 权重 + 离次日活动区中心 × 权重。

    先定酒店、再排路线的好处：酒店既是当天的落脚点，也是次日出发的起点，
    把它放在当天与次日活动区之间，路线天然不容易折返。
    """
    terms: List[tuple[float, float]] = []
    rating = normalized_rating(hotel.rating)
    if rating is not None:
        terms.append((rating, HOTEL_RATING_WEIGHT))

    if has_location(hotel):
        center = group_center(group)
        if center is not None:
            terms.append(
                (
                    proximity(haversine(hotel.location.lat, hotel.location.lng, center.lat, center.lng)),
                    HOTEL_GROUP_WEIGHT,
                )
            )
        if next_group:
            next_center = group_center(next_group)
            if next_center is not None:
                terms.append(
                    (
                        proximity(
                            haversine(
                                hotel.location.lat,
                                hotel.location.lng,
                                next_center.lat,
                                next_center.lng,
                            )
                        ),
                        HOTEL_NEXT_GROUP_WEIGHT,
                    )
                )
    if not terms:
        return 0.0
    total_weight = sum(w for _, w in terms)
    return sum(value * weight for value, weight in terms) / total_weight

