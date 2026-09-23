// 后端 API 封装
import type { UserPreference } from '../types/preference'
import type { TravelPlan } from '../types/plan'

const BASE = '/api'

// 本地 7B 大模型生成一份规划要 1~3 分钟，超时给足；超时后前端会提示重试
const PLAN_TIMEOUT_MS = 300_000
const SHORT_TIMEOUT_MS = 10_000

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'aborted'

/** 带类型的请求错误：前端据此决定提示文案与是否显示「重试 / 检查连接」 */
export class ApiError extends Error {
  kind: ApiErrorKind
  status?: number

  constructor(message: string, kind: ApiErrorKind, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

async function post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? PLAN_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false

  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort)

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new ApiError(
        (data as { detail?: string }).detail || `请求失败 (${res.status})`,
        'http',
        res.status,
      )
    }
    return (await res.json()) as T
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (timedOut) {
      throw new ApiError(
        `等待超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回，可能是本地大模型正在加载或已经断开。` +
          '请确认后端服务与 Ollama 仍在运行，然后重试。',
        'timeout',
      )
    }
    if (options.signal?.aborted) {
      throw new ApiError('已取消本次生成。', 'aborted')
    }
    throw new ApiError(
      '网络异常或后端已断开：请确认后端服务与本地大模型（Ollama）正在运行，然后重试。',
      'network',
    )
  } finally {
    window.clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

// 表单模式：提交结构化画像（目的地/天数/人数/兴趣/预算为必填，后端会显式校验并提示）
export function planByForm(
  pref: Partial<UserPreference>,
  applySuggestions = false,
  signal?: AbortSignal,
): Promise<TravelPlan> {
  return post<TravelPlan>(
    '/plan',
    { preference: pref, apply_suggestions: applySuggestions },
    { signal },
  )
}

// 对话模式：由大模型解析自然语言（未接入大模型时后端会明确返回 503 提示）
// base 为表单已填的部分画像，作为「底」提交：表单精确字段优先，对话只补缺
export function planByChat(
  message: string,
  applySuggestions = false,
  base?: Partial<UserPreference>,
  signal?: AbortSignal,
): Promise<TravelPlan> {
  return post<TravelPlan>(
    '/chat',
    {
      message,
      apply_suggestions: applySuggestions,
      preference: base && Object.keys(base).length > 0 ? base : undefined,
    },
    { signal },
  )
}

// 对话式修改：带着当前规划（里面存着生成时的画像）重新生成一版
// 例：「预算压到 2500」「第二天换成室内景点」「多玩一天」
export function revisePlan(
  message: string,
  plan: TravelPlan,
  signal?: AbortSignal,
): Promise<TravelPlan> {
  return post<TravelPlan>(
    '/plan/revise',
    { message, plan, apply_suggestions: false },
    { signal },
  )
}

export interface Health {
  status: string
  ollama_available: boolean
  amap_configured: boolean
}

// 地图图例：与高德静态地图上的编号标记一一对应
export interface MapLegendItem {
  label: string
  name: string
  type: string
  date: string
  time: string
  day_index: number
  color: string
}

export interface StaticMapData {
  /** 高德静态地图（真实底图 + 标记 + 每日轨迹），data URL 形式 */
  image: string
  legend: MapLegendItem[]
  zoom: number
  center: string
}

/** 取高德静态地图：后端代理请求（Key 不出现在浏览器），返回图片与图例 */
export function fetchStaticMap(
  plan: TravelPlan,
  signal?: AbortSignal,
): Promise<StaticMapData> {
  return post<StaticMapData>('/map/static', { plan }, { signal, timeoutMs: 30_000 })
}

/** 连接自检：后端在不在、Ollama 在不在、高德配没配 */
export async function health(): Promise<Health> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), SHORT_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}/health`, { signal: controller.signal })
    if (!res.ok) throw new ApiError(`健康检查失败 (${res.status})`, 'http', res.status)
    return (await res.json()) as Health
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError('连不上后端服务（/api/health 无响应），请确认后端已启动。', 'network')
  } finally {
    window.clearTimeout(timer)
  }
}

export interface PlanSummary {
  plan_id: string
  summary: string
  created_at: string
}

/** 目的地输入提示的一个候选 */
export interface PlaceTip {
  name: string
  district: string
  adcode: string
  kind: '行政区' | '地点'
  lat: number | null
  lng: number | null
}

/** 目的地输入提示：由后端代理高德，Key 不出现在浏览器 */
export async function autocompletePlaces(
  q: string,
  signal?: AbortSignal,
): Promise<PlaceTip[]> {
  const res = await fetch(`${BASE}/places/autocomplete?q=${encodeURIComponent(q)}`, { signal })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(
      (data as { detail?: string }).detail || `候选获取失败 (${res.status})`,
      'http',
      res.status,
    )
  }
  return res.json()
}

/** 交互地图（高德 JS API）的运行时配置。未配置时 enabled=false，前端退回静态地图 */
export interface MapConfig {
  enabled: boolean
  key: string
  security_code: string
}

export async function fetchMapConfig(signal?: AbortSignal): Promise<MapConfig> {
  const res = await fetch(`${BASE}/map/config`, { signal })
  if (!res.ok) throw new ApiError('获取地图配置失败', 'http', res.status)
  return res.json()
}

// 历史计划列表
export async function listPlans(): Promise<PlanSummary[]> {
  const res = await fetch(`${BASE}/plans`)
  if (!res.ok) throw new ApiError('获取历史计划失败', 'http', res.status)
  return res.json()
}

// 按 ID 读取一条历史计划
export async function getPlan(id: string): Promise<TravelPlan> {
  const res = await fetch(`${BASE}/plans/${id}`)
  if (!res.ok) throw new ApiError('读取计划失败', 'http', res.status)
  return res.json()
}

// 保存（覆盖）编辑后的规划，供下次从历史计划打开
export function savePlan(plan: TravelPlan): Promise<{ ok: boolean; plan_id?: string }> {
  return post('/plans/save', plan, { timeoutMs: SHORT_TIMEOUT_MS })
}
