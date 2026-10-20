/**
 * 求职工具回归：投递记录 / 投递详情 / JD 匹配 / 简历攻略 / 数据备份 / 我的
 *
 * 写法沿用 tools/check-logic.cjs：wx 桩 + mount() 在 Node 里真跑页面生命周期与处理函数，
 * 断言 data、存储与 wx 调用。覆盖：
 *   1. trackStore CRUD、状态 ↔ 分段映射、网页版数据兼容
 *   2. matchJD 对样例 JD 的命中 / 弱匹配 / 缺失、补词区块猜测、公司岗位猜测
 *   3. JD 匹配页剪贴板提示逻辑（像 JD 才提示、处理过不再提示）
 *   4. 点缺失词 → 复制 + 跳编辑器；记一笔投递 → track-edit 预填
 *   5. track-edit 从 options 预填、保存、日历写入与不支持时的退化
 *   6. 投递 tab：分段计数、左滑、改状态、删除、按简历筛选
 *   7. 备份往返（复制 → 清空 → 粘贴恢复）+ 同名查重 + 跳过同名 + 发文件
 *   8. 攻略 topic 映射、我的页计数
 *
 * 运行：node tools/check-tools.cjs
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')) }
}
function section (t) { console.log('\n=== ' + t + ' ===') }

/* ---------------- wx 桩 ---------------- */
const storage = {}
const calls = { toast: [], modals: [], navigate: [], switchTab: [], calendar: [], shared: [], written: {} }
let clipboard = ''
/** showModal 依次取答案；空了默认 confirm */
let modalAnswers = []
/** showActionSheet 选第几项；null = 取消 */
let sheetPick = null
let messageFile = null
let calendarMode = 'ok' // ok | fail | cancel

const wxBase = {
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync: (k) => { delete storage[k] },
  getStorageInfoSync: () => ({ keys: Object.keys(storage), currentSize: Math.ceil(JSON.stringify(storage).length / 1024), limitSize: 10240 }),
  createOffscreenCanvas: () => { throw new Error('headless: no canvas') },
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, screenHeight: 812, safeArea: { bottom: 778 } }),
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, screenHeight: 812 }),
  getMenuButtonBoundingClientRect: () => ({ top: 24, height: 32 }),
  getAccountInfoSync: () => ({ miniProgram: { version: '' } }),
  showToast: (o) => calls.toast.push(o.title),
  showLoading: () => {},
  hideLoading: () => {},
  showModal: (o) => {
    calls.modals.push(o)
    const a = modalAnswers.length ? modalAnswers.shift() : true
    if (o.success) o.success({ confirm: !!a, cancel: !a })
  },
  showActionSheet: (o) => {
    calls.sheet = o
    if (sheetPick == null) return o.fail && o.fail({ errMsg: 'showActionSheet:fail cancel' })
    o.success && o.success({ tapIndex: sheetPick })
  },
  navigateTo: (o) => calls.navigate.push(o.url),
  redirectTo: (o) => calls.navigate.push(o.url),
  reLaunch: (o) => calls.navigate.push(o.url),
  switchTab: (o) => calls.switchTab.push(o.url),
  navigateBack: () => calls.navigate.push('back'),
  setClipboardData: (o) => { clipboard = String(o.data); o.success && o.success() },
  getClipboardData: (o) => o.success && o.success({ data: clipboard }),
  addPhoneCalendar: (o) => {
    calls.calendar.push(o)
    if (calendarMode === 'ok') o.success && o.success()
    else if (calendarMode === 'cancel') o.fail && o.fail({ errMsg: 'addPhoneCalendar:fail cancel' })
    else o.fail && o.fail({ errMsg: 'addPhoneCalendar:fail system error' })
  },
  shareFileMessage: (o) => { calls.shared.push(o); o.success && o.success() },
  chooseMessageFile: (o) => { if (messageFile) o.success({ tempFiles: [messageFile] }) },
  env: { USER_DATA_PATH: '/tmp/usr' },
  getFileSystemManager: () => ({
    mkdirSync () {},
    writeFileSync (p, data) { calls.written[p] = String(data) },
    writeFile (o) { calls.written[o.filePath] = String(o.data); o.success && o.success() },
    readFile (o) {
      if (o.filePath in calls.written) o.success({ data: calls.written[o.filePath] })
      else o.fail && o.fail({ errMsg: 'no such file' })
    }
  })
}
global.wx = Object.assign({}, wxBase)

let appObj = null
global.App = (o) => { appObj = o }
global.getApp = () => appObj
let lastPage = null
global.Page = (o) => { lastPage = o }
global.Component = () => {}
let pageStack = [{ route: 'pages/home/home' }]
global.getCurrentPages = () => pageStack

require(path.join(ROOT, 'app.js'))
appObj.onLaunch()

function applySetData (data, patch) {
  Object.keys(patch).forEach((key) => {
    const p = key.replace(/\[(\d+)\]/g, '.$1').split('.')
    let node = data
    for (let i = 0; i < p.length - 1; i++) {
      if (node == null) return
      node = node[p[i]]
    }
    if (node == null) return
    node[p[p.length - 1]] = patch[key]
  })
}

