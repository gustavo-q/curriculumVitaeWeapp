/**
 * 静态自检：在没有开发者工具的情况下也能发现大部分低级错误。
 *
 * 检查项：
 *   1. 每个页面 / 组件的 JS 能否被 require（语法、模块路径、循环依赖）
 *   2. app.json 里登记的页面文件是否齐全
 *   3. WXML 里绑定的事件处理函数是否真的存在于对应 JS（bindtap="xxx"）
 *   4. WXML 里用到的组件是否在该页 .json 的 usingComponents 里声明
 *   5. WXML 标签是否成对闭合
 *   6. 页面 setData 用到的 data 字段是否在 data 里声明过（提示级）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let errors = 0
let warnings = 0

const log = (kind, msg) => {
  if (kind === 'ERR') { errors++; console.log('  ✗ ' + msg) }
  else if (kind === 'WARN') { warnings++; console.log('  ! ' + msg) }
  else console.log('  ✓ ' + msg)
}

/* ---------------- wx / App / Page / Component 桩 ---------------- */
const storage = {}
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync: (k) => { delete storage[k] },
  createOffscreenCanvas: () => { throw new Error('no canvas headless') },
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, screenHeight: 812, safeArea: { bottom: 778 } }),
  getMenuButtonBoundingClientRect: () => ({ top: 24, height: 32 }),
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({ mkdirSync () {}, copyFileSync () {} })
}
let captured = null
global.App = (o) => { captured = o }
global.getApp = () => captured || { globalData: {} }
let pageObj = null
global.Page = (o) => { pageObj = o }
let compObj = null
global.Component = (o) => { compObj = o }
global.getCurrentPages = () => [{}]

const pages = []
const components = []

/* ---------------- 1. 模块可加载性 ---------------- */
console.log('\n[1] 模块加载')
function walk (dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const allFiles = walk(ROOT, []).filter((f) => !f.includes('/.work/') && !f.includes('/.work/'))

for (const f of allFiles.filter((x) => x.endsWith('.js'))) {
  const rel = path.relative(ROOT, f)
  if (!rel.startsWith('pages/') && !rel.startsWith('components/') && !rel.startsWith('utils/')) continue
  delete require.cache[require.resolve(f)]
  try {
    require(f)
    if (rel.startsWith('pages/')) pages.push({ rel, file: f, obj: pageObj })
    if (rel.startsWith('components/')) components.push({ rel, file: f, obj: compObj })
  } catch (e) {
    log('ERR', rel + ' 加载失败：' + e.message)
  }
}
console.log('  · 页面 ' + pages.length + ' 个，组件 ' + components.length + ' 个')

/* ---------------- 2. app.json 页面齐全 ---------------- */
console.log('\n[2] app.json 页面登记')
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
for (const p of appJson.pages) {
  const base = path.join(ROOT, p)
  for (const ext of ['.js', '.wxml', '.json']) {
    if (!fs.existsSync(base + ext)) log('ERR', p + ext + ' 缺失')
  }
}
log('OK', appJson.pages.length + ' 个页面文件齐全')

/* ---------------- 3/4/5. WXML 检查 ---------------- */
console.log('\n[3] WXML 事件绑定与组件声明')
// 小程序内置组件里带连字符的那些：不是自定义组件，不要求 usingComponents 声明
const BUILTIN_DASHED = new Set([
  'scroll-view', 'swiper-item', 'movable-view', 'movable-area', 'cover-view', 'cover-image',
  'rich-text', 'web-view', 'open-data', 'functional-page-navigator', 'official-account',
  'navigation-bar', 'page-meta', 'match-media', 'keyboard-accessory', 'page-container',
  'share-element', 'root-portal', 'live-player', 'live-pusher', 'voip-room',
  'channel-live', 'channel-video', 'open-container', 'ad-custom', 'picker-view-column'
])

function checkWxml (wxmlPath, jsObj, jsonPath, label) {
  const raw = fs.readFileSync(wxmlPath, 'utf8')
  // 剥离 HTML 注释后再做标签配对：注释里出现 <text> 这类字面量标签
  // 曾被误判成「标签不匹配」，wcc 实际编译是通过的。
  const src = raw.replace(/<!--[\s\S]*?-->/g, '')
  // --- 标签闭合 ---
  const stack = []
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>/g
  let m
  while ((m = tagRe.exec(src))) {
    const closing = m[1] === '/'
    const tag = m[2]
    // 只有显式 /> 才算自闭合；WXML 不像 HTML 那样有隐式 void 标签
    const selfClosed = m[4] === '/'
    if (closing) {
      const top = stack.pop()
      if (top !== tag) log('ERR', label + ' 标签闭合不匹配：</' + tag + '> 对应 <' + (top || '空栈') + '>')
    } else if (!selfClosed) {
      stack.push(tag)
    }
  }
  if (stack.length) log('ERR', label + ' 有未闭合标签：' + stack.join(', '))

  // --- 事件处理函数 ---
  if (jsObj) {
    const handlers = new Set()
    const collect = (o) => {
      if (!o) return
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'function') handlers.add(k)
        else if (k === 'methods' && o[k]) collect(o[k])
      }
    }
    collect(jsObj)
    const bindRe = /(?:bind|catch|capture-bind|capture-catch|mut-bind):?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g
    let b
    while ((b = bindRe.exec(src))) {
      const fn = b[2].trim()
      if (!fn || fn.includes('{{')) continue
      if (!handlers.has(fn)) log('ERR', label + ' 绑定了不存在的处理函数 ' + fn)
    }
  }

  // --- 组件声明 ---
  if (jsonPath && fs.existsSync(jsonPath)) {
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    const used = new Set()
    const tagRe2 = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g
    let t
    while ((t = tagRe2.exec(src))) used.add(t[1])
    const declared = j.usingComponents || {}
    // include 引入的片段里也可能用到组件，这里只检查主文件
    for (const u of used) {
      if (BUILTIN_DASHED.has(u)) continue
      if (!(u in declared)) log('ERR', label + ' 使用了未声明的组件 <' + u + '>')
    }
  }
}

