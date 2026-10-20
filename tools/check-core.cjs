/**
 * 核心页面回归（手机端重做 v1）：pages/home · pages/edit · pages/entry · utils/store 新增 API。
 *
 * 写法与 tools/check-logic.cjs 一致：在 Node 里用 wx 桩真实驱动 onLoad / 手势 / 处理函数，
 * 断言 data 与 store（以及落盘的 storage）是否按预期变化。
 *
 *   node tools/check-core.cjs
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) } else {
    fail++
    failures.push(name + (detail ? ' :: ' + detail : ''))
    console.log('  ✗ ' + name + (detail ? ' :: ' + detail : ''))
  }
}
function section (t) { console.log('\n=== ' + t + ' ===') }

/* ---------------- wx 桩 ---------------- */
const storage = {}
const calls = { toast: [], modal: null, navigate: [], actionSheet: null, copied: [], unlinked: [], crop: null }
let modalAnswer = { confirm: true, content: '' }
let actionSheetPick = null // 数字：自动选中第几项；null 只记录不回调
let chooseMediaFile = null
let messageFile = null
let fileText = ''
let cropMode = 'ok' // ok | cancel | error | missing
let nextRects = []

const realCropImage = (o) => {
  calls.crop = o
  if (cropMode === 'cancel') return o.fail && o.fail({ errMsg: 'cropImage:fail cancel' })
  if (cropMode === 'error') return o.fail && o.fail({ errMsg: 'cropImage:fail internal' })
  o.success({ tempFilePath: '/tmp/cropped.jpg' })
}

global.wx = {
  getStorageSync: (k) => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync: (k) => { delete storage[k] },
  createOffscreenCanvas: () => { throw new Error('headless: no canvas') },
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, screenHeight: 812, safeArea: { bottom: 778 } }),
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, screenHeight: 812 }),
  getMenuButtonBoundingClientRect: () => ({ top: 26, height: 32, left: 281 }),
  showToast: (o) => calls.toast.push(o.title),
  showLoading: () => {},
  hideLoading: () => {},
  vibrateShort: () => {},
  showModal: (o) => {
    calls.modal = o
    if (o.success) o.success({ confirm: modalAnswer.confirm, cancel: !modalAnswer.confirm, content: modalAnswer.content })
  },
  showActionSheet: (o) => {
    calls.actionSheet = o
    if (actionSheetPick != null && o.success) {
      const i = typeof actionSheetPick === 'function' ? actionSheetPick(o.itemList) : actionSheetPick
      actionSheetPick = null
      o.success({ tapIndex: i })
    }
  },
  chooseMedia: (o) => { if (chooseMediaFile) o.success({ tempFiles: [chooseMediaFile] }) },
  chooseMessageFile: (o) => { if (messageFile) o.success({ tempFiles: [messageFile] }) },
  cropImage: realCropImage,
  navigateTo: (o) => calls.navigate.push(o.url),
  redirectTo: (o) => calls.navigate.push(o.url),
  reLaunch: (o) => calls.navigate.push(o.url),
  navigateBack: () => calls.navigate.push('back'),
  createSelectorQuery: () => ({
    in () { return this },
    select () { return this },
    selectAll () { return this },
    boundingClientRect () { return this },
    fields () { return this },
    exec: (cb) => cb([nextRects])
  }),
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({
    mkdirSync () {},
    copyFileSync (src, dest) { calls.copied.push([src, dest]) },
    readFile (o) { o.success({ data: fileText }) },
    unlink (o) { calls.unlinked.push(o.filePath); o.success && o.success() }
  })
}

let appObj = null
global.App = (o) => { appObj = o }
global.getApp = () => appObj
let lastPage = null
global.Page = (o) => { lastPage = o }
global.Component = () => {}
global.getCurrentPages = () => [{}, {}]

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

const mounted = []
function mount (pagePath, query) {
  lastPage = null
  delete require.cache[require.resolve(path.join(ROOT, pagePath))]
  require(path.join(ROOT, pagePath))
  const def = lastPage
  const inst = Object.assign({}, def)
  inst.data = JSON.parse(JSON.stringify(def.data || {}))
  inst.setData = function (patch, cb) { applySetData(inst.data, patch); if (cb) cb() }
  if (typeof def.onLoad === 'function') def.onLoad.call(inst, query || {})
  if (typeof def.onShow === 'function') def.onShow.call(inst)
  if (typeof def.onReady === 'function') def.onReady.call(inst)
  mounted.push(inst)
  return inst
}
function unmount (inst) {
  if (typeof inst.onUnload === 'function') inst.onUnload()
  const i = mounted.indexOf(inst)
  if (i >= 0) mounted.splice(i, 1)
}

const ev = (dataset, detail, targetDataset) => ({
  currentTarget: { dataset: dataset || {} },
  target: { dataset: targetDataset || dataset || {} },
  detail: detail || {}
})
const touchEv = (dataset, x, y, targetDataset) => ({
  currentTarget: { dataset: dataset || {} },
  target: { dataset: targetDataset || dataset || {} },
  touches: [{ clientX: x, clientY: y }],
  changedTouches: [{ clientX: x, clientY: y }],
  detail: {}
})

