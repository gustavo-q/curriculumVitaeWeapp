/**
 * 编辑器界面截图：把编辑页布局在无头 Chrome 里真正画出来并截图，
 * 用于肉眼确认「按钮位置、菜单层级、触控区大小」是否符合预期。
 *
 * 用法：node tools/shot-edit.cjs
 * 产物：.work/shot-edit-*.png
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE = path.join(ROOT, '.work/chrome-shot')
const PORT = 9544
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pageCss () {
  let css = fs.readFileSync(path.join(ROOT, 'pages/edit/edit.wxss'), 'utf8')
  css = css.replace(/([0-9.]+)rpx/g, (m, n) => (parseFloat(n) * 375) / 750 + 'px')
  css = css.replace(/(^|\n)\s*page\s*\{/g, '$1#page {')
  let app = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  app = app.replace(/([0-9.]+)rpx/g, (m, n) => (parseFloat(n) * 375) / 750 + 'px')
  app = app.replace(/page\s*\{/g, '#page {')
  // 小程序元素默认 display:block，浏览器里补齐，避免布局与真机不一致
  app += '\nview,scroll-view{display:block;}\n'
  return app + '\n' + css
}

const PAPER = 1123 * 0.45
/** 纸面缩放倍率：与 edit.js 的 fit() 一致（可用宽度 / 794） */
const ZOOM = Math.round(((375 - 12) / 794) * 1000) / 1000

