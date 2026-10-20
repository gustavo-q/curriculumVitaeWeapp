/**
 * 投递记录 / 岗位追踪 · 纯数据层 —— 移植自参考站 src/utils/trackStore.js
 *
 * 与网页版保持同一个存储键 pb_tracks_v1、同一份记录结构与 4 个状态：
 *   { id, company, role, appliedAt:'YYYY-MM-DD', status, resumeId|null, note }
 *   status ∈ applied / interviewing / rejected / offer
 *
 * 小程序额外的可选字段（网页版读到会原样忽略；网页版编辑保存时会裁掉它们，
 * 因为参考站 normalizeTrack 只保留 7 个字段——这是已知、可接受的单向丢失）：
 *   link        渠道或岗位链接（粘贴的文本）
 *   interviewAt 下一次面试时间（毫秒时间戳），没有则为 null
 *   jdKeywords  从 JD 匹配带过来的岗位关键词（字符串数组，≤30 个）
 *
 * 红线（沿用参考站）：只读写 pb_tracks_v1；纯本地、零网络；
 * 状态药丸永远「颜色底 + 状态名文字」双通道。
 */

const LS_TRACKS = 'pb_tracks_v1'

/** 状态 4 枚举（与网页版写死一致）与展示名 */
const TRACK_STATUSES = [
  { id: 'applied', label: '已投' },
  { id: 'interviewing', label: '面试中' },
  { id: 'rejected', label: '已拒' },
  { id: 'offer', label: 'Offer' }
]

/** 分段（对应网页版看板三列）：已结束 = rejected + offer */
const TRACK_COLUMNS = [
  { id: 'applied', label: '已投', states: ['applied'] },
  { id: 'interviewing', label: '面试中', states: ['interviewing'] },
  { id: 'closed', label: '已结束', states: ['rejected', 'offer'] }
]

const MAX_KEYWORDS = 30

const statusLabel = (id) => {
  const s = TRACK_STATUSES.find((x) => x.id === id)
  return s ? s.label : id
}

const isStatus = (id) => TRACK_STATUSES.some((s) => s.id === id)

/** 状态 → 所在分段 id */
const columnOf = (status) => {
  const c = TRACK_COLUMNS.find((col) => col.states.indexOf(status) >= 0)
  return c ? c.id : 'applied'
}

/** 拖入 / 切到某分段时的默认状态（已结束默认 rejected，与网页版一致） */
const columnDropStatus = (columnId) => {
  const col = TRACK_COLUMNS.find((c) => c.id === columnId)
  return col ? col.states[0] : null
}

/* ---------------- 读写（唯一出口） ---------------- */

function loadTracks () {
  try {
    let arr = wx.getStorageSync(LS_TRACKS)
    // 网页版存的是 JSON 字符串；若有人把网页版的值原样搬过来，也能读
    if (typeof arr === 'string' && arr) arr = JSON.parse(arr)
    return Array.isArray(arr) ? arr.filter((t) => t && typeof t === 'object' && t.id) : []
  } catch (e) {
    return []
  }
}

function saveTracks (list) {
  try {
    wx.setStorageSync(LS_TRACKS, Array.isArray(list) ? list : [])
    return true
  } catch (e) {
    return false
  }
}

const makeTrackId = () =>
  'tk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)

const pad = (n) => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD（不用 toISOString，避免 UTC 偏移把日期算成昨天） */
function dateStr (d) {
  const x = d instanceof Date ? d : new Date(d)
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate())
}
const todayStr = () => dateStr(new Date())

/** 本地时间 HH:mm */
function timeStr (d) {
  const x = d instanceof Date ? d : new Date(d)
  return pad(x.getHours()) + ':' + pad(x.getMinutes())
}

/** 'YYYY-MM-DD' + 'HH:mm' → 本地毫秒时间戳；任一缺失/非法返回 null */
function combineDateTime (date, time) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!dm) return null
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(time || '')) || [null, '9', '00']
  const d = new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], 0, 0)
  const ts = d.getTime()
  return isNaN(ts) ? null : ts
}

function cleanKeywords (arr) {
  const list = Array.isArray(arr) ? arr : typeof arr === 'string' ? arr.split(/[,，、\n]/) : []
  const out = []
  const seen = {}
  for (const w of list) {
    const s = String(w == null ? '' : w).trim()
    if (!s) continue
    const k = s.toLowerCase()
    if (seen[k]) continue
    seen[k] = true
    out.push(s.slice(0, 40))
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

/**
 * 保存前规范化：公司 / 岗位必填，缺一返回 null（与网页版 AC4 一致）。
 * 网页版的 7 个字段原样保留口径；小程序的 3 个可选字段总是写出，便于读取方不判空。
 */
function normalizeTrack (raw) {
  if (!raw) return null
  const company = String(raw.company == null ? '' : raw.company).trim()
  const role = String(raw.role == null ? '' : raw.role).trim()
  if (!company || !role) return null
  const status = isStatus(raw.status) ? raw.status : 'applied'
  const appliedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.appliedAt || '')) ? raw.appliedAt : todayStr()
  const ia = Number(raw.interviewAt)
  return {
    id: raw.id || makeTrackId(),
    company,
    role,
    appliedAt,
    status,
    resumeId: raw.resumeId || null,
    note: String(raw.note == null ? '' : raw.note),
    link: String(raw.link == null ? '' : raw.link).trim(),
    interviewAt: raw.interviewAt && isFinite(ia) && ia > 0 ? ia : null,
    jdKeywords: cleanKeywords(raw.jdKeywords)
  }
}