function mount (pagePath, query, opts) {
  lastPage = null
  const file = path.join(ROOT, pagePath)
  delete require.cache[require.resolve(file)]
  const mod = require(file)
  const def = lastPage
  const inst = Object.assign({}, def)
  inst.data = JSON.parse(JSON.stringify(def.data || {}))
  inst.setData = function (patch, cb) { applySetData(inst.data, patch); if (cb) cb() }
  inst.__module = mod
  if (typeof def.onLoad === 'function') def.onLoad.call(inst, query || {})
  if (!(opts && opts.noShow) && typeof def.onShow === 'function') def.onShow.call(inst)
  return inst
}

const ev = (dataset, detail) => ({ currentTarget: { dataset: dataset || {} }, target: { dataset: dataset || {} }, detail: detail || {} })
const touch = (dataset, x, y) => ({ currentTarget: { dataset }, target: { dataset }, touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] })
const lastToast = () => calls.toast[calls.toast.length - 1]
const resetCalls = () => {
  calls.toast = []; calls.modals = []; calls.navigate = []; calls.switchTab = []; calls.calendar = []; calls.shared = []
  modalAnswers = []
}

const store = require(path.join(ROOT, 'utils/store.js'))
const T = require(path.join(ROOT, 'utils/trackStore.js'))
const M = require(path.join(ROOT, 'utils/matchJD.js'))
const { normalizeResume } = require(path.join(ROOT, 'utils/model.js'))

/* 构造一份内容可控的简历，替换掉播种的示例简历 */
const sample = normalizeResume({
  resumeName: '前端-张三',
  baseInfo: { name: '张三', jobIntention: '前端开发' },
  sections: [
    { id: 's_edu', title: '教育背景', items: [{ id: 'i1', type: 'THREE', leftContent: '某某大学', centerContent: '计算机科学与技术', rightContent: '2018-2022' }] },
    { id: 's_work', title: '工作经历', items: [{ id: 'i2', type: 'ONE', centerContent: '负责用户增长相关页面开发，使用 <b>Vue</b> 搭建活动平台，转化率提升 20%' }] },
    { id: 's_skill', title: '技能证书', items: [{ id: 'i3', type: 'ONE', centerContent: '熟练 MySQL、Vue、Excel；英语 CET-6' }] },
    { id: 's_self', title: '自我评价', items: [{ id: 'i4', type: 'ONE', centerContent: '做事踏实' }] }
  ]
})
sample.id = 'r_sample'
store.state.drafts.splice(0, store.state.drafts.length, sample)
wx.setStorageSync('pb_drafts_v1', store.state.drafts)
store.open('r_sample')

/* ================================================================== */
section('1. trackStore：CRUD 与状态映射')
ok('4 个状态与网页版一致', T.TRACK_STATUSES.map((s) => s.id).join() === 'applied,interviewing,rejected,offer')
ok('分段映射：rejected/offer → 已结束', T.columnOf('rejected') === 'closed' && T.columnOf('offer') === 'closed' && T.columnOf('interviewing') === 'interviewing' && T.columnOf('applied') === 'applied')
ok('切到已结束默认 rejected', T.columnDropStatus('closed') === 'rejected')
ok('必填缺失返回 null', T.normalizeTrack({ company: '  ', role: '前端' }) === null && T.normalizeTrack({ company: 'A', role: '' }) === null)
const n1 = T.normalizeTrack({ company: ' A 公司 ', role: '前端', status: 'weird', appliedAt: 'bad', junk: 1 })
ok('normalize：trim、非法状态 → applied、非法日期 → 今天、丢垃圾字段', n1.company === 'A 公司' && n1.status === 'applied' && n1.appliedAt === T.todayStr() && !('junk' in n1))
ok('normalize：新字段默认值', n1.link === '' && n1.interviewAt === null && Array.isArray(n1.jdKeywords) && n1.resumeId === null)
ok('id 前缀 tk_', /^tk_/.test(n1.id))