/**
 * 驱动一次触摸序列。
 * opts.longPress：按下后立刻触发长按（不真等定时器）；opts.target：e.target.dataset
 */
function touch (page, names, dataset, pts, opts) {
  const o = opts || {}
  page[names[0]](touchEv(dataset, pts[0][0], pts[0][1], o.target))
  const t = page._touch
  if (t && t.timer) {
    clearTimeout(t.timer)
    t.timer = null
    if (o.longPress) {
      if (dataset.list === 'head') { t.mode = 'done'; page.enterSortMode() } else page.enterDrag()
    }
  }
  for (let i = 1; i < pts.length; i++) page[names[1]](touchEv(dataset, pts[i][0], pts[i][1], o.target))
  const last = pts[pts.length - 1]
  page[names[2]](touchEv(dataset, last[0], last[1], o.target))
}
const HOME_T = ['onTouchStart', 'onTouchMove', 'onTouchEnd']
const ROW_T = ['onRowStart', 'onRowMove', 'onRowEnd']
const lastNav = () => calls.navigate[calls.navigate.length - 1]
const rectsFor = (n, h) => Array.from({ length: n }, (_, i) => ({ top: 100 + i * (h || 100), height: h || 100 }))

const store = require(path.join(ROOT, 'utils/store.js'))
const model = require(path.join(ROOT, 'utils/model.js'))
const persisted = () => storage.pb_drafts_v1 || []

/* ================================================================== */
section('1. 首页：列表 / 新建 / 打开')
const home = mount('pages/home/home.js')
ok('首次进入播种 1 份示例简历', home.data.cards.length === 1, 'cards=' + home.data.cards.length)
ok('卡片带缩略图 VM', !!(home.data.cards[0] && home.data.cards[0].vm))
ok('缩略图整页放进 168rpx 宽的框', 794 * home.data.thumbScale <= 168 * 375 / 750 + 0.01, 'scale=' + home.data.thumbScale)
ok('未归档区为空', home.data.archived.length === 0)

home.onFab()
ok('＋ 弹出三项', calls.actionSheet && calls.actionSheet.itemList.join('|') === '新建示例简历|新建空白简历|从聊天文件导入')
actionSheetPick = 1
home.onFab()
ok('新建空白简历 → 进编辑器', lastNav() === '/pages/edit/edit')
ok('空白简历成为当前', store.state.resume.baseInfo.name === '')
ok('列表 2 份', home.data.cards.length === 2)
actionSheetPick = 0
home.onFab()
ok('新建示例简历', home.data.cards.length === 3 && store.state.resume.baseInfo.name === '简历')

const firstId = home.data.cards[2].id
calls.navigate.length = 0
touch(home, HOME_T, { id: firstId, kind: 'active' }, [[50, 300]])
ok('点卡片 → 打开该份并进编辑器', store.state.resume.id === firstId && lastNav() === '/pages/edit/edit')

/* ---------------- 改名 ---------------- */
section('2. 首页：点标题就地改名')
touch(home, HOME_T, { id: firstId, kind: 'active' }, [[200, 300]], { target: { role: 'title' } })
ok('点标题进入改名而不是打开', home.data.renamingId === firstId && calls.navigate.length === 1)
home.onRenameDone(ev({}, { value: '  张三_产品经理  ' }))
ok('改名生效（去首尾空白）', store.state.drafts.find((d) => d.id === firstId).resumeName === '张三_产品经理')
ok('改名已落盘', persisted().find((d) => d.id === firstId).resumeName === '张三_产品经理')
ok('当前简历名同步', store.state.resume.resumeName === '张三_产品经理')
ok('改名后退出改名态', home.data.renamingId === '')
home.startRename(firstId)
home.onRenameDone(ev({}, { value: '   ' }))
ok('空名称被拒绝', store.state.drafts.find((d) => d.id === firstId).resumeName === '张三_产品经理')

/* ---------------- 左滑 ---------------- */
section('3. 首页：左滑 复制 · 归档 · 删除')
const topId = home.data.cards[0].id
touch(home, HOME_T, { id: topId, kind: 'active' }, [[300, 300], [260, 302], [150, 304]])
ok('左滑吸附展开到 408rpx', home.data.cards[0].offsetX === -408, 'x=' + home.data.cards[0].offsetX)
const navBefore = calls.navigate.length
touch(home, HOME_T, { id: topId, kind: 'active' }, [[100, 300]])
ok('展开时点卡片先收起、不打开', home.data.cards[0].offsetX === 0 && calls.navigate.length === navBefore)
touch(home, HOME_T, { id: topId, kind: 'active' }, [[300, 300], [290, 302], [270, 304]])
ok('滑不到一半回弹', home.data.cards[0].offsetX === 0)
touch(home, HOME_T, { id: topId, kind: 'active' }, [[300, 300], [303, 340], [305, 420]])
ok('纵向滑动不触发打开', calls.navigate.length === navBefore)