function html (opts) {
  const o = Object.assign({ panel: 'sections', menu: false }, opts || {})
  /*
   * 目录行与 pages/edit/edit.wxml 保持一致：只有标题，没有「编辑」按钮。
   * 结构 .dir-row > (.dir-acts + .dir-face)，两轴位移分层：
   * 行上的 translateY 用于拖动排序，内容面上的 translateX 用于左滑。
   * 截图脚本必须复刻真实结构，否则截出来的不是用户看到的样子。
   * opts.swipeIndex 指定某一行处于「左滑展开」状态，opts.dragIndex 指定某行处于拖动中。
   */
  const swipeAt = typeof o.swipeIndex === 'number' ? o.swipeIndex : -1
  const dragAt = typeof o.dragIndex === 'number' ? o.dragIndex : -1
  /* 目录行动作层是两个动作（隐藏 + 删除），总宽 300rpx = 150px @375 */
  const actions = `<div class="dir-acts"><div class="act act-toggle">隐藏</div><div class="act act-del">删除</div></div>`
  const sections = Array.from({ length: 7 }).map((_, i) => `
    <div class="dir-row${i === dragAt ? ' dragging' : ''}" style="transform:translateY(${i === dragAt ? -30 : 0}px);z-index:${i === dragAt ? 3 : 1}">
      ${actions}
      <div class="dir-face${i === dragAt ? ' moving' : ''}" style="transform:translateX(${i === swipeAt ? -150 : 0}px)">
        <span class="dir-title ellipsis">${['教育背景', '实习经历', '项目经历', '技能证书', '校园经历', '自我评价', '荣誉奖项'][i]}</span>
        ${i === 5 ? '<span class="dir-flag">已隐藏</span>' : ''}
        <span class="dir-grip">⠿</span>
      </div>
    </div>`).join('')

  const items = Array.from({ length: 5 }).map((_, i) => `
    <div class="item-row${i === 1 ? ' on' : ''}">
      <div class="row-del">删除</div>
      <div class="item-face">
        <span class="item-idx">${i + 1}</span>
        <div class="grow"><div class="item-line"><span class="tag">${['三栏', '一行', '两栏', '一行', '一行'][i]}</span>
        <span class="item-preview ellipsis">${['华东理工大学 · 计算机科学与技术', 'GPA 3.8/4.0（专业前 5%）', '英语六级 580', '校级一等奖学金', '主导流程重构，人均处理时长下降 30%'][i]}</span></div></div>
      </div>
    </div>`).join('')

  /* 条目排版示意图：与 edit.wxml 的 .shape-row 同一结构（三条灰条 = 三栏） */
  const shapeRow = (on) => `<div class="shape-row">${[
    ['ONE', '一行文字', 1], ['TWO', '左右两栏', 2], ['THREE', '左中右三栏', 3]
  ].map(([id, label, n]) => `<div class="shape${id === on ? ' on' : ''}">
      <div class="shape-demo">${Array.from({ length: n }).map(() => '<div class="shape-line"></div>').join('')}</div>
      <span class="shape-label">${label}</span>
    </div>`).join('')}</div>`

  const panelInner = {
    sections: `<div class="hint">点标题进入编辑 · 长按拖动排序 · 左滑可隐藏或删除</div>${sections}
      <div class="btn btn-primary panel-add">＋ 新增区块</div>`,
    section: `<div class="field field-inline"><div class="grow"><span class="field-label">区块名称</span><div class="field-input">教育背景</div></div></div>
      <div class="hint hint-tight">显示 / 隐藏在目录里左滑这一行切换。</div>
      <div class="sect-title"><span class="bar"></span><span>条目（5）</span></div>
      <div class="hint">点一下编辑内容 · 长按拖动排序 · 左滑删除</div>${items}
      <div class="btn btn-primary panel-add">＋ 添加条目</div>`,
    item: `<div class="hint">第 1 条 / 共 5 条</div>
      <div class="sect-title"><span class="bar"></span><span>这一条怎么排</span></div>
      ${shapeRow('THREE')}
      <div class="hint">标题 + 说明 + 时间三栏，适合学校、公司、项目经历。</div>
      <div class="field"><span class="field-label">标题</span><div class="field-input">华东理工大学</div></div>
      <div class="field"><span class="field-label">说明</span><div class="field-input">计算机科学与技术</div></div>
      <div class="field"><span class="field-label">时间</span><div class="field-input">2019.09 - 2023.06</div></div>
      <div class="hint hint-tight">换排版不会丢内容：只需填当前排版用得到的栏，其余的会保留。</div>
      <div class="btn-row"><div class="btn btn-sm">返回区块</div></div>`,
    base: Array.from({ length: 8 }).map((_, i) => `
      <div class="base-row${i > 5 ? ' off' : ''}">
        <span class="base-label">${['姓名', '性别', '年龄', '学历', '电话', '邮箱', '求职意向', '现居城市'][i]}</span>
        <div class="base-input">${['张明', '男', '25', '本科', '138 0000 0000', 'zhangming@example.com', '产品经理', '上海'][i]}</div>
        <div class="switch${i > 5 ? '' : ' on'}"><div class="knob"></div></div>
      </div>`).join(''),
    style: `<div class="sect-title"><span class="bar"></span><span>模板（换模板不改内容）</span></div>
      <div class="tpl-strip"><div class="tpl-chip on"><span class="tpl-chip-name">经典蓝</span><span class="tpl-chip-desc">藏青 + 下划线标题</span></div><div class="tpl-chip"><span class="tpl-chip-name">墨黑简历</span><span class="tpl-chip-desc">无装饰</span></div></div>
      <div class="sect-title"><span class="bar"></span><span>配色</span></div>
      <div class="colors">${['#1f4e79', '#33383d', '#12695c', '#8c2f39', '#3b4a9c', '#9a6b1f', '#7a3b6a'].map((c, i) => `<div class="color-dot${i === 0 ? ' on' : ''}" style="background:${c}"><span class="color-name">${['藏青', '墨黑', '松绿', '酒红', '靛蓝', '赭金', '绛紫'][i]}</span></div>`).join('')}</div>
      <div class="picker-row"><span class="picker-label">字体</span><span class="picker-value">系统默认</span></div>
      <div class="picker-row"><span class="picker-label">标题装饰</span><span class="picker-value">下划线</span></div>
      <div class="slider-row"><span class="slider-label">字号</span><div class="slider" style="height:24px;background:#e4e8ee;border-radius:12px"></div><span class="slider-val">14</span></div>
      <div class="sect-title"><span class="bar"></span><span>自动排版</span></div>
      <div class="hint">自动往下调整字号、行距与边距，把内容压进一页。</div>
      <div class="btn btn-sm btn-primary btn-one-page">智能压缩到一页</div>`,
    photo: `<div class="photo-preview"><div class="photo-empty">未添加照片</div>
      <div class="btn-col"><div class="btn btn-sm btn-primary">从相册选择</div><div class="btn btn-sm btn-danger">移除</div></div></div>
      <div class="sect-title"><span class="bar"></span><span>外形</span></div>
      <div class="chips">${['方角', '圆角', '圆形', '正方'].map((t, i) => `<div class="chip${i === 1 ? ' on' : ''}">${t}</div>`).join('')}</div>
      <div class="sect-title"><span class="bar"></span><span>证件照比例</span></div>
      <div class="chips">${['一寸 3:4', '二寸 5:7', '方图 1:1', '自由'].map((t) => `<div class="chip">${t}</div>`).join('')}</div>`
  }[o.panel] || ''

  const titles = { sections: '目录', section: '编辑区块', item: '编辑条目', base: '基本信息', style: '样式与模板', photo: '照片' }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;}
  *{box-sizing:border-box;}
  ${pageCss()}
  #page{width:375px;height:100vh;}
  .navstub{flex:none;height:88px;background:linear-gradient(140deg,#26557f,#16334f);
    display:flex;align-items:center;justify-content:center;color:#fff;font-size:17px;font-weight:600;}
  .stage{overflow-y:auto;}
  .zoom-wrap{transform-origin:top left;margin-left:6px;}
  </style></head><body>
  <div id="page">
    <div class="navstub">我的简历 <span style="position:absolute;right:96px;background:rgba(255,255,255,.16);padding:6px 12px;border-radius:16px;font-size:13px">导出</span></div>
    <scroll-view class="tools"><div class="tools-inner">
      <div class="tool ${o.panel === 'sections' ? 'on' : ''}"><span class="tool-icon">☰</span><span class="tool-label">目录</span></div>
      <div class="tool ${o.panel === 'style' ? 'on' : ''}"><span class="tool-icon">◐</span><span class="tool-label">样式</span></div>
      <div class="tool ${o.menu ? 'on' : ''}"><span class="tool-icon">⋯</span><span class="tool-label">更多</span></div>
    </div></scroll-view>
    <scroll-view class="stage">
      <div class="stage-inner" style="height:${Math.round(PAPER * 2 * ZOOM)}px">
        <div class="zoom-wrap" style="transform:scale(${ZOOM})"><div style="width:794px;min-height:${PAPER * 2}px;background:#fff;padding:36px 48px;font-size:14px;line-height:1.65;color:#23282f">
          <div style="font-size:26px;font-weight:700;letter-spacing:2px;margin-bottom:8px">张明</div>
          <div style="color:#6b7280;margin-bottom:20px">男 · 25 岁 · 本科<br>138 0000 0000 · zhangming@example.com</div>
          <div style="font-weight:700;border-bottom:1.5px solid #1f4e79;padding-bottom:4px;margin:18px 0 10px">教育背景</div>
          <div style="display:flex;justify-content:space-between"><span>华东理工大学</span><span>计算机科学与技术</span><span style="color:#4b5560">2019.09-2023.06</span></div>
          <div style="color:#555">GPA 3.8/4.0（专业前 5%）</div>
          <div style="font-weight:700;border-bottom:1.5px solid #1f4e79;padding-bottom:4px;margin:18px 0 10px">实习经历</div>
          <div style="display:flex;justify-content:space-between"><span>字节跳动</span><span>产品实习生</span><span style="color:#4b5560">2022.07-2022.10</span></div>
          <div style="color:#555">负责需求调研与原型设计，上线后转化率提升 15%。</div>
          <div style="font-weight:700;border-bottom:1.5px solid #1f4e79;padding-bottom:4px;margin:18px 0 10px">项目经历</div>
          <div style="display:flex;justify-content:space-between"><span>二手交易平台</span><span>前端负责人</span><span style="color:#4b5560">2022.09-2023.01</span></div>
          <div style="color:#555">主导流程重构，人均处理时长下降 30%。</div>
        </div></div>
      </div>
      <div style="height:20px"></div>
    </scroll-view>
    <div class="panel">
      <div class="panel-head"><span class="panel-title">${titles[o.panel] || '面板'}</span><span class="panel-close">收起</span></div>
      <scroll-view class="panel-body" style="overflow-y:auto">${panelInner}</scroll-view>
    </div>
    ${o.menu ? `<div class="menu-mask"></div><div class="menu-pop" style="top:104px">
      <div class="menu-pop-head">更多</div>
      <scroll-view class="menu-pop-body">
        <div class="menu-row"><div class="menu-row-main"><span>撤销</span><span class="menu-row-hint">没有可撤销的步骤</span></div><span class="menu-arrow">↶</span></div>
        <div class="menu-row off"><div class="menu-row-main"><span>重做</span><span class="menu-row-hint">没有可重做的步骤</span></div><span class="menu-arrow">↷</span></div>
        <div class="menu-divider"></div>
        <div class="menu-row"><span>模板库</span><span class="menu-arrow">›</span></div>
        <div class="menu-row"><span>全屏预览</span><span class="menu-arrow">›</span></div>
        <div class="menu-row"><span>重命名简历</span><span class="menu-arrow">›</span></div>
        <div class="menu-row"><span>复制 JSON 备份</span><span class="menu-arrow">›</span></div>
        <div class="menu-row"><span>我的简历（保存并返回）</span><span class="menu-arrow">›</span></div>
      </scroll-view>
    </div>` : ''}
  </div></body></html>`
}

function getJson (url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}
function connect (wsUrl) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws')
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    let id = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) j(new Error(msg.error.message)); else r(msg.result)
      }
    })
    ws.on('error', reject)
    ws.on('open', () => resolve({
      send (m, p) {
        return new Promise((r, j) => {
          const mid = ++id
          pending.set(mid, { resolve: r, reject: j })
          ws.send(JSON.stringify({ id: mid, method: m, params: p || {} }))
        })
      },
      close () { try { ws.close() } catch (e) {} }
    }))
  })
}

async function main () {
  fs.mkdirSync(PROFILE, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
    '--window-size=375,700', 'about:blank'
  ], { stdio: 'ignore' })

  let client = null
  try {
    let target = null
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await getJson('http://127.0.0.1:' + PORT + '/json/list')
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      } catch (e) {}
      if (!target) await sleep(300)
    }
    if (!target) throw new Error('Chrome 未就绪')
    client = await connect(target.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 700, deviceScaleFactor: 2, mobile: true
    })

    const shots = [
      ['sections', { panel: 'sections' }],
      // 左滑展开动作层 / 拖动排序中的状态，用来肉眼确认两种位移分层正确
      ['sections-swipe', { panel: 'sections', swipeIndex: 1 }],
      ['sections-drag', { panel: 'sections', dragIndex: 2 }],
      ['section', { panel: 'section' }],
      ['item', { panel: 'item' }],
      ['base', { panel: 'base' }],
      ['style', { panel: 'style' }],
      ['photo', { panel: 'photo' }],
      ['menu', { panel: 'sections', menu: true }]
    ]
    for (const [name, opt] of shots) {
      const file = path.join(ROOT, '.work/shot-edit.html')
      fs.writeFileSync(file, html(opt))
      await client.send('Page.navigate', { url: 'file://' + file })
      await sleep(600)
      const shot = await client.send('Page.captureScreenshot', { format: 'png' })
      const out = path.join(ROOT, '.work/shot-edit-' + name + '.png')
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
      console.log('已截图 ' + path.relative(ROOT, out))
    }
  } finally {
    if (client) client.close()
    try { chrome.kill('SIGKILL') } catch (e) {}
  }
}

main().catch((e) => { console.error('截图失败：' + e.message); process.exit(1) })
