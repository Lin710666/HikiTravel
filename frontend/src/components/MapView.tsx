import { useMemo, useState } from 'react'
import { Alert, Button, Card, Space, Tag } from 'antd'
import type { Location, POI, TravelPlan } from '../types/plan'
import { useAppJump, type AppTarget } from '../hooks/useAppJump'

const W = 640
const H = 400
const PAD = 36

// 收集规划中所有含有效坐标的 POI
function collectPoints(plan: TravelPlan): POI[] {
  const out: POI[] = []
  for (const d of plan.daily_plans) {
    for (const item of d.timeline) {
      const loc = item.poi.location
      if (loc.lat !== 0 && loc.lng !== 0) out.push(item.poi)
    }
  }
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

export default function MapView({ plan }: { plan: TravelPlan }) {
  const { jump, copyKeyword } = useAppJump()
  const [selected, setSelected] = useState<POI | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [manual, setManual] = useState<{ copyText: string; label: string } | null>(null)

  const points = useMemo(() => collectPoints(plan), [plan])
  const coords = useMemo(() => {
    if (!points.length) return []
    const projector = buildProjector(points.map((p) => p.location))
    return points.map((p) => projector(p.location))
  }, [points])

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

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(' ')

  return (
    <Card title="地图打点与轨迹" size="small">
      {!points.length ? (
        <Alert type="warning" message="暂无带坐标的打卡点" />
      ) : (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: '#eef3f7', borderRadius: 8 }}>
          <polyline
            points={polylinePoints}
            fill="none"
            stroke="#1677ff"
            strokeWidth="2"
            strokeDasharray="6 4"
          />
          {coords.map((c, i) => (
            <g key={i} onClick={() => setSelected(points[i])} style={{ cursor: 'pointer' }}>
              <circle cx={c.x} cy={c.y} r={i === 0 ? 9 : 7} fill={i === 0 ? '#52c41a' : '#1677ff'} />
              <text x={c.x + 11} y={c.y + 4} fontSize="11" fill="#333">
                {i + 1}. {points[i].name}
              </text>
            </g>
          ))}
        </svg>
      )}

      {selected && (
        <div style={{ marginTop: 12 }}>
          <Space>
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