home.onDuplicate(ev({ id: firstId }))
ok('复制 → 多一份「副本」', home.data.cards.length === 4 && home.data.cards[0].name === '张三_产品经理 副本')

// 先打开 firstId 让它成为当前，再归档，验证内存副本同步
store.open(firstId)
home.onArchive(ev({ id: firstId }))
const arch = store.state.drafts.find((d) => d.id === firstId)
ok('归档：archived=true 且记 archivedAt', arch.archived === true && typeof arch.archivedAt === 'number')
ok('归档已落盘（同 Web 字段）', persisted().find((d) => d.id === firstId).archived === true)
ok('归档后离开卡片列表、进入已归档区', !home.data.cards.some((c) => c.id === firstId) && home.data.archived.some((c) => c.id === firstId))
ok('当前编辑的那份内存副本同步 archived', store.state.resume.archived === true)
store.setBaseInfo('name', '归档后继续改')
store.save(true)
ok('内容保存不改变归档状态', persisted().find((d) => d.id === firstId).archived === true)
store.setArchived(firstId, false)
store.snapshot()
store.undo()
store.save(true)
ok('撤销到旧快照再保存，也不会改动归档态（以列表为准）', persisted().find((d) => d.id === firstId).archived !== true)
store.archive(firstId)

home.onToggleArchived()
ok('已归档区可展开', home.data.archivedOpen === true)
touch(home, HOME_T, { id: firstId, kind: 'archived' }, [[300, 900], [250, 902], [120, 904]])
ok('归档行左滑展开 272rpx', home.data.archived[0].offsetX === -272)
home.onUnarchive(ev({ id: firstId }))
const unarch = store.state.drafts.find((d) => d.id === firstId)
ok('恢复：删除 archived/archivedAt 字段（不是置 false）', !('archived' in unarch) && !('archivedAt' in unarch))
ok('恢复后回到卡片列表', home.data.cards.some((c) => c.id === firstId) && home.data.archived.length === 0)
ok('归档区清空后自动收起', home.data.archivedOpen === false)

const nBefore = store.state.drafts.length
modalAnswer = { confirm: false }
home.onDelete(ev({ id: topId }))
ok('删除需确认：取消不删', store.state.drafts.length === nBefore && calls.modal.confirmText === '删除')
modalAnswer = { confirm: true }
home.onDelete(ev({ id: topId }))
ok('确认后删除', store.state.drafts.length === nBefore - 1 && !persisted().some((d) => d.id === topId))

/* ---------------- 拖动排序 ---------------- */
section('4. 首页：长按拖动排序（只在未归档子集内）')
const archId = home.data.cards[1].id
store.archive(archId)
const orderAll = () => store.state.drafts.map((d) => d.id)
const archSlot = orderAll().indexOf(archId)
const ids = home.data.cards.map((c) => c.id)
nextRects = rectsFor(ids.length, 150)
touch(home, HOME_T, { id: ids[0], kind: 'active' }, [[100, 150], [100, 260], [100, 100 + 150 * ids.length - 10]], { longPress: true })
ok('拖动结束恢复滚动', home.data.scrollEnabled === true && home.data.dragId === '')
const after = home.data.cards.map((c) => c.id)
ok('第一张拖到最后', after[after.length - 1] === ids[0], after.join(','))
ok('归档项在全数组里的槽位不变', orderAll().indexOf(archId) === archSlot)
ok('排序已落盘', persisted().map((d) => d.id).join() === orderAll().join())
const t0 = store.state.drafts.find((d) => d.id === ids[0]).updateDatetime
ok('排序不刷新更新时间', t0 === persisted().find((d) => d.id === ids[0]).updateDatetime)
ok('跨区移动被拒绝', store.moveDraft(archId, 0) === false)
store.unarchive(archId)

home.onHide()
const cardsRef = home.data.cards
store.emit()
ok('首页被遮住时不随广播重建缩略图', home.data.cards === cardsRef)
home.onShow()
ok('回到首页再刷新', home.data.cards !== cardsRef)

/* ================================================================== */
section('5. 导入：解析 / 查重 / 写入')
let p = store.parseImport('not json')
ok('非 JSON 拒绝', !p.ok && /JSON/.test(p.error))
p = store.parseImport('{"foo":1}')
ok('不是简历的对象拒绝', !p.ok)
p = store.parseImport('[]')
ok('空数组拒绝', !p.ok)
const webOne = model.createDefaultResume()
webOne.resumeName = 'Web导出_运营'
webOne.personalPhoto = 'avatar:woman'
webOne.archived = true
webOne.archivedAt = 123
p = store.parseImport('\uFEFF' + JSON.stringify(webOne))
ok('单份对象（含 BOM）', p.ok && p.kind === 'single' && p.list.length === 1)
p = store.parseImport(JSON.stringify([webOne, model.createBlankResume()]))
ok('Web「备份全部」数组', p.ok && p.kind === 'backup' && p.list.length === 2)
p = store.parseImport(JSON.stringify({ drafts: [webOne] }))
ok('{ drafts: [...] } 包装', p.ok && p.kind === 'backup')
p = store.parseImport(JSON.stringify(Array.from({ length: 51 }, () => ({ baseInfo: {} }))))
ok('超过 50 份拒绝', !p.ok && /50/.test(p.error))

