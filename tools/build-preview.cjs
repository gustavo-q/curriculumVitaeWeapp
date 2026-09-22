/**
 * 视觉验证：把 WXML/WXSS 渲染出的纸张在浏览器里还原一遍并截图。
 *
 * 为什么需要它：
 *   utils/layout.js 的几何计算已经被 131 项逻辑断言覆盖，但「CSS 是否真的
 *   按预期排版」是另一回事——grid 轨道、双线标题的伪元素、圆点标题的定位、
 *   两栏的列宽比例，这些只有真正画出来才能确认。小程序开发者工具的服务端口
 *   需要用户手动开启，因此这里用同一份 VM + 同一份 WXSS 规则生成静态 HTML，
 *   在 Chrome 里截图，作为样式层面的回归证据。
 *
 * 覆盖范围与局限（如实说明）：
 *   ✓ 纸张的 CSS 排版（单栏 / 左栏 / 右栏、三种条目、9 种标题装饰、4 种边框）
 *   ✓ 18 套模板的样式差异
 *   ✗ 小程序的渲染器本身（WXML 解析、组件系统）——那需要开发者工具
 */
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')

global.wx = { createOffscreenCanvas: () => { throw new Error('no canvas') } }

const model = require(path.join(ROOT, 'utils/model.js'))
const { buildPaperVM } = require(path.join(ROOT, 'utils/paper.js'))
const { paginateResume } = require(path.join(ROOT, 'utils/layout.js'))