wx.removeStorageSync(T.LS_TRACKS)
const a = T.upsertTrack({ company: '甲公司', role: '前端', resumeId: 'r_sample', appliedAt: '2026-10-01' })
const b = T.upsertTrack({ company: '乙公司', role: '后端', appliedAt: '2026-10-05' })
ok('新增两条', a.ok && b.ok && T.loadTracks().length === 2)
ok('新记录插在最前', T.loadTracks()[0].company === '乙公司')
ok('getTrack', T.getTrack(a.record.id).company === '甲公司')
T.upsertTrack(Object.assign({}, a.record, { role: '高级前端' }))
ok('更新不新增', T.loadTracks().length === 2 && T.getTrack(a.record.id).role === '高级前端')
ok('setStatus', T.setStatus(a.record.id, 'interviewing') && T.getTrack(a.record.id).status === 'interviewing')
ok('setStatus 拒绝非法状态', T.setStatus(a.record.id, 'xx') === false)
const cnt = T.countByColumn(T.loadTracks())
ok('分段计数', cnt.applied === 1 && cnt.interviewing === 1 && cnt.closed === 0 && cnt.total === 2)
ok('trackBadge', T.trackBadge(T.loadTracks(), 'r_sample').n === 1 && T.trackBadge(T.loadTracks(), 'r_sample').m === 1)
ok('按简历筛选 / 未关联', T.filterByResume(T.loadTracks(), 'r_sample').length === 1 && T.filterByResume(T.loadTracks(), '__none__').length === 1)
ok('removeTrack', T.removeTrack(b.record.id) && T.loadTracks().length === 1)
// 网页版 localStorage 存的是 JSON 字符串：原样搬过来也能读
storage[T.LS_TRACKS] = JSON.stringify([{ id: 'tk_web', company: 'W', role: 'R', appliedAt: '2026-01-01', status: 'offer', resumeId: null, note: '' }])
ok('兼容网页版 JSON 字符串存储', T.loadTracks().length === 1 && T.loadTracks()[0].id === 'tk_web')
wx.removeStorageSync(T.LS_TRACKS)
const ts = T.combineDateTime('2026-10-23', '14:30')
ok('combineDateTime 本地时间', new Date(ts).getHours() === 14 && new Date(ts).getMinutes() === 30 && T.dateStr(ts) === '2026-10-23')
ok('combineDateTime 非法返回 null', T.combineDateTime('', '10:00') === null)
const base = new Date(2026, 9, 20, 9, 0).getTime()
ok('fmtInterview 今天/明天', T.fmtInterview(new Date(2026, 9, 20, 15, 0).getTime(), base) === '今天 15:00' && T.fmtInterview(new Date(2026, 9, 21, 9, 5).getTime(), base) === '明天 09:05')
ok('fmtInterview 其他日期带星期', T.fmtInterview(new Date(2026, 9, 23, 10, 0).getTime(), base) === '10月23日 周五 10:00', T.fmtInterview(new Date(2026, 9, 23, 10, 0).getTime(), base))
const sorted = T.sortForColumn([
  { id: 'x', appliedAt: '2026-10-01', interviewAt: base + 5 * 86400e3 },
  { id: 'y', appliedAt: '2026-10-02', interviewAt: base + 86400e3 },
  { id: 'z', appliedAt: '2026-10-03', interviewAt: null }
], 'interviewing', base)
ok('面试中按面试时间升序，无时间的排后', sorted.map((t) => t.id).join() === 'y,x,z')
ok('cleanKeywords 去重/裁剪', T.cleanKeywords('Vue,vue，React、 ,TS').join() === 'Vue,React,TS')

/* ================================================================== */
section('2. matchJD：样例 JD')
const JD = '某某网络科技有限公司\n前端开发工程师 15-25K·13薪\n岗位要求：\n1. 熟悉 Vue、React，做过 MySQL 调优；\n2. 具备 TypeScript 能力，负责用户增长；\n3. 良好的沟通协作能力。'
const res = M.matchJD(sample, JD, [])
const G = {}
res.groups.forEach((g) => { G[g.id] = g.items })
console.log('    命中', G.hit.join('|'), ' 弱', G.weak.join('|'), ' 缺', G.miss.join('|'))
ok('vue 命中（含行内格式 <b>Vue</b> 剥离）', G.hit.indexOf('vue') >= 0)
ok('mysql调优 弱匹配（短语整体参与）', G.weak.indexOf('mysql调优') >= 0)
ok('react / typescript 缺失', G.miss.indexOf('react') >= 0 && G.miss.indexOf('typescript') >= 0)
ok('序号 / 薪资数字不当关键词', !res.groups.some((g) => g.items.some((w) => /^\d|15-25k/i.test(w))), JSON.stringify(res.groups))
ok('停用词不计入', !res.groups.some((g) => g.items.some((w) => w === '熟悉' || w === '岗位要求' || w === '能力')))
ok('覆盖率 =（命中+弱）/总数', res.summary.coverage === Math.round(((res.summary.hit + res.summary.weak) / res.summary.total) * 100))
ok('空 JD：分母 0、coverage=null', M.matchJD(sample, '   ', []).summary.denomZero === true && M.matchJD(sample, '', []).summary.coverage === null)
const withCustom = M.matchJD(sample, JD, ['Excel', 'Docker'])
ok('自定义词并入：Excel 命中、Docker 缺失', withCustom.groups[0].items.indexOf('Excel') >= 0 && withCustom.groups[2].items.indexOf('Docker') >= 0)
ok('不用 matchAll（低版本 iOS 兼容）', require('fs').readFileSync(path.join(ROOT, 'utils/matchJD.js'), 'utf8').indexOf('.matchAll(') < 0)
ok('stripInlineFormat 实体还原', M.stripInlineFormat('a&amp;b') === 'a&b' && M.stripInlineFormat('<b>x</b><br>y') === 'x\ny')

