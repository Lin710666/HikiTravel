// 用户画像输入模型（与后端 app/models/preference.py 对齐）

export type Pace = '悠闲' | '适中' | '特种兵'
export type Transportation = '自驾' | '高铁' | '飞机' | '本地'
export type Priority = '吃' | '住' | '行' | '玩'

export interface Travelers {
  adults: number
  children: number
  elderly: number
}

export interface UserPreference {
  travelers: Travelers
  duration_days: number
  origin: string
  destination: string
  transportation: Transportation
  preferences: string[]
  must_visit: string[]
  pace: Pace
  has_pet: boolean
  budget: number
  priority: Priority
  dietary_restrictions: string[]
  avoidances: string[]
  start_date: string
  departure_time: string
  return_hotel_time: string
}

// 表单默认值
export const DEFAULT_PREFERENCE: UserPreference = {
  travelers: { adults: 2, children: 0, elderly: 0 },
  duration_days: 2,
  origin: '',
  destination: '杭州',
  transportation: '本地',
  preferences: ['人文历史', '自然风光'],
  must_visit: [],
  pace: '适中',
  has_pet: false,
  budget: 2000,
  priority: '玩',
  dietary_restrictions: [],
  avoidances: [],
  start_date: '',
  departure_time: '09:00',
  return_hotel_time: '21:00',
}