/* ---------------- CRUD ---------------- */

function getTrack (id) {
  return loadTracks().find((t) => t.id === id) || null
}

/**
 * 新增或更新一条。返回 { ok, record }：
 *   ok=false & record=null → 必填缺失；ok=false & record → 写盘失败（存储满）
 */
function upsertTrack (raw) {
  const rec = normalizeTrack(raw)
  if (!rec) return { ok: false, record: null }
  const list = loadTracks()
  const i = list.findIndex((t) => t.id === rec.id)
  if (i >= 0) list[i] = rec
  else list.unshift(rec)
  return { ok: saveTracks(list), record: rec }
}

function removeTrack (id) {
  const list = loadTracks()
  const next = list.filter((t) => t.id !== id)
  if (next.length === list.length) return false
  return saveTracks(next)
}

function setStatus (id, status) {
  if (!isStatus(status)) return false
  const list = loadTracks()
  const t = list.find((x) => x.id === id)
  if (!t) return false
  t.status = status
  return saveTracks(list)
}

/* ---------------- 派生计算 ---------------- */

function groupByColumns (tracks, filterStatus) {
  const f = filterStatus || 'all'
  return TRACK_COLUMNS.map((col) => ({
    id: col.id,
    label: col.label,
    states: col.states,
    tracks: tracks.filter((t) => col.states.indexOf(t.status) >= 0 && (f === 'all' || t.status === f))
  }))
}

/** 三段计数 + 面试中计数 */
function countByColumn (tracks) {
  const out = { applied: 0, interviewing: 0, closed: 0, total: tracks.length }
  for (const t of tracks) out[columnOf(t.status)]++
  return out
}

/** 关联某草稿的记录总数 n 与其中 interviewing 数 m（网页版 N13 角标口径） */
function trackBadge (tracks, resumeId) {
  const mine = tracks.filter((t) => t.resumeId === resumeId)
  return { n: mine.length, m: mine.filter((t) => t.status === 'interviewing').length }
}

/** 按简历过滤：'' = 全部；'__none__' = 未关联简历 */
function filterByResume (tracks, resumeId) {
  if (!resumeId) return tracks
  if (resumeId === '__none__') return tracks.filter((t) => !t.resumeId)
  return tracks.filter((t) => t.resumeId === resumeId)
}

/**
 * 分段内排序：
 *   面试中 → 有面试时间且未过的按时间升序在前，其余按投递日期倒序；
 *   其他分段 → 投递日期倒序（同日保持存储顺序，即新记的在前）。
 */
function sortForColumn (tracks, columnId, now) {
  const n = now || Date.now()
  const arr = tracks.map((t, i) => ({ t, i }))
  arr.sort((a, b) => {
    if (columnId === 'interviewing') {
      const fa = a.t.interviewAt && a.t.interviewAt >= n - 3600e3
      const fb = b.t.interviewAt && b.t.interviewAt >= n - 3600e3
      if (fa && fb) return a.t.interviewAt - b.t.interviewAt
      if (fa !== fb) return fa ? -1 : 1
    }
    if (a.t.appliedAt !== b.t.appliedAt) return a.t.appliedAt < b.t.appliedAt ? 1 : -1
    return a.i - b.i
  })
  return arr.map((x) => x.t)
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 面试时间展示：今天 / 明天 / 10月23日 周五 + HH:mm */
function fmtInterview (ts, now) {
  if (!ts) return ''
  const d = new Date(ts)
  const base = new Date(now || Date.now())
  const day0 = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()
  const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((dd - day0) / 86400e3)
  let label
  if (diff === 0) label = '今天'
  else if (diff === 1) label = '明天'
  else if (diff === -1) label = '昨天'
  else {
    label = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WEEK[d.getDay()]
    if (d.getFullYear() !== base.getFullYear()) label = d.getFullYear() + '年' + label
  }
  return label + ' ' + timeStr(d)
}

/** 面试是否在接下来 24 小时内（列表里高亮用） */
const isInterviewSoon = (ts, now) => {
  const n = now || Date.now()
  return !!ts && ts >= n && ts - n <= 86400e3
}

module.exports = {
  LS_TRACKS,
  TRACK_STATUSES,
  TRACK_COLUMNS,
  MAX_KEYWORDS,
  statusLabel,
  isStatus,
  columnOf,
  columnDropStatus,
  loadTracks,
  saveTracks,
  makeTrackId,
  todayStr,
  dateStr,
  timeStr,
  combineDateTime,
  cleanKeywords,
  normalizeTrack,
  getTrack,
  upsertTrack,
  removeTrack,
  setStatus,
  groupByColumns,
  countByColumn,
  trackBadge,
  filterByResume,
  sortForColumn,
  fmtInterview,
  isInterviewSoon
}
