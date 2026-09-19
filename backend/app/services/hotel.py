"""酒店服务：周边酒店搜索 + 可插拔价格 Provider。

现实约束说明：
- 高德等免费开放平台可返回酒店 POI（名称/位置/评分/电话），但不提供实时房价。
- 实时房价需接入 OTA（携程/美团/飞猪）的商家开放接口，需企业资质、不免费开放。
- 因此这里抽象出 HotelPriceProvider 接口：默认用高德返回酒店列表，
  未来拿到 OTA 密钥后，实现该接口即可无缝接入实时房价。
"""
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from .amap import AmapClient


class HotelPriceProvider(ABC):
    """酒店价格数据源抽象接口。"""

    @abstractmethod
    def list_hotels(self, location: str, radius: int = 3000) -> List[Dict[str, Any]]:
        """返回周边酒店列表。实现方负责填充实时房价字段。

        location 形如 "lng,lat"。
        """


class AmapHotelProvider(HotelPriceProvider):
    """默认实现：高德周边搜索返回酒店列表（无实时房价）。

    每条结果的价格字段为 None，前端展示「以平台实时为准」，
    并通过「一键预订」跳转到对应 App 查看实时价。
    """

    def __init__(self, client: Optional[AmapClient] = None):
        self.client = client or AmapClient()

    def list_hotels(self, location: str, radius: int = 3000) -> List[Dict[str, Any]]:
        return self.client.search_around(location, keywords="酒店", radius=radius)


class HotelService:
    """酒店服务：组合价格 Provider，向上层屏蔽数据源差异。"""

    def __init__(self, provider: Optional[HotelPriceProvider] = None):
        self.provider = provider or AmapHotelProvider()

    def nearby(self, location: str, radius: int = 3000) -> List[Dict[str, Any]]:
        """查询周边酒店。"""
        return self.provider.list_hotels(location, radius=radius)
