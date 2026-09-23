// 用户画像输入模型（与后端 app/models/preference.py 对齐）

export type Pace = '悠闲' | '适中' | '特种兵'
export type Transportation = '自驾' | '高铁' | '飞机' | '本地'

export interface Travelers {
  adults: number
  children: number
  elderly: number
}

export interface UserPreference {
  travelers: Travelers
  duration_days: number
  destination: string
  // 从下拉里选定具体地点时带上高德 adcode：它是高德的主键，
  // 后端按它解析，不受「省+地名」写法影响，也没有同名歧义
  destination_adcode: string
  transportation: Transportation
  preferences: string[]
  must_visit: string[]
  pace: Pace
  budget: number
  dietary_restrictions: string[]
  avoidances: string[]
  start_date: string
  departure_time: string
  return_hotel_time: string
}
