"""路线体检与优化（纯确定性计算，不调用大模型）。

为什么这部分不交给大模型：距离、折返、顺序这些都是可以用真实坐标算准的，
让模型去"感觉"路线顺不顺反而容易误报。所以分工是：
- 代码：算距离、找折返、按最近邻重排顺序（秒级、可复现）；
- 大模型：判断"这样排合不合理、有没有更好的取舍"（见 check_skill 的审查提示词）。

体检看三件事（都用高德返回的真实坐标算直线距离）：
1. 同一天的总移动距离；
2. 是否折返：A→B→C 中 C 明显比 B 更靠近 A，说明多跑了冤枉路；
3. 是否有单段超长距离（例如 25 公里以上），通常意味着这两个点不该塞在同一天。

优化：以当天起点（前一晚住的酒店）为基准，用最近邻顺序重排当天景点。
"""
import math
from typing import Any, Dict, List, Optional, Tuple

from ..models.plan import POI
from .scoring import distance_km

#: 单段超过这个距离（公里）就算"长距离挪动"，值得提醒用户
LONG_LEG_KM = 25.0
#: 折返判定：多绕出来的距离超过这个数（公里）才算浪费
DETOUR_KM = 3.0


def leg_distances(pois: List[POI]) -> List[Optional[float]]:
    """相邻两点的直线距离（公里）；缺坐标的那段返回 None。"""
    return [distance_km(pois[i], pois[i + 1]) for i in range(len(pois) - 1)]


def total_distance_km(pois: List[POI]) -> float:
    """一串点的总移动距离（公里），缺坐标的段按 0 计。"""
    return round(sum(d for d in leg_distances(pois) if d is not None), 1)


def long_legs(
    pois: List[POI], threshold_km: float = LONG_LEG_KM
) -> List[Tuple[str, str, float]]:
    """找出超过阈值的单段移动，返回 [(起点, 终点, 公里)]。"""
    found: List[Tuple[str, str, float]] = []
    for i, d in enumerate(leg_distances(pois)):
        if d is not None and d >= threshold_km:
            found.append((pois[i].name, pois[i + 1].name, round(d, 1)))
    return found


def backtracks(
    pois: List[POI], detour_km: float = DETOUR_KM
) -> List[Tuple[str, str, str, float]]:
    """找出折返：A→B→C 里多绕的距离超过阈值。

    返回 [(A, B, C, 多绕公里数)]。判定用「实走 - 直达」：
    dist(A,B) + dist(B,C) - dist(A,C) > 阈值，说明 B 是白跑的一趟。
    """
    found: List[Tuple[str, str, str, float]] = []
    for i in range(len(pois) - 2):
        a, b, c = pois[i], pois[i + 1], pois[i + 2]
        ab, bc, ac = distance_km(a, b), distance_km(b, c), distance_km(a, c)
        if ab is None or bc is None or ac is None:
            continue
        extra = ab + bc - ac
        if extra > detour_km:
            found.append((a.name, b.name, c.name, round(extra, 1)))
    return found


def order_nearest(pois: List[POI], start: Optional[POI] = None) -> List[POI]:
    """按最近邻重排：从起点（缺省用第一个点）出发，每次去离当前位置最近的点。

    坐标缺失的点排不出来，会保持原有相对顺序被放到最后处理。
    """
    remaining = list(pois)
    ordered: List[POI] = []
    current = start
    while remaining:
        if current is None:
            chosen = remaining.pop(0)
        else:
            def _distance_to_current(poi: POI) -> float:
                d = distance_km(current, poi)
                return d if d is not None else float("inf")

            chosen = min(remaining, key=_distance_to_current)
            remaining.remove(chosen)
        ordered.append(chosen)
        current = chosen
    return ordered


def day_route_stats(pois: List[POI]) -> Dict[str, Any]:
    """单日路线体检结果。"""
    return {
        "total_km": total_distance_km(pois),
        "long_legs": long_legs(pois),
        "backtracks": backtracks(pois),
    }


def cluster_into_days(
    pois: List[POI],
    days: int,
    per_day: int,
    must_names: Optional[set] = None,
) -> List[List[POI]]:
    """把景点按地理邻近分成 days 组（每天一区），每组最多 per_day 个。

    为什么先分区、再定酒店：如果先让模型"分天"，它可能把城东和城西的点排进同一天，
    之后再怎么排序都会有折返。按地理邻近聚成区之后，同一天的景点天然在同一片区域，
    酒店也能选在该区中间，路线就不会来回跑。

    做法是贪心：必去景点优先当"种子"（保证它所在的区一定成团），
    其余天用剩余点里评分最高的当种子，然后每次把离该区最近的点收进来。
    """
    must = must_names or set()
    remaining = list(pois)
    groups: List[List[POI]] = []
    seeds: List[POI] = []
    # 每天的目标数量：既不超过节奏上限，也尽量把景点平均分到每天，
    # 避免出现"第一天 4 个、第三天 0 个"这种头重脚轻
    target = min(per_day, max(1, math.ceil(len(remaining) / days))) if remaining else 0

    # 必去景点优先成为每天的种子（必去数量多于天数时就按顺序分到已开的区里）
    for poi in list(remaining):
        if poi.name in must and len(seeds) < days:
            seeds.append(poi)
            remaining.remove(poi)

    for i in range(days):
        if not remaining and not seeds:
            break
        if seeds:
            seed = seeds.pop(0)
        else:
            seed = max(remaining, key=lambda p: p.rating or 0)
            remaining.remove(seed)
        group = [seed]
        while remaining and len(group) < target:
            def _dist_to_group(poi: POI) -> float:
                distances = [
                    d for d in (distance_km(poi, g) for g in group) if d is not None
                ]
                return min(distances) if distances else float("inf")

            nxt = min(remaining, key=_dist_to_group)
            group.append(nxt)
            remaining.remove(nxt)
        groups.append(group)

    # 剩下的点（必去景点或"目标数量"取整的余数）塞进最近且没满的那天
    for extra in list(remaining):
        if not groups:
            break
        room = [i for i in range(len(groups)) if len(groups[i]) < per_day]
        if not room:
            break

        def _nearest_in_group(index: int) -> float:
            distances = [
                d for d in (distance_km(extra, g) for g in groups[index]) if d is not None
            ]
            return min(distances) if distances else float("inf")

        groups[min(room, key=_nearest_in_group)].append(extra)
        remaining.remove(extra)
    return groups