const existingName = store.state.drafts[0].resumeName
const dupSrc = model.createDefaultResume()
dupSrc.resumeName = '  ' + existingName + ' '
p = store.parseImport(JSON.stringify([dupSrc, webOne]))
ok('查重按 trim 后同名', p.dup.dupCount === 1 && p.dup.dupNames[0] === existingName, JSON.stringify(p.dup))

let n0 = store.state.drafts.length
home.handleImportText(JSON.stringify(webOne))
let imported = store.state.drafts[0]
ok('单份导入：无重名直接写入、放最前', store.state.drafts.length === n0 + 1 && imported.resumeName === 'Web导出_运营')
ok('单份导入一律未归档', imported.archived === undefined && imported.archivedAt === undefined)
ok('导入分配新 id', imported.id !== webOne.id)
ok('导入保留 Web 头像标识', imported.personalPhoto === 'avatar:woman')
ok('导入已落盘', persisted()[0].id === imported.id)
ok('导入不切换当前编辑的简历', store.state.resume.id !== imported.id)

n0 = store.state.drafts.length
calls.actionSheet = null
const archivedBackup = model.createDefaultResume()
archivedBackup.resumeName = '备份里归档的那份'
archivedBackup.archived = true
archivedBackup.archivedAt = 456
home.handleImportText(JSON.stringify([dupSrc, archivedBackup]))
ok('有重名时先让用户选', calls.actionSheet && calls.actionSheet.itemList.length === 2 && /同名/.test(calls.actionSheet.alertText))
calls.actionSheet.success({ tapIndex: 1 })
ok('选「跳过同名」：只导入 1 份', store.state.drafts.length === n0 + 1)
ok('备份恢复保留归档标记', store.state.drafts[0].archived === true)
n0 = store.state.drafts.length
home.handleImportText(JSON.stringify([dupSrc]))
ok('全是重名时只给「全部导入」', calls.actionSheet.itemList.length === 1)
calls.actionSheet.success({ tapIndex: 0 })
ok('全部导入（同名也保留）', store.state.drafts.length === n0 + 1)

calls.modal = null
home.handleImportText('{"oops":true}')
ok('格式错误弹出说明', calls.modal && calls.modal.title === '无法导入')

n0 = store.state.drafts.length
const chatOne = model.createDefaultResume()
chatOne.resumeName = '聊天文件导入'
messageFile = { path: '/tmp/a.json', size: 1000, name: 'a.json' }
fileText = JSON.stringify(chatOne)
home.onImportFile()
ok('从聊天文件导入（chooseMessageFile → readFile）', store.state.drafts.length === n0 + 1 && store.state.drafts[0].resumeName === '聊天文件导入')

/* ================================================================== */
section('6. 编辑器：加载 / 基本信息')
store.create({ blank: false })
const rid = store.state.resume.id
calls.navigate.length = 0
const edit = mount('pages/edit/edit.js')
ok('基本信息 13 行', edit.data.baseRows.length === model.BASE_FIELDS.length)
ok('电话用数字键盘', edit.data.baseRows.find((x) => x.key === 'phone').kind === 'number')
ok('邮箱用邮箱输入', edit.data.baseRows.find((x) => x.key === 'email').kind === 'email')
ok('出生日期用年月选择器', edit.data.baseRows.find((x) => x.key === 'birthday').kind === 'month')
ok('区块卡片数 = 简历区块数', edit.data.sections.length === store.state.resume.sections.length)
ok('标题 = 简历名', edit.data.title === store.state.resume.resumeName)
const hit = /right:(\d+)px/.exec(edit.data.titleHitStyle)
ok('改名热区让开胶囊与「更多」', hit && Number(hit[1]) >= (375 - 281 + 8) + 64, edit.data.titleHitStyle)
ok('条目摘要取第一个非空栏', edit.data.sections[0].items[0].main === '学校名称')

edit.onInput(ev({ scope: 'base', key: 'name' }, { value: '李四' }))
ok('输入中不写 store', store.state.resume.baseInfo.name === '简历')
edit.onBlur(ev({ scope: 'base', key: 'name' }, { value: '李四' }))
ok('失焦写入 store', store.state.resume.baseInfo.name === '李四')
ok('写入后可撤销', edit.data.canUndo === true)
edit.onUndo()
ok('撤销恢复姓名', store.state.resume.baseInfo.name === '简历')
edit.onRedo()
ok('重做', store.state.resume.baseInfo.name === '李四')