ok('guessSection：弱匹配词 → 出现子词的区块', M.guessSection(sample, 'mysql调优') === 's_skill')
ok('guessSection：英文技能 → 技能证书', M.guessSection(sample, 'typescript') === 's_skill')
ok('guessSection：软素质 → 自我评价', M.guessSection(sample, '沟通协作') === 's_self')
ok('guessSection：学历类 → 教育背景', M.guessSection(sample, '硕士') === 's_edu')
ok('guessSection：求职意向 → base', M.guessSection(sample, '求职意向') === 'base')
const guess = M.guessCompanyRole(JD)
ok('guessCompanyRole：公司', guess.company === '某某网络科技有限公司', JSON.stringify(guess))
ok('guessCompanyRole：岗位去掉薪资', guess.role === '前端开发工程师', JSON.stringify(guess))
const g2 = M.guessCompanyRole('职位名称：数据分析师（实习）\n公司：ABC 集团\n职责：……')
ok('guessCompanyRole：带标签行', g2.company === 'ABC 集团' && g2.role === '数据分析师（实习）', JSON.stringify(g2))
ok('guessCompanyRole：猜不到给空串', JSON.stringify(M.guessCompanyRole('随便一段话')) === '{"company":"","role":""}')

/* ================================================================== */
section('3. JD 匹配页：剪贴板提示')
const { shouldOfferClip } = require(path.join(ROOT, 'packages/tools/match/match.js'))
ok('≤30 字不提示', shouldOfferClip('短文本', '', '') === false)
ok('像 JD 提示', shouldOfferClip(JD, '', '') === true)
ok('处理过的不提示', shouldOfferClip(JD, M.hashText(JD), '') === false)
ok('与输入框内容相同不提示', shouldOfferClip(JD, '', JD) === false)
ok('JSON 备份不当 JD', shouldOfferClip('[{"resumeName":"x","sections":[]} , {"a": "bbbbbbbbbbbbbbbbbbbbbbbbbbb"}]', '', '') === false)
ok('哈希不存原文', M.hashText(JD).indexOf('前端') < 0)

resetCalls()
clipboard = JD
pageStack = [{ route: 'pages/mine/mine' }, { route: 'packages/tools/match/match' }]
const match = mount('packages/tools/match/match.js', {})
ok('默认选中当前简历', match.data.resumeNames[match.data.resumeIndex] === '前端-张三')
ok('onShow 检测到剪贴板 JD → 横幅', match.data.clipOffer === true && match.data.clipPreview.length > 0)
match.onPasteClip()
ok('一键粘贴：填入 JD 并自动匹配', match.data.jd.indexOf('React') >= 0 && !!match.data.result && match.data.coverage != null)
ok('圆环样式注入 conic-gradient', /conic-gradient/.test(match.data.ringStyle))
ok('粘贴后记录哈希', storage.pb_match_clip_v1 === M.hashText(JD))
match.onShow()
ok('再次 onShow 不再提示同一段', match.data.clipOffer === false)
clipboard = JD + '\n4. 加分：Node.js'
match.onShow()
ok('剪贴板换了新 JD → 再次提示', match.data.clipOffer === true)
match.onDismissClip()
match.onShow()
ok('忽略后不再提示', match.data.clipOffer === false)

/* 自定义词 */
match.onTermInput(ev({}, { value: 'Docker' }))
match.onAddTerm()
ok('添加自定义词 → 持久化独立键', storage.pb_match_terms_v1 && storage.pb_match_terms_v1.indexOf('Docker') >= 0 && match.data.customTerms.length === 1)
ok('自定义词进入结果', match.data.result.groups[2].items.indexOf('Docker') >= 0)
match.onTermInput(ev({}, { value: 'docker' }))
match.onAddTerm()
ok('重复词（大小写不敏感）不新增', match.data.customTerms.length === 1 && lastToast() === '已在词表中')
match.onRemoveTerm(ev({ w: 'Docker' }))
ok('删除自定义词', match.data.customTerms.length === 0 && storage.pb_match_terms_v1.length === 0)
ok('pb_drafts_v1 未被匹配页写入', JSON.stringify(storage.pb_drafts_v1).indexOf('Docker') < 0)

section('4. 点缺失词 → 复制 + 去补；记一笔投递')
resetCalls()
match.onKeyword(ev({ w: 'typescript', g: 'miss' }))
ok('关键词已复制', clipboard === 'typescript')
ok('提示文案', lastToast() === '已复制关键词，去补到简历里')
ok('跳编辑器并带 focus=技能区块', calls.navigate[0] === '/pages/edit/edit?id=r_sample&focus=s_skill', calls.navigate[0])
match.onShow()
ok('复制的关键词不会被当成 JD 提示', match.data.clipOffer === false)
resetCalls()
match.onKeyword(ev({ w: 'vue', g: 'hit' }))
ok('命中词点了不跳转', calls.navigate.length === 0)
match.onTrack()
const turl = calls.navigate[0] || ''
ok('记一笔投递 → track-edit', turl.indexOf('/pages/track-edit/track-edit?') === 0)
const tq = {}
turl.split('?')[1].split('&').forEach((kv) => { const i = kv.indexOf('='); tq[kv.slice(0, i)] = kv.slice(i + 1) })
ok('带 resumeId / 猜到的公司岗位', tq.resumeId === 'r_sample' && decodeURIComponent(tq.company) === '某某网络科技有限公司' && decodeURIComponent(tq.role) === '前端开发工程师')
ok('关键词缺失在前', decodeURIComponent(tq.keywords).split(',')[0] === res.groups[2].items[0], decodeURIComponent(tq.keywords))

