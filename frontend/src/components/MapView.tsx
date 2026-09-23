/**
 * MapView —— 行程地图
 *
 * 主路径：把当前规划发给后端 /api/map/static，由后端代理高德「静态地图」接口，
 * 返回**真实底图**（路网/水域/地名）+ 编号标记 + 每天一条彩色轨迹。
 * 用 Web 服务 Key 即可，不需要「Web端(JS API)」Key，也不会把 Key 暴露到浏览器。
 *
 * 兜底：高德取图失败（未配 Key / 额度超限 / 网络问题）时退化为原来的 SVG 示意图，
 * 并明确告诉用户为什么，不让页面变成一片空白。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Space, Spin, Tag } from 'antd'
import type { Location, POI, TravelPlan } from '../types/plan'
import { fetchStaticMap, type StaticMapData } from '../api/client'
import { useAppJump, type AppTarget } from '../hooks/useAppJump'

const W = 640
const H = 400
const PAD = 36

// 收集规划中所有含有效坐标的 POI
function collectPoints(plan: TravelPlan): POI[] {
  const out: POI[] = []
  const seen = new Set<string>()
  const push = (p: POI) => {
    if (p.location.lat === 0 && p.location.lng === 0) return
    const key = `${p.name}@${p.location.lat},${p.location.lng}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(p)
  }
  // 先排行程 POI（保持首点为起点），再排每晚酒店
  for (const d of plan.daily_plans) for (const item of d.timeline) push(item.poi)
  for (const d of plan.daily_plans) if (d.hotel) push(d.hotel)
  return out
}

// 经纬度 -> SVG 画布坐标（简单等距投影，足够展示相对位置与轨迹）
function buildProjector(pts: Location[]) {
  const lats = pts.map((p) => p.lat)
  const lngs = pts.map((p) => p.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const latSpan = maxLat - minLat || 0.01
  const lngSpan = maxLng - minLng || 0.01
  return (p: Location) => ({
    x: ((p.lng - minLng) / lngSpan) * (W - 2 * PAD) + PAD,
    y: (1 - (p.lat - minLat) / latSpan) * (H - 2 * PAD) + PAD,
  })
}

const JUMP_ACTIONS: { target: AppTarget; label: string }[] = [
  { target: 'navigation', label: '导航' },
  { target: 'dianping', label: '大众点评' },
  { target: 'booking', label: '携程' },
]

// 高德取图失败时的兜底示意图
function SvgFallback({ points }: { points: POI[] }) {
  const coords = useMemo(() => {
    if (!points.length) return []
    const projector = buildProjector(points.map((p) => p.location))
    return points.map((p) => projector(p.location))
  }, [points])
  if (!points.length) return <Alert type="warning" message="暂无带坐标的打卡点" />
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: '#eef3f7', borderRadius: 8 }}>
      <polyline
        points={coords.map((c) => `${c.x},${c.y}`).join(' ')}
        fill="none"
        stroke="#1677ff"
        strokeWidth="2"
        strokeDasharray="6 4"
      />
      {coords.map((c, i) => (
        <g key={i}>
          <circle cx={c.x} cy={c.y} r={i === 0 ? 9 : 7} fill={i === 0 ? '#52c41a' : '#1677ff'} />
          <text x={c.x + 11} y={c.y + 4} fontSize="11" fill="#333">
            {i + 1}. {points[i].name}
          </text>
        </g>
      ))}
    </svg>
  )
}

export default function MapView({ plan }: { plan: TravelPlan }) {
  const { jump, copyKeyword } = useAppJump()
  const [selected, setSelected] = useState<POI | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [manual, setManual] = useState<{ copyText: string; label: string } | null>(null)
  const [mapData, setMapData] = useState<StaticMapData | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const points = useMemo(() => collectPoints(plan), [plan])
  // 只在"点位集合"变化时才重新取图：编辑预算之类不影响地图，避免白刷高德额度
  const signature = useMemo(
    () => points.map((p) => `${p.name}@${p.location.lat},${p.location.lng}`).join('|'),
    [points],
  )
  const planRef = useRef(plan)
  planRef.current = plan

  useEffect(() => {
    if (!signature) {
      setMapData(null)
      setMapError(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    // 防抖：用户连续编辑行程时不要每次都请求高德
    const timer = window.setTimeout(() => {
      setMapLoading(true)
      setMapError(null)
      fetchStaticMap(planRef.current, controller.signal)
        .then((data) => {
          if (!cancelled) setMapData(data)
        })
        .catch((e: unknown) => {
          if (cancelled) return
          setMapData(null)
          setMapError(e instanceof Error ? e.message : '地图获取失败')
        })
        .finally(() => {
          if (!cancelled) setMapLoading(false)
        })
    }, 700)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [signature, reloadKey])

  const handleJump = async (target: AppTarget, poi: POI, label: string) => {
    setNotice(null)
    setManual(null)
    const res = await jump(target, { name: poi.name, lat: poi.location.lat, lng: poi.location.lng })
    if (res.needManual && res.copyText) {
      setManual({ copyText: res.copyText, label })
      setNotice(res.message)
    } else {
      setNotice(res.message)
    }
  }

  const handleCopy = async () => {
    if (!manual) return
    await copyKeyword(JUMP_ACTIONS.find((a) => a.label === manual.label)!.target, {
      name: manual.copyText,
      lat: 0,
      lng: 0,
    })
    setNotice('口令已复制，请打开对应 App 搜索')
  }

  const dayColors = mapData?.legend ?? []

  return (
    <Card
      title="行程地图（高德）"
      size="small"
      extra={
        <Space>
          {mapLoading && <Spin size="small" />}
          <Button size="small" onClick={() => setReloadKey((v) => v + 1)}>
            刷新地图
          </Button>
        </Space>
      }
    >
      {mapData ? (
        <img
          src={mapData.image}
          alt="行程地图"
          style={{ width: '100%', borderRadius: 8, border: '1px solid #eee' }}
        />
      ) : mapError ? (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message="高德地图暂时取不到，先用示意图代替"
            description={`原因：${mapError}。确认 backend/.env 里的 AMAP_API_KEY 可用后，点右上角「刷新地图」重试。`}
          />
          <SvgFallback points={points} />
        </>
      ) : mapLoading ? (
        <div style={{ padding: 28, textAlign: 'center' }}>
          <Spin />
          <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>正在从高德获取地图…</div>
        </div>
      ) : (
        <SvgFallback points={points} />
      )}

      {/* 图例：编号、颜色与地图上的标记一一对应；点一行可看该点的跳转入口 */}
      {mapData && mapData.legend.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {mapData.legend.map((item) => {
            const poi = points.find((p) => p.name === item.name)
            const color = `#${item.color.slice(2)}`
            return (
              <div
                key={`${item.label}-${item.name}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  padding: '3px 0',
                  borderBottom: '1px dashed #f0f0f0',
                }}
              >
                <span
                  style={{
                    background: color,
                    color: '#fff',
                    borderRadius: '50%',
                    width: 20,
                    height: 20,
                    lineHeight: '20px',
                    textAlign: 'center',
                    fontSize: 12,
                    flex: '0 0 auto',
                  }}
                >
                  {item.label}
                </span>
                <span style={{ fontWeight: 600 }}>{item.name}</span>
                <Tag>{item.type}</Tag>
                <span style={{ color: '#888', fontSize: 12 }}>
                  {item.date}　{item.time}
                </span>
                {poi && (
                  <Button size="small" onClick={() => setSelected(poi)}>
                    跳转
                  </Button>
                )}
              </div>
            )
          })}
          {dayColors.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
              颜色区分天数：每天一条轨迹（第 1 天蓝、第 2 天绿、第 3 天橙……），编号与图上标记一致。
              {points.length > dayColors.length &&
                `　地图最多标注 ${dayColors.length} 个点（高德限制），其余见上方时间轴。`}
            </div>
          )}
        </div>
      )}

      {selected && (
        <div style={{ marginTop: 12 }}>
          <Space wrap>
            <Tag color="blue">{selected.name}</Tag>
            {JUMP_ACTIONS.map((a) => (
              <Button
                key={a.target}
                size="small"
                onClick={() => handleJump(a.target, selected, a.label)}
              >
                {a.label}
              </Button>
            ))}
          </Space>
        </div>
      )}

      {notice && (
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          message={notice}
          action={
            manual ? (
              <Button size="small" onClick={handleCopy}>
                复制口令
              </Button>
            ) : undefined
          }
        />
      )}
    </Card>
  )
}