for (const p of appJson.pages) {
  const wxml = path.join(ROOT, p + '.wxml')
  if (!fs.existsSync(wxml)) continue
  const page = pages.find((x) => x.file === path.join(ROOT, p + '.js'))
  checkWxml(wxml, page && page.obj, path.join(ROOT, p + '.json'), p)
}
for (const c of components) {
  const wxml = c.file.replace(/\.js$/, '.wxml')
  if (!fs.existsSync(wxml)) continue
  checkWxml(wxml, c.obj, c.file.replace(/\.js$/, '.json'), c.rel)
}
// 被 include 的片段也检查闭合
for (const frag of allFiles.filter((x) => x.endsWith('.wxml'))) {
  const rel = path.relative(ROOT, frag)
  if (!rel.startsWith('components/resume-paper/')) continue
  if (/\.js$/.test(rel)) continue
  // 同样先剥离注释，避免注释里的示例标签被当成真实节点
  const src = fs.readFileSync(frag, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const stack = []
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>/g
  let m
  let bad = false
  while ((m = tagRe.exec(src))) {
    const closing = m[1] === '/'
    const tag = m[2]
    const selfClosed = m[4] === '/'
    if (closing) { if (stack.pop() !== tag) bad = true }
    else if (!selfClosed) stack.push(tag)
  }
  if (bad || stack.length) log('ERR', rel + ' 片段标签不匹配 (' + stack.join(',') + ')')
}
log('OK', 'WXML 检查完成')

/* ---------------- 6. data 字段引用 ---------------- */
console.log('\n[4] 页面 data 字段覆盖')
for (const p of pages) {
  if (!p.obj || !p.obj.data) continue
  const wxml = p.file.replace(/\.js$/, '.wxml')
  if (!fs.existsSync(wxml)) continue
  const src = fs.readFileSync(wxml, 'utf8')
  const decl = new Set(Object.keys(p.obj.data))
  // 取 {{ }} 里的顶层标识符
  const refRe = /\{\{([^}]*)\}\}/g
  let r
  const missing = new Set()
  // wx:for 的循环变量（默认 item/index，或 wx:for-item / wx:for-index 指定的名字）
  const loopVars = new Set(['item', 'index'])
  const aliasRe = /wx:for-(item|index)\s*=\s*"([^"]+)"/g
  let a
  while ((a = aliasRe.exec(src))) loopVars.add(a[2].trim())
  while ((r = refRe.exec(src))) {
    // 去掉字符串字面量，避免把 class 名当成变量
    const expr = r[1].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
    // 去掉属性访问的尾巴（item.id → item）
    const cleaned = expr.replace(/\.\s*[A-Za-z_$][\w$]*/g, '')
    const ids = cleaned.match(/[A-Za-z_$][\w$]*/g) || []
    for (const id of ids) {
      if (['true', 'false', 'null', 'undefined', 'wx'].includes(id)) continue
      if (loopVars.has(id)) continue
      if (/^[a-z]/.test(id) && !decl.has(id)) missing.add(id)
    }
  }
  if (missing.size) log('WARN', p.rel + ' 可能未声明的 data 字段：' + [...missing].join(', '))
}

console.log('\n==============================')
console.log('错误 ' + errors + ' 个，警告 ' + warnings + ' 个')
process.exit(errors ? 1 : 0)