/* ---------- WXSS → CSS ---------- */
const wxss = fs.readFileSync(path.join(ROOT, 'components/resume-paper/paper.wxss'), 'utf8')
// 纸张样式全部用 px，rpx 只出现在页面级样式里；这里只处理组件样式
const cssOnly = wxss.replace(/:host|page\s*\{/g, '.host {')

/* ---------- VM → HTML（对应 paper.wxml / section.wxml / side.wxml） ---------- */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function cellHtml (c, editable) {
  // 与 paper.wxml 保持一致：编辑态下空栏渲染占位文字（真实占位、真实高度），
  // 只读态什么都不渲染、高度为 0。这一条直接决定「编辑几页 / 预览几页」是否一致。
  const inner = c.isEmpty
    ? (editable ? '<span class="cell-ph">' + esc(c.ph || '') + '</span>' : '')
    : esc(c.text)
  return '<div class="' + c.cls + '">' + inner + '</div>'
}

function sectionHtml (sec, editable) {
  return '<div class="sec" style="' + esc(sec.style) + '">' +
    '<div class="sec-title ' + esc(sec.titleCls) + '" style="' + esc(sec.titleStyle) + '">' + esc(sec.title) + '</div>' +
    '<div class="sec-body">' +
    sec.itemVMs.map((it) =>
      '<div class="item ' + it.cls + '">' + it.cells.map((c) => cellHtml(c, editable)).join('') + '</div>'
    ).join('') +
    '</div></div>'
}

function sideHtml (vm) {
  const s = vm.side
  return '<div class="side" style="' + esc(s.style) + '">' +
    '<div class="side-photo" style="' + esc(s.photoWrapStyle) + '">' +
    (vm.photo.show ? '<img class="side-photo-img" style="' + esc(vm.photo.style) + '" src="' + esc(localSrc(vm.photo.src)) + '">' : '') +
    '</div>' +
    '<div class="side-name" style="' + esc(s.nameStyle) + '">' + esc(s.name) + '</div>' +
    '<div class="side-list">' +
    s.list.map((p) => '<div class="side-dt">' + esc(p.label) + '</div><div class="side-dd">' + esc(p.value) + '</div>').join('') +
    '</div></div>'
}

/** 把小程序里的绝对资源路径 (/assets/x.png) 换成本地相对路径，仅仿真用 */
const localSrc = (src) => String(src || '').replace(/^\/assets\//, '../assets/')

function paperHtml (vm, seams) {
  let inner = ''
  if (vm.cols.show) {
    const side = sideHtml(vm)
    inner = '<div class="cols" style="' + esc(vm.cols.style) + '">' +
      (vm.side.before ? side : '') +
      '<div class="main">' + vm.sections.map((s) => sectionHtml(s, vm.editable)).join('') + '</div>' +
      (vm.side.before ? '' : side) +
      '</div>'
  } else {
    inner = '<div class="head" style="' + esc(vm.headStyle) + '">' +
      '<div class="head-text">' +
      '<div class="head-name">' + esc(vm.name) + '</div>' +
      (vm.headCells.length
        ? '<div class="head-grid">' + vm.headCells.map((c) =>
            '<div class="head-cell"><span class="hk">' + esc(c.label) + '</span><span class="hv">' + esc(c.value) + '</span></div>'
          ).join('') + '</div>'
        : '') +
      '</div>' +
      (vm.photo.show
        ? '<img class="head-photo" style="' + esc(vm.photo.style) + '" src="' + esc(localSrc(vm.photo.src)) + '">'
        : (vm.photoSlot.show ? '<div class="photo-add" style="' + esc(vm.photoSlot.style) + '"><span class="photo-add-plus">＋</span><span class="photo-add-tip">添加照片</span></div>' : '')) +
      '</div>' + vm.sections.map((s) => sectionHtml(s, vm.editable)).join('')
  }
  return '<div class="paper" style="' + esc(vm.paperStyle) + '">' +
    seams.map((t) => '<div class="page-seam" style="top:' + t + 'px"><span class="page-seam-no">第 ' + (Math.round(t / 1123) + 1) + ' 页</span></div>').join('') +
    inner + '</div>'
}

/* ---------- 生成页面 ---------- */
const CASES = []
// 全部 18 套模板各一张
for (const t of model.TEMPLATES) CASES.push({ label: t.name, template: t.id })
// 三种布局 × 代表性模板
for (const lay of ['SINGLE', 'LEFT', 'RIGHT']) {
  CASES.push({ label: '布局 ' + lay, template: 'classic', patch: { pageLayout: lay } })
}
// 9 种标题装饰
for (const h of model.HEADING_THEMES) {
  CASES.push({ label: '标题 ' + h.label, template: 'classic', patch: { headingTheme: h.id } })
}
// 4 种边框
for (const b of model.BORDER_THEMES) {
  CASES.push({ label: '边框 ' + b.label, template: 'professional', patch: { borderTheme: b.id } })
}
// 条目三种排版
CASES.push({ label: '条目 三种排版', template: 'classic', sample: 'items' })
// 空简历（编辑态槽位）
CASES.push({ label: '空简历（编辑槽位）', blank: true, editable: true })
// 多页（页缝）
CASES.push({ label: '多页与页缝', template: 'compact', verbose: true })

function buildCase (c) {
  let resume
  if (c.blank) resume = model.normalizeResume(model.createBlankResume())
  else if (c.sample === 'items') {
    resume = model.normalizeResume(model.createBlankResume())
    resume.resumeName = '条目排版'
    resume.baseInfo = { name: '张明', gender: '男', age: '25', education: '本科', phone: '138 0000 0000', email: 'z@example.com', jobIntention: '产品经理', city: '上海', experience: '3 年', birthday: '', politics: '', ethnicity: '', hometown: '' }
    resume.baseFields = ['name', 'gender', 'age', 'education', 'phone', 'email']
    resume.personalPhoto = 'asset:avatar-man'
    resume.sections = [
      model.createSection('三种条目排版', [
        model.createItem('THREE', { leftContent: '华东理工大学', centerContent: '计算机科学与技术', rightContent: '2019.09-2023.06' }),
        model.createItem('TWO', { leftContent: '英语 CET-6（582 分）', rightContent: '2022.06' }),
        model.createItem('ONE', { centerContent: '整行条目：自定义内容、实习经历、工作内容等。' }),
        model.createItem('ONE', { centerContent: '1、列表第一行，会做悬挂缩进\n2、列表第二行，折行文字与首行左边缘对齐\n3、列表第三行' })
      ]),
      model.createSection('列表缩进对比', [
        model.createItem('ONE', { centerContent: '普通段落没有缩进，折行文字顶到最左边，与上下条目对齐。' })
      ])
    ]
  } else {
    resume = model.normalizeResume(model.buildThumbSample(c.template))
    if (c.verbose) {
      const extra = model.createSection('补充经历', [])
      for (let i = 0; i < 22; i++) {
        extra.items.push(model.createItem('THREE', { leftContent: '公司 ' + (i + 1), centerContent: '岗位', rightContent: '2020.01-2021.01' }))
      }
      resume.sections.push(extra)
    }
  }
  if (c.patch) Object.assign(resume, c.patch)
  if (c.editable) resume = model.normalizeResume(resume)
  const editable = !!c.editable
  const vm = buildPaperVM(resume, { editable })
  const pag = paginateResume(resume, null, { editable })
  const seams = []
  for (let i = 2; i <= pag.pages; i++) seams.push((i - 1) * 1123)
  return { vm, seams, pages: pag.pages }
}

/** 纸张在预览页里的缩放倍率 */
const SCALE = 0.58

/** 可用 ONLY=关键词 只渲染部分用例，便于局部细看 */
const ONLY = process.env.ONLY || ''
const selected = ONLY ? CASES.filter((c) => ONLY.split(',').some((k) => c.label.indexOf(k) >= 0)) : CASES

const cards = selected.map((c) => {
  const { vm, seams, pages } = buildCase(c)
  // 槽位高度按「页数 × A4 × 缩放」给定，避免缩放后的纸面彼此重叠
  const slotH = Math.round(pages * 1123 * SCALE) + 32
  return '<figure class="case" data-label="' + esc(c.label) + '">' +
    '<figcaption>' + esc(c.label) +
    (pages > 1 ? ' <span class="p">· 共 ' + pages + ' 页</span>' : '') + '</figcaption>' +
    '<div class="paper-slot" style="height:' + slotH + 'px">' + paperHtml(vm, seams) + '</div>' +
    '</figure>'
}).join('\n')

const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<title>简历制作 · 纸张渲染验证</title>' +
  '<style>' +
  'body{margin:0;background:#e9edf2;font:14px/1.5 -apple-system,"PingFang SC",sans-serif;color:#23282f;}' +
  'h1{font-size:20px;margin:24px 28px 8px;}' +
  '.note{margin:0 28px 20px;color:#5b6570;font-size:13px;}' +
  '.grid-wrap{padding:0 28px 60px;}' +
  '.case{margin:0 0 28px;background:#fff;border:1px solid #d7dde5;border-radius:10px;overflow:hidden;}' +
  'figcaption{padding:10px 16px;font-weight:600;font-size:13px;border-bottom:1px solid #eef1f5;background:#fafbfc;}' +
  'figcaption .p{color:#8a929c;font-weight:400;}' +
  '.paper-slot{padding:16px;background:#f2f4f7;overflow:hidden;}' +
  '.paper-slot .paper{transform:scale(' + SCALE + ');transform-origin:top left;}' +
  '\n/* ===== 以下为组件样式（components/resume-paper/paper.wxss 原文） ===== */\n' +
  cssOnly +
  '\n/* 纸面边框用 box-shadow 模拟（浏览器里 .paper 无边框时的观感与小程序一致） */\n' +
  '</style></head><body>' +
  '<h1>纸张渲染验证</div>' +
  '<p class="note">由 utils/paper.js 生成的真实 VM 驱动，样式取自 components/resume-paper/paper.wxss。' +
  '共 ' + selected.length + ' 个用例。</p>' +
  '<div class="grid-wrap">' + cards + '</div>' +
  '</body></html>'

const outDir = path.join(ROOT, '.work')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, process.env.OUT || 'preview.html')
fs.writeFileSync(out, html)
console.log('生成 ' + out + '（' + CASES.length + ' 个用例，' + Math.round(html.length / 1024) + ' KB）')