edit.onConfirmNext(ev({ key: 'name' }, { value: '李四' }))
ok('姓名「下一项」跳过性别选择器、到年龄', edit.data.focusKey === 'age', edit.data.focusKey)
edit.onConfirmNext(ev({ key: 'phone' }, { value: '13800000000' }))
ok('电话「下一项」→ 邮箱，且电话已写入', edit.data.focusKey === 'email' && store.state.resume.baseInfo.phone === '13800000000')
edit.onConfirmNext(ev({ key: 'hometown' }, { value: '杭州' }))
ok('最后一项「下一项」收起键盘', edit.data.focusKey === '')
edit.onBirthday(ev({ key: 'birthday' }, { value: '1999-03' }))
ok('出生日期 → 1999.03', store.state.resume.baseInfo.birthday === '1999.03')
ok('选择器回显', edit.data.baseRows.find((x) => x.key === 'birthday').pickerValue === '1999-03')
edit.onGender(ev({}, { value: 1 }))
ok('性别选择器', store.state.resume.baseInfo.gender === '女')
const onBefore = store.state.resume.baseFields.indexOf('city') >= 0
edit.onToggleField(ev({ key: 'city' }))
ok('字段显示开关', (store.state.resume.baseFields.indexOf('city') >= 0) === !onBefore)
ok('开关状态回显', edit.data.baseRows.find((x) => x.key === 'city').on === !onBefore)

edit.onInput(ev({ scope: 'base', key: 'email' }, { value: 'a@b.com' }))
edit.commitPending({ quiet: true })
ok('自动保存静默落定输入中的值', store.state.resume.baseInfo.email === 'a@b.com')