/* ================================================================== */
section('5. track-edit：预填、保存、日历')
resetCalls()
pageStack = [{ route: 'packages/tools/match/match' }, { route: 'pages/track-edit/track-edit' }]
const te = mount('pages/track-edit/track-edit.js', tq)
ok('从匹配来：fromMatch', te.data.fromMatch === true && te.data.isEdit === false)
ok('预填公司 / 岗位（URL 解码）', te.data.form.company === '某某网络科技有限公司' && te.data.form.role === '前端开发工程师')
ok('预填所用简历', te.data.form.resumeId === 'r_sample' && te.data.resumeNames[te.data.resumeIndex] === '前端-张三')
ok('预填关键词', te.data.form.jdKeywords.length > 0 && te.data.form.jdKeywords.indexOf('react') >= 0)
ok('投递日期默认今天、状态已投', te.data.form.appliedAt === T.todayStr() && te.data.form.status === 'applied')

// 面试时间：选日期 → 自动补时间并切到面试中
const future = new Date(Date.now() + 3 * 86400e3)
const fDate = T.dateStr(future)
te.onIvDate(ev({}, { value: fDate }))
ok('选面试日期 → 默认 10:00、状态改面试中', te.data.form.ivTime === '10:00' && te.data.form.status === 'interviewing')
te.onIvTime(ev({}, { value: '14:30' }))
calendarMode = 'ok'
te.onAddCalendar()
const cal = calls.calendar[0] || {}
ok('addPhoneCalendar 标题', cal.title === '面试：某某网络科技有限公司 前端开发工程师', cal.title)
ok('startTime 为秒级时间戳', cal.startTime === Math.floor(T.combineDateTime(fDate, '14:30') / 1000))
ok('提前 1 小时提醒', cal.alarm === true && cal.alarmOffset === 3600)
ok('成功提示', lastToast() === '已加到手机日历')

resetCalls()
calendarMode = 'cancel'
te.onAddCalendar()
ok('用户取消：不弹退化', calls.modals.length === 0)
calendarMode = 'fail'
modalAnswers = [true]
te.onAddCalendar()
ok('写入失败 → 退化弹窗', calls.modals.length === 1 && /失败/.test(calls.modals[0].title))
ok('退化：复制面试信息', clipboard.indexOf('面试：某某网络科技有限公司') === 0 && clipboard.indexOf(fDate + ' 14:30') > 0)
// 基础库不支持
resetCalls()
const savedCal = wx.addPhoneCalendar
delete wx.addPhoneCalendar
const te2 = mount('pages/track-edit/track-edit.js', { company: 'X', role: 'Y' })
ok('不支持日历：按钮文案退化', te2.data.canCalendar === false)
te2.onIvDate(ev({}, { value: fDate }))
modalAnswers = [true]
te2.onAddCalendar()
ok('不支持日历 → 退化弹窗 + 复制', calls.modals.length === 1 && /不支持/.test(calls.modals[0].title) && clipboard.indexOf('面试：X Y') === 0)
wx.addPhoneCalendar = savedCal
resetCalls()
te2.onIvDate(ev({}, { value: '2020-01-01' }))
te2.onAddCalendar()
ok('过去的面试时间不写日历', calls.calendar.length === 0 && lastToast() === '面试时间已经过了')

// 保存
resetCalls()
te.onInput(ev({ k: 'note' }, { value: '一面：技术面' }))
te.onSave()
const saved = T.loadTracks()
ok('保存写入 pb_tracks_v1', saved.length === 1 && saved[0].company === '某某网络科技有限公司')
ok('保存了面试时间 / 关键词 / 备注', saved[0].interviewAt === T.combineDateTime(fDate, '14:30') && saved[0].jdKeywords.length > 0 && saved[0].note === '一面：技术面')
ok('网页版 7 字段齐全', ['id', 'company', 'role', 'appliedAt', 'status', 'resumeId', 'note'].every((k) => k in saved[0]))
const trackId = saved[0].id
// 保存后延时跳转：直接调 leave 断言
te.leave()
ok('从匹配来保存后 → 投递 tab', calls.switchTab.indexOf('/pages/track/track') >= 0)

resetCalls()
const te3 = mount('pages/track-edit/track-edit.js', {})
te3.onSave()
ok('必填校验', lastToast() === '请填写公司' && T.loadTracks().length === 1)

