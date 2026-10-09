import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import TopBar from './components/TopBar'
import LeftRail from './components/LeftRail'
import WorkColumn from './components/WorkColumn'
import MapPane from './components/MapPane'
import Toasts from './components/Toasts'
import { usePlanner } from './hooks/usePlanner'
import { useToasts } from './hooks/useToasts'

type Theme = 'light' | 'dark'

export default function App() {
  const { toasts, notify } = useToasts()
  const planner = usePlanner(notify)
  /* 当前查看的是第几天：中栏的日期切换与右栏的「替换第 N 天」共用 */
  const [day, setDay] = useState(0)
  /* 地图联动：左侧点中的行程项（地图点序号），null 表示未选中 */
  const [focus, setFocus] = useState<string | null>(null)

  /* 外观：跟随系统；用户手动切过才记住。
     键名用站点统一的 pf-theme：门户(hub.html)、海报生成、行程规划三处共用同一个键，
     所以在门户切了深色，进这里就是深色，不用各切一次。
     tp-theme 是这一页以前用的键，仍然读、也仍然写，免得老用户的选择白丢。 */
  const [theme, setTheme] = useState<Theme>(() => {
    let saved: string | null = null
    try {
      saved = window.localStorage.getItem('pf-theme') || window.localStorage.getItem('tp-theme')
    } catch { /* 隐私模式读不到，退回系统偏好 */ }
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  /* 别的标签页切了主题（门户 / 海报页）时，这一页跟着变。
     storage 事件只在**其它**标签页写入时触发，正好是我们要的语义。 */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'pf-theme' && e.key !== 'tp-theme') return
      if (e.newValue === 'light' || e.newValue === 'dark') setTheme(e.newValue as Theme)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  /* 用户没手动选过时，系统主题一变就跟着变（Windows 的自动日夜切换）。
     注意这里判断的是"有没有手动选过"，而不是"localStorage 里有没有值"，
     所以自动推导出来的主题**绝不能**写回 localStorage，否则一动页面就不再跟随系统
     （原来每次挂载都写一次，等于"跟随系统"只用得上第一次）。 */
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq || !mq.addEventListener) return
    const onSys = (ev: MediaQueryListEvent) => {
      try {
        if (window.localStorage.getItem('pf-theme') || window.localStorage.getItem('tp-theme')) return
      } catch { /* 读不到就当没手动选过 */ }
      setTheme(ev.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', onSys)
    return () => mq.removeEventListener('change', onSys)
  }, [])

  /* 换了一版规划就回到第 1 天，避免停在上一个行程的「第 3 天」 */
  const planId = planner.plan?.plan_id
  useEffect(() => {
    setDay(0)
    setFocus(null)
  }, [planId])

  /* ---------------------------------------------------------------- 三栏拖宽
     左右两条分隔条可以拖动，改左右栏的宽度。

     宽度只存在内存里（刷新回默认）， 和悬浮球那套规则一致：
     免得哪天被拖成一个奇怪的比例，又找不回来。

     拖动时用 window 上的 pointermove 而不是 setPointerCapture：
     拖到栏外面（甚至拖出窗口）也要跟手，capture 在跨元素时反而容易断。 */
  const shellRef = useRef<HTMLDivElement>(null)
  const [railW, setRailW] = useState<number | null>(null)
  const [mapW, setMapW] = useState<number | null>(null)

  const RAIL_MIN = 220, RAIL_MAX = 560
  const MAP_MIN = 300, MAP_MAX = 900
  const CENTER_MIN = 420            // 中栏至少留这么宽，否则版式会挤成一团

  const startGutter = useCallback(
    (side: 'rail' | 'map') => (e: ReactPointerEvent<HTMLDivElement>) => {
      const shell = shellRef.current
      if (!shell || shell.children.length < 3) return
      e.preventDefault()
      const railEl = shell.children[0] as HTMLElement
      const mapEl = shell.children[shell.children.length - 1] as HTMLElement
      const startX = e.clientX
      const startRail = railEl.getBoundingClientRect().width
      const startMap = mapEl.getBoundingClientRect().width

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const total = window.innerWidth
        if (side === 'rail') {
          const max = Math.min(RAIL_MAX, total - startMap - CENTER_MIN)
          setRailW(Math.max(RAIL_MIN, Math.min(max, startRail + dx)))
        } else {
          // 右栏往左拖是变宽，所以是减 dx
          const max = Math.min(MAP_MAX, total - startRail - CENTER_MIN)
          setMapW(Math.max(MAP_MIN, Math.min(max, startMap - dx)))
        }
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [],
  )

  /* 手动切换：**只有这一条路径**写 localStorage。
     写进去就等于"用户表态了"，从此不再跟随系统；自动推导的值一律不写。 */
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark'
      try {
        window.localStorage.setItem('pf-theme', next)
        window.localStorage.setItem('tp-theme', next)
      } catch { /* 存不了也能切，只是下次要再点一次 */ }
      return next
    })
  }, [])

  return (
    <>
      {/* 应用外壳：顶栏 + 三栏，各栏独立滚动（仿 Wanderlog） */}
      <div className="app">
        <TopBar
          title={planner.plan?.summary ?? null}
          status="已保存"
          hasPlan={Boolean(planner.plan)}
          dirty={planner.dirty}
          theme={theme}
          onToggleTheme={toggleTheme}
          onSave={planner.save}
          onExport={planner.exportJson}
        />

        {/* 三栏 + 两条可拖动的分隔条（拖它会改左右栏宽度） */}
        <div
          className="shell"
          ref={shellRef}
          style={{
            ...(railW !== null ? { '--rail-w': `${railW}px` } : {}),
            ...(mapW !== null ? { '--map-w': `${mapW}px` } : {}),
          } as CSSProperties}
        >
          <LeftRail planner={planner} notify={notify} />
          <div
            className="gutter"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整左栏宽度"
            onPointerDown={startGutter('rail')}
          />
          <WorkColumn
            planner={planner}
            notify={notify}
            day={day}
            setDay={setDay}
            focus={focus}
            setFocus={setFocus}
          />
          <div
            className="gutter"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整右栏宽度"
            onPointerDown={startGutter('map')}
          />
          <MapPane planner={planner} day={day} theme={theme} focus={focus} />
        </div>
      </div>

      <Toasts toasts={toasts} />
    </>
  )
}
