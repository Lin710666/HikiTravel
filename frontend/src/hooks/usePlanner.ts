import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  fetchMapConfig,
  fetchStaticMap,
  getPlan,
  health,
  listPlans,
  planByChat,
  planByForm,
  revisePlan,
  savePlan,
  type ApiErrorKind,
  type Health,
  type MapConfig,
  type PlanSummary,
  type StaticMapData,
} from '../api/client'
import type { TravelPlan } from '../types/plan'
import type { UserPreference } from '../types/preference'

/** 最近一次请求：重试与「采纳建议」都基于它重放，用户不用重填 */
type LastRequest =
  | { kind: 'form'; pref: UserPreference }
  | { kind: 'chat'; message: string; base?: Partial<UserPreference> }
  | { kind: 'revise'; message: string; plan: TravelPlan }

export interface PlannerError {
  message: string
  kind: ApiErrorKind
}

export function usePlanner(notify: (text: string) => void) {
  const [plan, setPlan] = useState<TravelPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<PlannerError | null>(null)
  const [env, setEnv] = useState<Health | null>(null)
  const [history, setHistory] = useState<PlanSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [mapData, setMapData] = useState<StaticMapData | null>(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapConfig, setMapConfig] = useState<MapConfig | null>(null)
  const [dirty, setDirty] = useState(false)

  const lastReqRef = useRef<LastRequest | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mapAbortRef = useRef<AbortController | null>(null)
  /** 交给 loadMap 判断要不要打静态图：交互地图可用时就不必再请求一次 */
  const mapConfigRef = useRef<MapConfig | null>(null)

  /* 生成中显示已等待时长：本地 7B 生成一整份要 1~2 分钟，用户需要知道没卡死 */
  useEffect(() => {
    if (!loading) {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    )
    return () => window.clearInterval(id)
  }, [loading])

  /* 连接自检：后端 / 本地大模型 / 高德密钥分别是什么状态 */
  const checkHealth = useCallback(async () => {
    try {
      setEnv(await health())
    } catch {
      setEnv(null)
    }
  }, [])

  useEffect(() => {
    void checkHealth()
  }, [checkHealth])

  /* 交互地图配置：一次就够，失败不阻断（退回静态图） */
  useEffect(() => {
    fetchMapConfig()
      .then((cfg) => {
        mapConfigRef.current = cfg
        setMapConfig(cfg)
      })
      .catch(() => setMapConfig({ enabled: false, key: '', security_code: '' }))
  }, [])

  /* 静态地图：Key 在后端，前端只拿 data URL 与图例 */
  const loadMap = useCallback(async (target: TravelPlan) => {
    // 已经有交互地图了，就没必要再花一次高德 Web服务 额度画静态图
    if (mapConfigRef.current?.enabled) return
    mapAbortRef.current?.abort()
    const controller = new AbortController()
    mapAbortRef.current = controller
    setMapLoading(true)
    setMapError(null)
    try {
      const data = await fetchStaticMap(target, controller.signal)
      if (controller.signal.aborted) return // 已被更新的请求取代，丢弃过期结果
      setMapData(data)
    } catch (e) {
      if (controller.signal.aborted) return // 被取代不算失败，别把新结果清掉
      // 地图只是辅助信息，失败不阻断行程展示；但原因要如实告诉用户：
      // 把「高德限流/网络失败」显示成「没配密钥」会让人往错误方向排查。
      setMapData(null)
      setMapError((e as Error).message || '地图获取失败')
    } finally {
      if (mapAbortRef.current === controller) setMapLoading(false)
    }
  }, [])

  const reloadMap = useCallback(() => {
    if (plan) void loadMap(plan)
  }, [loadMap, plan])

  const run = useCallback(
    async (req: LastRequest, applySuggestions = false) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      setError(null)
      try {
        const next =
          req.kind === 'form'
            ? await planByForm(req.pref, applySuggestions, controller.signal)
            : req.kind === 'chat'
              ? await planByChat(req.message, applySuggestions, req.base, controller.signal)
              : await revisePlan(req.message, req.plan, controller.signal)
        setPlan(next)
        setDirty(false)
        lastReqRef.current = req
        window.history.replaceState(null, '', `?plan=${next.plan_id}`)
        void loadMap(next)
      } catch (e) {
        const err = e as ApiError
        if (err.kind === 'aborted') {
          notify('已取消本次生成')
          return
        }
        setError({ message: err.message || '生成失败', kind: err.kind ?? 'network' })
      } finally {
        setLoading(false)
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    [loadMap, notify],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    setLoading(false)
  }, [])

  const retry = useCallback(() => {
    if (lastReqRef.current) void run(lastReqRef.current)
    else if (plan?.user_preference) {
      // 从历史打开的计划没有「本次请求」，但它自带画像，用画像重放即可
      void run({ kind: 'form', pref: plan.user_preference })
    } else notify('请先填写偏好，或输入一句话')
  }, [notify, plan, run])

  /** 采纳异常拦截建议：按原请求带 apply_suggestions 重放（后端只在用户明确同意后才改画像） */
  const applySuggestions = useCallback(() => {
    if (lastReqRef.current) {
      void run(lastReqRef.current, true)
      return
    }
    // 从历史打开的规划没有「本次请求」，改用规划自带画像重放
    const pref = plan?.user_preference
    if (pref) void run({ kind: 'form', pref }, true)
    else notify('这版规划没有保存画像，无法自动采纳建议')
  }, [notify, plan, run])

  const runForm = useCallback((pref: UserPreference) => run({ kind: 'form', pref }), [run])

  const runChat = useCallback(
    (message: string, base?: Partial<UserPreference>) =>
      run({ kind: 'chat', message, base }),
    [run],
  )

  const runRevise = useCallback(
    (message: string) => {
      if (!plan) return
      void run({ kind: 'revise', message, plan })
    },
    [plan, run],
  )

  /** 把某一版规划换成备选池里的另一家（走真实的对话式修改） */
  const swapOption = useCallback(
    (from: string, to: string) => {
      if (!plan) return
      // 用行程里的**具体名称**指代，不说「第 N 天的餐厅」这种笼统说法——
      // 一天可能有好几家餐厅，大模型只能猜，替换就会落到错的那家。
      void run({ kind: 'revise', message: `把「${from}」换成「${to}」，其余保持不变`, plan })
    },
    [plan, run],
  )

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      setHistory(await listPlans())
    } catch (e) {
      notify((e as Error).message || '获取历史计划失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [notify])

  /** 打开一版规划：兼容旧数据（可能缺新增字段），兜底避免渲染崩溃 */
  const openPlan = useCallback(
    async (id: string, silent = false) => {
      try {
        const p = await getPlan(id)
        const normalized: TravelPlan = {
          ...p,
          dining_options: p.dining_options || [],
          hotel_options: p.hotel_options || [],
          attraction_options: p.attraction_options || [],
          travelers: p.travelers || 1,
          conflicts: p.conflicts || [],
          daily_plans: (p.daily_plans || []).map((d) => ({
            ...d,
            hotel: d.hotel || null,
            tips: d.tips || [],
          })),
        }
        setPlan(normalized)
        setDirty(false)
        setError(null)
        window.history.replaceState(null, '', `?plan=${normalized.plan_id}`)
        void loadMap(normalized)
        if (!silent) notify('已打开历史计划')
      } catch (e) {
        if (!silent) setError({ message: (e as Error).message || '读取计划失败', kind: 'http' })
      }
    },
    [loadMap, notify],
  )

  /* 深链：?plan=<id> 可直接打开某一版规划（便于分享与核对） */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('plan')
    if (id) void openPlan(id, true)
  }, [openPlan])

  const save = useCallback(async () => {
    if (!plan) return
    try {
      await savePlan(plan)
      setDirty(false)
      notify('已保存')
    } catch (e) {
      notify((e as Error).message || '保存失败')
    }
  }, [notify, plan])

  const exportJson = useCallback(() => {
    if (!plan) return
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `travelplan-${plan.plan_id}.json`
    a.click()
    URL.revokeObjectURL(url)
    notify('已导出 JSON')
  }, [notify, plan])

  /** 本地编辑（移除某个安排）：改完置为待保存，由用户决定是否持久化 */
  const updatePlan = useCallback((updater: (p: TravelPlan) => TravelPlan) => {
    setPlan((cur) => (cur ? updater(cur) : cur))
    setDirty(true)
  }, [])

  return {
    plan,
    loading,
    elapsed,
    error,
    env,
    history,
    historyLoading,
    mapData,
    mapLoading,
    mapError,
    reloadMap,
    mapConfig,
    dirty,
    runForm,
    runChat,
    runRevise,
    swapOption,
    applySuggestions,
    cancel,
    retry,
    refreshHistory,
    openPlan,
    save,
    exportJson,
    updatePlan,
    checkHealth,
    clearError: () => setError(null),
  }
}

export type Planner = ReturnType<typeof usePlanner>