// 编辑已有
const te4 = mount('pages/track-edit/track-edit.js', { id: trackId })
ok('编辑：回填', te4.data.isEdit && te4.data.form.ivDate === fDate && te4.data.form.ivTime === '14:30' && te4.data.form.note === '一面：技术面')
te4.onClearIv()
te4.onSave()
ok('清除面试时间后保存 → interviewAt=null', T.getTrack(trackId).interviewAt === null && T.loadTracks().length === 1)
const te5 = mount('pages/track-edit/track-edit.js', { id: 'tk_nope' })
ok('不存在的 id → 提示且按新建处理', te5.data.notFound === true && te5.data.isEdit === false)

/* ================================================================== */
section('6. 投递 tab')
T.upsertTrack({ company: '丙公司', role: '产品', appliedAt: '2026-10-10' })
T.upsertTrack({ company: '丁公司', role: '运营', appliedAt: '2026-10-11', status: 'offer' })
T.setStatus(trackId, 'interviewing')
T.upsertTrack(Object.assign(T.getTrack(trackId), { interviewAt: Date.now() + 3600e3 }))
pageStack = [{ route: 'pages/track/track' }]
const tk = mount('pages/track/track.js')
const segCount = (id) => tk.data.segments.find((s) => s.id === id).count
ok('分段计数 已投1 面试中1 已结束1', segCount('applied') === 1 && segCount('interviewing') === 1 && segCount('closed') === 1)
ok('默认已投分段只列 applied', tk.data.list.length === 1 && tk.data.list[0].company === '丙公司')
ok('卡片字段', tk.data.list[0].resumeName === '未关联简历' && tk.data.list[0].statusLabel === '已投' && tk.data.list[0].appliedAt === '2026-10-10')
tk.onSeg(ev({ id: 'interviewing' }))
ok('面试中分段 + 面试时间 + 即将开始', tk.data.list.length === 1 && /今天|明天/.test(tk.data.list[0].interview) && tk.data.list[0].interviewSoon === true && tk.data.list[0].resumeName === '前端-张三')
tk.onSeg(ev({ id: 'closed' }))
ok('已结束分段包含 offer', tk.data.list.length === 1 && tk.data.list[0].status === 'offer')
ok('有多份简历来源 → 显示筛选', tk.data.showFilter === true && tk.data.filterNames.indexOf('前端-张三') > 0)

// 按简历筛选
tk.onSeg(ev({ id: 'applied' }))
tk.onFilter(ev({}, { value: tk.data.filterNames.indexOf('前端-张三') }))
ok('筛选后计数随之变化', segCount('applied') === 0 && segCount('interviewing') === 1 && tk.data.filterId === 'r_sample')
tk.onClearFilter()
ok('清除筛选', tk.data.filterId === '' && segCount('applied') === 1)

// 左滑
const id0 = tk.data.list[0].id
tk.onTouchStart(touch({ id: id0 }, 300, 100))
tk.onTouchMove(touch({ id: id0 }, 250, 102))
ok('拖动中去掉过渡', tk.data.list[0].d === true && tk.data.list[0].x < 0)
tk.onTouchMove(touch({ id: id0 }, 150, 104))
tk.onTouchEnd(touch({ id: id0 }, 150, 104))
ok('左滑超过 1/3 → 吸附打开', tk.data.list[0].x === -tk._actionPx && tk._openId === id0 && tk.data.list[0].d === false)
resetCalls()
tk._swipedAt = 0
tk.onCardTap(ev({ id: id0 }))
ok('打开状态下点卡片 = 收起，不跳转', tk.data.list[0].x === 0 && calls.navigate.length === 0)
tk.onTouchStart(touch({ id: id0 }, 300, 100))
tk.onTouchMove(touch({ id: id0 }, 302, 160))
tk.onTouchEnd(touch({ id: id0 }, 302, 160))
ok('竖向滑动不触发左滑', tk.data.list[0].x === 0)
tk.onCardTap(ev({ id: id0 }))
ok('点卡片 → 详情', calls.navigate[0] === '/pages/track-edit/track-edit?id=' + id0)

// 改状态
resetCalls()
sheetPick = 1 // 面试中
modalAnswers = [false]
tk.onChangeStatus(ev({ id: id0 }))
ok('改状态 actionSheet 4 项且标记当前', calls.sheet.itemList.length === 4 && calls.sheet.itemList[0].indexOf('✓') === 0)
ok('改为面试中 → 移出已投分段', T.getTrack(id0).status === 'interviewing' && tk.data.list.length === 0 && segCount('interviewing') === 2)
ok('提示移动到的分段', /面试中/.test(calls.toast[0] || ''))
sheetPick = null

// 删除
tk.onSeg(ev({ id: 'interviewing' }))
resetCalls()
modalAnswers = [false]
tk.onDelete(ev({ id: id0 }))
ok('删除取消 → 仍在', !!T.getTrack(id0))
modalAnswers = [true]
tk.onDelete(ev({ id: id0 }))
ok('删除确认 → 移除', !T.getTrack(id0) && segCount('interviewing') === 1)

// 跨页筛选信号
appObj.globalData.trackResumeFilter = 'r_sample'
tk.onShow()
ok('globalData.trackResumeFilter 生效后清空', tk.data.filterId === 'r_sample' && appObj.globalData.trackResumeFilter === '')