/* ---------------- 照片 ---------------- */
section('7. 编辑器：照片')
edit.onPreset(ev({ url: 'avatar:woman' }))
ok('内置女头像', store.state.resume.personalPhoto === 'avatar:woman' && edit.data.photo.src === '/assets/avatar-woman.png')
edit.onCropRatio(ev({ id: 'two' }))
ok('二寸比例 → 照片框 5:7', store.state.resume.personalPhotoHeight === Math.round(store.state.resume.personalPhotoWidth * 7 / 5))
chooseMediaFile = { tempFilePath: '/tmp/raw.png', size: 1000 }
cropMode = 'ok'
edit.onChoosePhoto()
ok('裁剪用 3:4（二寸取最近的受支持比例）', calls.crop && calls.crop.cropScale === '3:4')
ok('裁剪结果复制到用户目录', /^\/tmp\/photos\/\d+\.jpg$/.test(store.state.resume.personalPhoto), store.state.resume.personalPhoto)
const photo1 = store.state.resume.personalPhoto
edit.onCropRatio(ev({ id: 'square' }))
cropMode = 'cancel'
edit.onChoosePhoto()
ok('取消裁剪不改照片', store.state.resume.personalPhoto === photo1)
cropMode = 'error'
edit.onChoosePhoto()
ok('裁剪出错退回原图', calls.copied[calls.copied.length - 1][0] === '/tmp/raw.png')
ok('换照片回收旧文件', calls.unlinked.indexOf(photo1) >= 0)
wx.cropImage = undefined
edit.onChoosePhoto()
ok('基础库无 cropImage 时直接用原图', /^\/tmp\/photos\//.test(store.state.resume.personalPhoto))
wx.cropImage = realCropImage
edit.onPhotoShape(ev({ id: 'circle' }))
ok('照片外形', store.state.resume.personalPhotoShape === 'circle' && edit.data.photo.shape === 'circle')
edit.onRemovePhoto()
ok('移除照片 + 撤销条', store.state.resume.personalPhoto === '' && edit.data.undoBar.show)
edit.onUndoBar()
ok('撤销恢复照片', !!store.state.resume.personalPhoto)

/* ---------------- 区块 ---------------- */
section('8. 编辑器：区块 / 条目')
const sec0 = edit.data.sections[0]
edit.onBlur(ev({ scope: 'section', sec: sec0.id }, { value: '教育经历' }))
ok('区块标题可改', store.getSection(sec0.id).title === '教育经历')
edit.onBlur(ev({ scope: 'section', sec: sec0.id }, { value: '  ' }))
ok('区块标题不能改成空', store.getSection(sec0.id).title === '教育经历')

calls.navigate.length = 0
touch(edit, ROW_T, { list: 'item', id: sec0.items[1].id, sec: sec0.id, index: 1 }, [[100, 300]])
ok('点条目 → 条目子页', lastNav() === '/pages/entry/entry?sectionId=' + sec0.id + '&itemId=' + sec0.items[1].id)

const itemsBefore = store.getSection(sec0.id).items.map((x) => x.id)
nextRects = rectsFor(itemsBefore.length, 60)
touch(edit, ROW_T, { list: 'item', id: itemsBefore[0], sec: sec0.id, index: 0 }, [[100, 120], [100, 200], [100, 290]], { longPress: true })
const itemsAfter = store.getSection(sec0.id).items.map((x) => x.id)
ok('长按拖动条目排序', itemsAfter[3] === itemsBefore[0] && itemsAfter.length === itemsBefore.length, itemsAfter.join(','))
ok('拖动结束恢复滚动', edit.data.scrollEnabled === true)
edit.onUndo()
ok('条目排序可撤销', store.getSection(sec0.id).items[0].id === itemsBefore[0])

calls.navigate.length = 0
edit.onAddItem(ev({ sec: sec0.id }))
const newItem = store.getSection(sec0.id).items.slice(-1)[0]
ok('添加条目 → 子页（isNew）', lastNav() === '/pages/entry/entry?sectionId=' + sec0.id + '&itemId=' + newItem.id + '&isNew=1')
ok('新条目沿用上一条的排版', newItem.type === 'ONE')

const secIds = edit.data.sections.map((s) => s.id)
touch(edit, ROW_T, { list: 'head', id: secIds[1], index: 1 }, [[300, 400], [250, 402], [120, 404]])
ok('区块标题栏左滑展开 300rpx', edit.data.sections[1].offsetX === -300)
edit.onHeadToggle(ev({ sec: secIds[1] }))
ok('左滑「隐藏」', store.getSection(secIds[1]).visible === false && edit.data.sections[1].visible === false)
edit.onHeadToggle(ev({ sec: secIds[1] }))
ok('再点「显示」', store.getSection(secIds[1]).visible === true)

const delTitle = store.getSection(secIds[1]).title
edit.onHeadDelete(ev({ sec: secIds[1] }))
ok('左滑「删除」立即删除', !store.getSection(secIds[1]))
ok('出现「已删除 · 撤销」条', edit.data.undoBar.show && edit.data.undoBar.label.indexOf(delTitle) >= 0)
edit.onUndoBar()
ok('撤销条恢复区块（原位置）', store.state.resume.sections[1] && store.state.resume.sections[1].id === secIds[1])
ok('撤销后撤销条消失', edit.data.undoBar.show === false)
ok('撤销结果已落盘', persisted().find((d) => d.id === rid).sections[1].id === secIds[1])

touch(edit, ROW_T, { list: 'head', id: secIds[2], index: 2 }, [[300, 400]], { longPress: true })
ok('长按区块标题栏 → 调整顺序模式', edit.data.sortMode === true && edit.data.sortRows.length === secIds.length)
nextRects = rectsFor(secIds.length, 120)
touch(edit, ROW_T, { list: 'sort', id: secIds[0], index: 0 }, [[340, 150], [340, 300], [340, 100 + 120 * secIds.length - 5]])
const secAfter = store.state.resume.sections.map((s) => s.id)
ok('把手拖动区块到最后', secAfter[secAfter.length - 1] === secIds[0], secAfter.join(','))
edit.exitSortMode()
ok('完成退出排序模式', edit.data.sortMode === false)
ok('卡片顺序跟着变', edit.data.sections[edit.data.sections.length - 1].id === secIds[0])

actionSheetPick = 0
const nSec = store.state.resume.sections.length
edit.onAddSection()
ok('添加预设区块', store.state.resume.sections.length === nSec + 1)
ok('添加后滚到新区块', edit.data.scrollInto === 'sec-' + store.state.resume.sections[nSec].id)
actionSheetPick = (list) => list.indexOf('自定义名称…')
modalAnswer = { confirm: true, content: '志愿者经历' }
edit.onAddSection()
ok('自定义区块名', store.state.resume.sections.slice(-1)[0].title === '志愿者经历')

edit.onGuide(ev({ title: '实习经历' }))
ok('「这一栏怎么写」→ 攻略', lastNav() === '/packages/tools/guide/guide?topic=' + encodeURIComponent('实习经历'))

/* ---------------- 从其他简历复制 ---------------- */
section('9. 编辑器：从其他简历复制')
const other = store.state.drafts.find((d) => d.id !== rid && (d.sections || []).length >= 2)
const targetId = store.state.resume.sections[0].id
const targetCount = store.getSection(targetId).items.length
edit.openCopySheet(targetId)
ok('弹层列出其他简历（不含当前）', edit.data.copySheet.show && !edit.data.copySheet.drafts.some((d) => d.id === rid) && edit.data.copySheet.drafts.length === store.state.drafts.length - 1)
const di = edit.data.copySheet.drafts.findIndex((d) => d.id === other.id)
edit.onCopyDraftToggle(ev({ di }))
ok('展开简历看到区块', edit.data.copySheet.drafts[di].open === true)
edit.onCopyItemToggle(ev({ di, si: 0, ii: 0 }))
edit.onCopyItemToggle(ev({ di, si: 1, ii: 0 }))
ok('勾选计数', edit.data.copySheet.count === 2)
edit.onCopySelected()
ok('选中的 2 条加进当前区块', store.getSection(targetId).items.length === targetCount + 2)
const copied = store.getSection(targetId).items.slice(-1)[0]
ok('复制品换新 id', !other.sections.some((s) => s.items.some((it) => it.id === copied.id)))
ok('弹层关闭', edit.data.copySheet.show === false)
edit.onUndo()
ok('复制可撤销', store.getSection(targetId).items.length === targetCount + 1)
const nSec2 = store.state.resume.sections.length
edit.openCopySheet(targetId)
edit.onCopyWholeSection(ev({ di, si: 0 }))
ok('整块复制为新区块', store.state.resume.sections.length === nSec2 + 1)
ok('copySectionFrom 不存在的区块返回 null', store.copySectionFrom(other.id, 'nope') === null)

/* ---------------- 导航 ---------------- */
section('10. 编辑器：底栏 / 更多 / 定位')
edit.onTab(ev({ tab: 'style' }))
ok('样式 → 预览页 style 面板', lastNav() === '/pages/preview/preview?panel=style')
edit.onTab(ev({ tab: 'export' }))
ok('导出 → 预览页 export 面板', lastNav() === '/pages/preview/preview?panel=export')
edit.onTab(ev({ tab: 'preview' }))
ok('预览', lastNav() === '/pages/preview/preview')
actionSheetPick = 2
edit.onMore()
ok('更多 → 切换模板', lastNav() === '/packages/tools/templates/templates')
actionSheetPick = 3
edit.onMore()
ok('更多 → JD 匹配带简历 id', lastNav() === '/packages/tools/match/match?id=' + rid)
modalAnswer = { confirm: true, content: '王五_运营' }
edit.onRename()
ok('点标题改名', store.state.resume.resumeName === '王五_运营' && edit.data.title === '王五_运营')

const focusSec = store.state.resume.sections[2].id
unmount(edit)
const edit2 = mount('pages/edit/edit.js', { focus: focusSec })
ok('focus=<sectionId> 滚到该区块', edit2.data.scrollInto === 'sec-' + focusSec)
unmount(edit2)
const edit3 = mount('pages/edit/edit.js', { focus: 'photo' })
ok('focus=photo', edit3.data.scrollInto === 'card-photo')
appObj.globalData.pendingFocus = 'base'
edit3.onShow()
ok('globalData.pendingFocus（预览页 navigateBack 定位）', edit3.data.scrollInto === 'card-base' && appObj.globalData.pendingFocus === '')
edit3.onInput(ev({ scope: 'base', key: 'city' }, { value: '深圳' }))
edit3.onHide()
ok('onHide 落定输入并落盘', persisted().find((d) => d.id === rid).baseInfo.city === '深圳' && !store.state.dirty)

/* ================================================================== */
section('11. 条目子页：排版切换 / 时间 / 删除撤销')
const E = require(path.join(ROOT, 'pages/entry/entry.js'))
ok('解析「2021.09 - 至今」', JSON.stringify(E.parseTime('2021.09 - 至今')) === JSON.stringify({ start: '2021-09', end: '', present: true }))
ok('解析「2020.9-2024.06」', JSON.stringify(E.parseTime('2020.9-2024.06')) === JSON.stringify({ start: '2020-09', end: '2024-06', present: false }))
ok('解析「2019年7月 至 2020年1月」', E.parseTime('2019年7月 至 2020年1月').end === '2020-01')
ok('解析单个年月', E.parseTime('2023/05').start === '2023-05')
ok('占位写法「201x.09-202x.06」无法解析', E.parseTime('201x.09-202x.06') === null)
ok('月份越界无法解析', E.parseTime('2020.13 - 至今') === null)
ok('格式化 起止', E.formatTime('2021-09', '2024-06', false) === '2021.09 - 2024.06')
ok('格式化 至今', E.formatTime('2021-09', '', true) === '2021.09 - 至今')
ok('格式化 只有开始', E.formatTime('2021-09', '', false) === '2021.09')

const eSec = store.state.resume.sections.find((s) => s.items.some((it) => it.type === 'THREE'))
const eItem = eSec.items.find((it) => it.type === 'THREE')
const origRight = eItem.rightContent
const entry = mount('pages/entry/entry.js', { sectionId: eSec.id, itemId: eItem.id })
ok('三栏：标题 / 说明 / 时间 都显示', entry.data.showTitle && entry.data.showDesc && entry.data.showTime)
ok('示例时间是占位写法 → 自动手动输入模式', entry.data.timeFree === true)
entry.onBlur(ev({ field: 'leftContent' }, { value: '复旦大学' }))
ok('标题写入 leftContent', store.getItem(eSec.id, eItem.id).leftContent === '复旦大学')
entry.onInput(ev({ field: 'centerContent' }, { value: '金融学\n辅修计算机' }))
entry.onSetType(ev({ type: 'ONE' }))
const afterOne = store.getItem(eSec.id, eItem.id)
ok('切到一行文字：只显示内容', !entry.data.showTitle && entry.data.showDesc && !entry.data.showTime && entry.data.descLabel === '内容')
ok('切换前输入中的说明已落定', afterOne.centerContent === '金融学\n辅修计算机')
ok('切换不丢标题与时间', afterOne.leftContent === '复旦大学' && afterOne.rightContent === origRight)
entry.onSetType(ev({ type: 'TWO' }))
ok('左右两栏：标题 + 时间', entry.data.showTitle && !entry.data.showDesc && entry.data.showTime)
entry.onSetType(ev({ type: 'THREE' }))
ok('切回三栏内容都在', entry.data.left === '复旦大学' && entry.data.center === '金融学\n辅修计算机')

entry.onTitleNext(ev({}, { value: '复旦大学' }))
ok('标题「下一项」→ 说明', entry.data.focusField === 'centerContent')

entry.onToggleTimeFree()
ok('无法解析的时间切到滚轮：清空选择、不覆盖原文', entry.data.timeFree === false && entry.data.start === '' && store.getItem(eSec.id, eItem.id).rightContent === origRight)
entry.onStart(ev({}, { value: '2021-09' }))
ok('选开始 → 2021.09', store.getItem(eSec.id, eItem.id).rightContent === '2021.09')
entry.onEnd(ev({}, { value: '2020-01' }))
ok('结束早于开始被拒绝', store.getItem(eSec.id, eItem.id).rightContent === '2021.09')
entry.onEnd(ev({}, { value: '2024-06' }))
ok('选结束 → 2021.09 - 2024.06', store.getItem(eSec.id, eItem.id).rightContent === '2021.09 - 2024.06')
entry.onTogglePresent()
ok('至今 → 2021.09 - 至今', store.getItem(eSec.id, eItem.id).rightContent === '2021.09 - 至今' && entry.data.end === '')
entry.onToggleTimeFree()
entry.onBlur(ev({ field: 'rightContent' }, { value: '2021 秋 - 至今' }))
ok('手动输入时间', store.getItem(eSec.id, eItem.id).rightContent === '2021 秋 - 至今')
entry.onToggleTimeFree()
entry.onToggleTimeFree()
ok('手写内容来回切换不丢', store.getItem(eSec.id, eItem.id).rightContent === '2021 秋 - 至今')

store.commitTextHistory()
store.undo()
ok('子页的修改可撤销', store.getItem(eSec.id, eItem.id).rightContent === '2021.09 - 至今')

calls.navigate.length = 0
entry.onDone()
ok('完成 → 返回', lastNav() === 'back')
unmount(entry)

const nItems = store.getSection(eSec.id).items.length
const entry2 = mount('pages/entry/entry.js', { sectionId: eSec.id, itemId: eItem.id })
entry2.onDelete()
ok('删除此条目 → 返回', lastNav() === 'back' && store.getSection(eSec.id).items.length === nItems - 1)
unmount(entry2)
ok('删除后 unload 不再误删别的', store.getSection(eSec.id).items.length === nItems - 1)
edit3.onShow()
ok('返回编辑器显示「已删除 · 撤销」', edit3.data.undoBar.show === true)
edit3.onUndoBar()
ok('撤销恢复条目', !!store.getItem(eSec.id, eItem.id) && store.getSection(eSec.id).items.length === nItems)

const blankId = store.addItem(eSec.id, 'THREE')
const entry3 = mount('pages/entry/entry.js', { sectionId: eSec.id, itemId: blankId, isNew: '1' })
unmount(entry3)
ok('新建条目什么都没填就返回 → 不留空行', !store.getItem(eSec.id, blankId))
const keepId = store.addItem(eSec.id, 'ONE')
const entry4 = mount('pages/entry/entry.js', { sectionId: eSec.id, itemId: keepId, isNew: '1' })
ok('一行文字新条目只显示内容框', entry4.data.showDesc && !entry4.data.showTitle)
entry4.onInput(ev({ field: 'centerContent' }, { value: '组织 200 人校园活动' }))
unmount(entry4)
ok('新条目填了内容（未失焦）也会保存', store.getItem(eSec.id, keepId).centerContent === '组织 200 人校园活动' && !store.state.dirty)

calls.navigate.length = 0
const entry5 = mount('pages/entry/entry.js', { sectionId: 'nope', itemId: 'nope' })
ok('条目不存在时提示', calls.toast.slice(-1)[0] === '这条内容已不存在')
void entry5

/* ================================================================== */
section('12. 算法冒烟（onePage / layout 不受本次改动影响）')
try {
  const L = require(path.join(ROOT, 'utils/layout.js'))
  const onePage = require(path.join(ROOT, 'utils/onePage.js'))
  const r = model.createDefaultResume()
  const pag = L.paginateResume(r, null, { editable: false })
  ok('分页可算', pag && pag.pages >= 1)
  const start = onePage.readFitParams(r)
  const res = onePage.fitOnePageSmart(start, L.measureHeight(r), L.A4_H)
  ok('智能一页可算', !!res)
} catch (e) {
  ok('算法冒烟无异常', false, e.message)
}

/* ================================================================== */
mounted.slice().forEach((p) => { try { unmount(p) } catch (e) {} })
console.log('\n==============================')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