// 空态
const keepTracks = wx.getStorageSync(T.LS_TRACKS)
wx.removeStorageSync(T.LS_TRACKS)
const tkEmpty = mount('pages/track/track.js')
ok('空态：total=0', tkEmpty.data.total === 0 && tkEmpty.data.list.length === 0)
resetCalls()
tkEmpty.onGoMatch()
ok('空态「去匹配 JD」', calls.navigate[0] === '/packages/tools/match/match')
wx.setStorageSync(T.LS_TRACKS, keepTracks)

/* ================================================================== */
section('7. 备份往返 + 查重')
// 再加一份，名字不同
const second = normalizeResume({ resumeName: '产品-张三', sections: [{ title: '项目经历', items: [] }] })
second.id = 'r_second'
store.state.drafts.push(second)
wx.setStorageSync('pb_drafts_v1', store.state.drafts)
const bk = mount('packages/tools/backup/backup.js')
ok('概览计数', bk.data.draftCount === 2 && bk.data.trackCount === T.loadTracks().length)
ok('存储占用文案', /^已用 \d+ KB \/ 10 MB$/.test(bk.data.storage), bk.data.storage)
resetCalls()
bk.onCopyBackup()
const backupText = clipboard
ok('备份格式 = 网页版 JSON.stringify(drafts, null, 2)', backupText === JSON.stringify(store.state.drafts, null, 2))
ok('备份不含投递记录', backupText.indexOf('tk_') < 0)

// 发文件
resetCalls()
bk.onShareBackup()
const shared = calls.shared[0] || {}
ok('写文件到 USER_DATA_PATH 并 shareFileMessage', /^\/tmp\/usr\/exports\/简历制作_全部备份_\d{8}\.json$/.test(shared.filePath || '') && calls.written[shared.filePath] === backupText)
const savedShare = wx.shareFileMessage
delete wx.shareFileMessage
resetCalls()
modalAnswers = [true]
bk.onShareBackup()
ok('不支持发文件 → 退化为复制', calls.modals.length === 1 && clipboard === backupText)
wx.shareFileMessage = savedShare

// 清空（两次确认）
resetCalls()
modalAnswers = [true, false]
bk.onClear()
ok('第二次取消 → 不清空', store.state.drafts.length === 2 && calls.modals.length === 2)
modalAnswers = [true, true]
bk.onClear()
ok('两次确认 → 清空', store.state.drafts.length === 0 && wx.getStorageSync('pb_drafts_v1').length === 0)
ok('清空不影响投递记录', T.loadTracks().length > 0)

// 从剪贴板恢复
clipboard = backupText
bk.onPasteImport()
ok('粘贴 → 预览', bk.data.view === 'preview' && bk.data.total === 2 && bk.data.dupCount === 0 && bk.data.rows.length === 2)
ok('预览零写盘', wx.getStorageSync('pb_drafts_v1').length === 0)
bk.onConfirmImport()
const restored = wx.getStorageSync('pb_drafts_v1')
ok('确认导入 → 写盘 2 份', restored.length === 2 && store.state.drafts.length === 2)
ok('往返后名字一致', restored.map((d) => d.resumeName).sort().join() === '产品-张三,前端-张三')
ok('导入获得新 id', restored.every((d) => d.id !== 'r_sample' && d.id !== 'r_second'))
ok('内容一致（区块标题）', restored.find((d) => d.resumeName === '前端-张三').sections.map((s) => s.title).join() === '教育背景,工作经历,技能证书,自我评价')

// 同名查重：从聊天文件再导入同一份 + 一份新的
const incoming = JSON.parse(backupText).concat([{ resumeName: '全新一份', sections: [] }])
calls.written['/tmp/chat/b.json'] = JSON.stringify(incoming)
messageFile = { path: '/tmp/chat/b.json', name: 'b.json', size: 100 }
bk.onPickFile()
ok('聊天文件 → 预览 + 查重', bk.data.view === 'preview' && bk.data.total === 3 && bk.data.dupCount === 2 && bk.data.source === 'b.json')
ok('预览行标出同名', bk.data.rows.filter((r) => r.dup).length === 2 && bk.data.rows[2].dup === false)
bk.onImportSkipDup()
ok('跳过同名 → 只加 1 份', store.state.drafts.length === 3 && wx.getStorageSync('pb_drafts_v1').length === 3 && /跳过同名 2 份/.test(lastToast()))
bk.onPickFile()
bk.onCancelImport()
ok('取消导入零写盘', wx.getStorageSync('pb_drafts_v1').length === 3 && bk.data.view === 'main')

// 坏数据
resetCalls()
clipboard = '{"foo": 1}'
bk.onPasteImport()
ok('非简历 JSON 拒绝', bk.data.view === 'main' && lastToast() === '不是有效的备份文件')
clipboard = 'not json at all'
bk.onPasteImport()
ok('非 JSON 拒绝', lastToast() === '不是有效的备份文件')
const B = require(path.join(ROOT, 'packages/tools/backup/backupUtil.js'))
ok('超过 50 份拒绝', B.parseBackup(JSON.stringify(new Array(51).fill({ sections: [] }))).ok === false)
ok('{drafts:[...]} 包装可读', B.parseBackup(JSON.stringify({ drafts: [{ resumeName: 'a', sections: [] }] })).ok === true)
ok('dedupByName 口径（trim）', B.dedupByName([{ resumeName: ' A ' }, { resumeName: 'A' }, { resumeName: 'B' }], [{ resumeName: 'A' }]).dupCount === 2)

// 适配层：store 没有 importDrafts 时退回 importJSON，并在写盘失败时回滚
const fakeStore = {
  state: { drafts: [{ id: 'r1', resumeName: 'x' }] },
  importJSON (text) {
    const arr = JSON.parse(text)
    this.state.drafts = arr.concat(this.state.drafts)
    // 模拟写盘失败：storage 不变
    return arr.length
  },
  emit () {}
}
storage.pb_drafts_v1_backup = storage.pb_drafts_v1
storage.pb_drafts_v1 = [{ id: 'r1' }]
const fr = B.importDrafts(fakeStore, [{ resumeName: 'y', sections: [] }])
ok('老 store 写盘失败 → 回滚内存', fr.ok === false && fakeStore.state.drafts.length === 1)
storage.pb_drafts_v1 = storage.pb_drafts_v1_backup
delete storage.pb_drafts_v1_backup

/* ================================================================== */
section('8. 攻略 / 我的')
const GD = require(path.join(ROOT, 'packages/tools/guide/guideData.js'))
ok('移植网页版 6 篇 + 补充 3 篇', GD.ARTICLES.length === 9 && ['naming', 'star', 'keywords', 'onepage', 'photo', 'mistakes'].every((id) => GD.getArticle(id)))
const topicCases = { 教育背景: 'education', 工作经历: 'star', 实习经历: 'star', 项目经历: 'star', 校园经历: 'star', 自我评价: 'summary', 技能证书: 'skills', 荣誉奖项: 'skills', base: 'photo', 求职意向: 'keywords' }
Object.keys(topicCases).forEach((k) => {
  const a2 = GD.findArticleByTopic(k)
  ok('topic「' + k + '」→ ' + topicCases[k], a2 && a2.id === topicCases[k], a2 && a2.id)
})
ok('无关 topic → null（退回列表）', GD.findArticleByTopic('兴趣爱好') === null)
const gd = mount('packages/tools/guide/guide.js', { topic: encodeURIComponent('项目经历') })
ok('guide?topic= 直接打开详情', gd.data.mode === 'detail' && gd.data.article.id === 'star')
const gl = mount('packages/tools/guide/guide.js', { topic: '兴趣爱好' })
ok('找不到 → 列表 + 提示', gl.data.mode === 'list' && gl.data.topicMissed === '兴趣爱好')
gl.onCat(ev({ cat: '分栏写法' }))
ok('分类筛选', gl.data.list.length === 3)
resetCalls()
gl.onOpen(ev({ id: 'skills' }))
ok('列表点文章 → 同页 ?id=', calls.navigate[0] === '/packages/tools/guide/guide?id=skills')
pageStack = [{ route: 'pages/edit/edit' }, { route: 'packages/tools/guide/guide' }]
gd.onWrite()
ok('从编辑器来 → 返回编辑器', calls.navigate[calls.navigate.length - 1] === 'back')

const mine = mount('pages/mine/mine.js')
const nInterview = T.countByColumn(T.loadTracks()).interviewing
ok('我的：计数', mine.data.resumeCount === 3 && mine.data.trackCount === T.loadTracks().length && mine.data.interviewCount === nInterview)
ok('我的：版本兜底', mine.data.version === '1.0.0')
resetCalls()
mine.onCell(ev({ id: 'templates' }))
mine.onCell(ev({ id: 'backup' }))
ok('入口跳转', calls.navigate[0] === '/packages/tools/templates/templates?from=mine' && calls.navigate[1] === '/packages/tools/backup/backup')
mine.onToggleAbout()
ok('关于展开', mine.data.aboutOpen === true)
const mineWxml = require('fs').readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8')
ok('关于里有隐私说明', mineWxml.indexOf('所有数据只保存在手机本地，不联网、不上传') >= 0)

/* ---------------- 零网络 ---------------- */
section('9. 零网络')
const fs = require('fs')
const mine2 = ['utils/trackStore.js', 'utils/matchJD.js', 'pages/track/track.js', 'pages/track-edit/track-edit.js', 'pages/mine/mine.js',
  'packages/tools/match/match.js', 'packages/tools/guide/guide.js', 'packages/tools/guide/guideData.js',
  'packages/tools/backup/backup.js', 'packages/tools/backup/backupUtil.js']
const netRe = /wx\.(request|uploadFile|downloadFile|connectSocket)\b|fetch\(|XMLHttpRequest/
ok('工具相关文件无任何网络调用', mine2.every((f) => !netRe.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))))

console.log('\n==============================')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
