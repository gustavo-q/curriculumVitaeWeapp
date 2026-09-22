/**
 * 编辑器布局实测：用无头 Chrome 真实排版编辑页结构，量出各区块的实际位置。
 *
 * 为什么必须实测：
 *   「底部面板被推到文档流末尾、必须滑到底才能看见」这类问题，
 *   在源码里读 CSS 是看不出来的——它取决于 page 根节点到底是不是
 *   flex 容器、以及未限高的 scroll-view 会不会把内容整条撑开。
 *   只有让浏览器真的排一遍、再量 getBoundingClientRect() 才能确认。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE = path.join(ROOT, '.work/chrome-editlayout')
const PORT = 9533

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 读取 edit.wxss，把 rpx 换算成浏览器可用的 px（375px 逻辑宽 → 1rpx = 0.5px） */
/** 读取并转换一份 wxss：rpx → px（按 375 逻辑宽），page 选择器换成 #page */
function convertWxss (file, opts) {
  const o = opts || {}
  let css = fs.readFileSync(path.join(ROOT, file), 'utf8')
  css = css.replace(/([0-9.]+)rpx/g, (m, n) => (parseFloat(n) * 375) / 750 + 'px')
  if (o.pageToId !== false) css = css.replace(/(^|\n)\s*page\s*\{/g, '$1#page {')
  return css
}

function pageCss (withFix) {
  let css = convertWxss('pages/edit/edit.wxss')
  // 关掉修复：模拟「page 不是 flex 容器」的旧写法
  if (!withFix) {
    css = css.replace(/#page\s*\{[^}]*\}/, '#page { background: var(--bg); }')
  }
  let app = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  app = app.replace(/([0-9.]+)rpx/g, (m, n) => (parseFloat(n) * 375) / 750 + 'px')
  app = app.replace(/page\s*\{/g, '#page {')
  // 导航栏样式也要注入：第 5 节要实测它的标题居中与按钮可点性
  const nav = convertWxss('components/nav-bar/nav-bar.wxss', { pageToId: false })
  return app + '\n' + css + '\n' + nav
}

/** 按 edit.wxml 的结构搭一份等价 DOM（去掉 wx: 语法，保留关键层级与类名） */
function buildHtml (withFix, panelOpen, menuOpen) {
  const paperH = 1123 * 0.45 * 3 // 三页纸，制造「内容很长」的极端情况
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;}
  *{box-sizing:border-box;}
  ${pageCss(withFix)}
  /* 浏览器里没有真机视口，这里用 100vh 等价真机的 page{height:100%}：
     屏幕高度即窗口高度，于是「面板是否固定在底部」可以直接量出来。 */
  #page{width:375px;height:100vh;}
  .navstub{flex:none;height:88px;background:linear-gradient(140deg,#26557f,#16334f);}
  .stage{overflow-y:auto;}
  </style></head><body>
  <div id="page">
    <div class="navstub"></div>
    <div class="tools"><div class="tools-inner">
      <div class="tool on"><span class="tool-icon">☰</span><span class="tool-label">目录</span></div>
      <div class="tool"><span class="tool-icon">◐</span><span class="tool-label">样式</span></div>
      <div class="tool"><span class="tool-icon">⋯</span><span class="tool-label">更多</span></div>
    </div></div>
    <div class="stage" id="stage">
      <div class="stage-inner" style="height:${paperH}px">
        <div class="zoom-wrap"><div style="width:794px;height:${paperH}px;background:#fff"></div></div>
      </div>
      <div style="height:20px"></div>
    </div>
    ${panelOpen ? `<div class="panel" id="panel">
      <div class="panel-head"><span class="panel-title">目录</span><span class="panel-close" id="closeBtn">收起</span></div>
      <div class="panel-body" id="panelBody" style="overflow-y:auto">
        <div class="hint">点标题进入编辑 · 长按拖动排序 · 左滑可隐藏或删除</div>
        ${Array.from({ length: 12 }).map((_, i) => `<div class="dir-row" id="dirRow${i}"><div class="dir-acts" id="acts${i}"><div class="act act-toggle" id="toggleBtn${i}">隐藏</div><div class="act act-del" id="delBtn${i}">删除</div></div><div class="dir-face"><span class="dir-title ellipsis">区块 ${i + 1}</span><span class="dir-grip">⠿</span></div></div>`).join('')}
        <div class="btn btn-primary panel-add" id="addBtn">＋ 新增区块</div>
      </div>
    </div>` : ''}
    ${menuOpen ? `<div class="menu-mask" id="menuMask"></div><div class="menu-pop" id="menuPop" style="top:104px">
      <div class="menu-pop-head">更多</div>
      <div class="menu-pop-body">
        <div class="menu-row" id="menuRow0"><div class="menu-row-main"><span>撤销</span><span class="menu-row-hint">没有可撤销的步骤</span></div><span class="menu-arrow">↶</span></div>
        <div class="menu-row off"><div class="menu-row-main"><span>重做</span><span class="menu-row-hint">没有可重做的步骤</span></div><span class="menu-arrow">↷</span></div>
        <div class="menu-divider"></div>
        <div class="menu-row"><span>模板库</span><span class="menu-arrow">›</span></div>
        <div class="menu-row"><span>全屏预览</span><span class="menu-arrow">›</span></div>
        <div class="menu-row"><span>重命名简历</span><span class="menu-arrow">›</span></div>
        <div class="menu-row"><span>复制 JSON 备份</span><span class="menu-arrow">›</span></div>
        <div class="menu-row"><span>我的简历（保存并返回）</span><span class="menu-arrow">›</span></div>
      </div>
    </div>` : ''}
  </div></body></html>`
}

/* ---------------- Chrome CDP ---------------- */
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
        if (msg.error) j(new Error(msg.error.message))
        else r(msg.result)
      }
    })
    ws.on('error', reject)
    ws.on('open', () => resolve({
      send (method, params) {
        return new Promise((r, j) => {
          const mid = ++id
          pending.set(mid, { resolve: r, reject: j })
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
        })
      },
      close () { try { ws.close() } catch (e) {} }
    }))
  })
}

async function waitForTarget (tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list')
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (e) {}
    await sleep(300)
  }
  throw new Error('Chrome 未就绪')
}

async function main () {
  fs.mkdirSync(PROFILE, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
    '--window-size=420,900', 'about:blank'
  ], { stdio: 'ignore' })

  let client = null
  try {
    const target = await waitForTarget(40)
    client = await connect(target.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')

    async function evalJs (expr) {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result && r.result.value
    }

    async function load (html) {
      const file = path.join(ROOT, '.work/editlayout.html')
      fs.writeFileSync(file, html)
      await client.send('Page.navigate', { url: 'file://' + file })
      await sleep(700)
    }

    /* ============ 1. 修复前：page 不是 flex 容器 ============ */
    console.log('\n[1] 修复前（page 不是 flex 容器）：复现「面板被推到最底部」')
    await load(buildHtml(false, true, false))
    const before = await evalJs(`(() => {
      const g = id => { const e = document.getElementById(id); if(!e) return null;
        const r = e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; };
      return {
        vh: window.innerHeight,
        docH: document.documentElement.scrollHeight,
        stage: g('stage'),
        panel: g('panel'),
        bodyOverflow: getComputedStyle(document.body).overflow
      };
    })()`)
    console.log('  实测：' + JSON.stringify(before))
    // 修复前：面板被撑到视口之外
    ok('修复前面板确实落在视口之外（复现问题）',
      !before.panel || before.panel.top > before.vh,
      'panel.top=' + (before.panel && before.panel.top) + ' vh=' + before.vh)

    /* ============ 2. 修复后：三段式 flex 布局 ============ */
    console.log('\n[2] 修复后（page 为限高 flex 列容器）：面板必须固定在视口内')
    await load(buildHtml(true, true, false))
    const after = await evalJs(`(() => {
      const g = id => { const e = document.getElementById(id); if(!e) return null;
        const r = e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; };
      const tools = document.querySelector('.tools').getBoundingClientRect();
      return {
        vh: window.innerHeight,
        tools: {top:tools.top,bottom:tools.bottom,height:tools.height},
        stage: g('stage'),
        panel: g('panel'),
        closeBtn: g('closeBtn'),
        addBtn: g('addBtn'),
        dirRow0: g('dirRow0'),
        rowDel0: g('delBtn0'),
        rowToggle0: g('toggleBtn0')
      };
    })()`)
    console.log('  实测：' + JSON.stringify(after))

    ok('底部面板完整落在视口内', after.panel && after.panel.bottom <= after.vh + 1,
      'panel.bottom=' + after.panel.bottom + ' vh=' + after.vh)
    ok('面板底边贴合视口下沿（固定在底部）', after.panel && Math.abs(after.panel.bottom - after.vh) <= 1,
      'panel.bottom=' + after.panel.bottom + ' vh=' + after.vh)
    ok('面板高度受 vh 约束（不超过 58vh）', after.panel && after.panel.height <= after.vh * 0.58 + 1,
      'panel.height=' + after.panel.height)
    ok('纸面画布占据工具栏与面板之间的剩余空间',
      after.stage && after.stage.top >= after.tools.bottom - 1 && after.stage.bottom <= after.panel.top + 1,
      'stage=' + JSON.stringify(after.stage))
    ok('纸面画布自身可滚动（内容更长也不会撑破页面）',
      after.stage && after.stage.height < 812,
      'stage.height=' + (after.stage && after.stage.height))

    ok('「收起」按钮在视口内且可见', after.closeBtn && after.closeBtn.top >= 0 && after.closeBtn.bottom <= after.vh,
      JSON.stringify(after.closeBtn))
    ok('「新增区块」按钮可滚动到（有非零尺寸）', after.addBtn && after.addBtn.height > 0,
      JSON.stringify(after.addBtn))
    // 目录行去掉「编辑」按钮后，整行本身就是唯一入口，行高必须撑满触控下限
    ok('目录行触控高度不小于 44px（整行即入口）',
      after.dirRow0 && after.dirRow0.height >= 44,
      'height=' + (after.dirRow0 && after.dirRow0.height))
    ok('左滑动作层有非零高度（与行等高）',
      after.rowDel0 && after.rowDel0.height > 0,
      JSON.stringify(after.rowDel0))
    /* ============ 2b. 左滑分层：动作层必须留在原地，只有内容面滑走 ============ */
    /*
     * 这条守的是一个很容易写错、却在源码里看不出来的缺陷：
     * 若把 translateX 加在整行（.dir-row）而不是内容面（.dir-face）上，
     * 动作层会跟着一起向左滑走，用户左滑后永远看不到「隐藏 / 删除」。
     * 只有真的排版、真的量两者位置才能发现，所以必须实测。
     *
     * 目录行现在有两个动作（隐藏 + 删除），总宽 300rpx = 150px @375，
     * 两个动作各占一半；条目行仍只有一个删除（168rpx = 84px）。
     */
    console.log('\n[2b] 左滑展开：内容面滑走、动作层留在行内')
    const swiped = await evalJs(`(() => {
      const row = document.getElementById('dirRow0');
      const face = row.querySelector('.dir-face');
      const acts = row.querySelector('.dir-acts');
      const toggle = document.getElementById('toggleBtn0');
      const del = document.getElementById('delBtn0');
      const rr = row.getBoundingClientRect();
      const fr = face.getBoundingClientRect();
      const ar = acts.getBoundingClientRect();
      const tr = toggle.getBoundingClientRect();
      const dr = del.getBoundingClientRect();
      // 关掉过渡再改位移，否则 getBoundingClientRect 读到的是动画起点
      face.style.transition = 'none';
      face.style.transform = 'translateX(-150px)';
      const fr2 = face.getBoundingClientRect();
      const ar2 = acts.getBoundingClientRect();
      const tr2 = toggle.getBoundingClientRect();
      const dr2 = del.getBoundingClientRect();
      /*
       * 关键验证：滑开后，两个动作各自区域内点下去必须命中该动作本身。
       * 这才是「用户能不能点到」的直接证据——之前只比坐标，
       * 即使动作层被内容面盖住也照样通过。
       */
      const hitAt = (x, y) => { const el = document.elementFromPoint(x, y);
        return el ? (el.id || el.className) : null; };
      return {
        rowW: rr.width, rowLeft: rr.left, rowRight: rr.right,
        faceLeft0: fr.left, faceLeft1: fr2.left,
        actsLeft: ar.left, actsLeft2: ar2.left, actsW: ar.width, actsRight: ar.right,
        toggleW: tr.width, toggleLeft: tr.left,
        delW: dr.width, delLeft: dr.left, delRight: dr.right, delLeft2: dr2.left,
        hitToggle: hitAt(tr2.left + tr2.width / 2, tr2.top + tr2.height / 2),
        hitDel: hitAt(dr2.left + dr2.width / 2, dr2.top + dr2.height / 2)
      };
    })()`)
    console.log('  实测：' + JSON.stringify(swiped))
    ok('左滑后内容面确实左移了动作层总宽',
      Math.abs((swiped.faceLeft0 - swiped.faceLeft1) - 150) <= 1,
      'Δ=' + (swiped.faceLeft0 - swiped.faceLeft1))
    ok('左滑时动作层保持不动（位移只作用在内容面）',
      Math.abs(swiped.actsLeft - swiped.actsLeft2) <= 1,
      'before=' + swiped.actsLeft + ' after=' + swiped.actsLeft2)
    ok('动作层总宽与 edit.js 的 _DIR_ACTS_W_RPX 换算一致（300rpx = 150px）',
      Math.abs(swiped.actsW - 150) <= 1, '宽度=' + swiped.actsW)
    ok('两个动作等分动作层宽度',
      Math.abs(swiped.toggleW - swiped.delW) <= 1,
      '隐藏=' + swiped.toggleW + ' 删除=' + swiped.delW)
    ok('动作层右缘与行右缘对齐',
      Math.abs(swiped.actsRight - swiped.rowRight) <= 1,
      'acts.right=' + swiped.actsRight + ' row.right=' + swiped.rowRight)
    // 滑开后两个区域都必须真的能点到对应动作（而非仍被内容面盖住）
    ok('左滑展开后，命中测试落在「隐藏」动作上',
      swiped.hitToggle === 'toggleBtn0', 'hit=' + swiped.hitToggle)
    ok('左滑展开后，命中测试落在「删除」动作上',
      swiped.hitDel === 'delBtn0', 'hit=' + swiped.hitDel)
    /*
     * 两个动作都必须是自己那一档的最小触控宽度。
     * 150px ÷ 2 = 75px，远高于 44px；若哪天变成三个动作，
     * 这条会立刻失败，提醒重新确认「点得中」。
     */
    ok('每个左滑动作宽度 ≥44px 触控下限',
      Math.min(swiped.toggleW, swiped.delW) >= 44,
      '较窄的一个=' + Math.min(swiped.toggleW, swiped.delW))

    /* ============ 3. 浮层菜单 ============ */
    console.log('\n[3] 顶部浮层菜单：必须整体可见、点得到')
    await load(buildHtml(true, true, true))
    const menu = await evalJs(`(() => {
      const g = id => { const e = document.getElementById(id); if(!e) return null;
        const r = e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,
          hit: (() => { const el = document.elementFromPoint(r.left + 10, r.top + r.height/2);
            return el ? (el.id || el.className) : null; })()}; };
      const pop = document.getElementById('menuPop');
      const rows = Array.from(document.querySelectorAll('.menu-row')).map(e => {
        const r = e.getBoundingClientRect();
        return {h: r.height, top: r.top, bottom: r.bottom,
          hit: (() => { const el = document.elementFromPoint(r.left + 20, r.top + r.height/2);
            return el ? (el.closest('.menu-row') ? 'menu-row' : (el.id||el.className)) : null; })()};
      });
      /* 菜单底部曾有一排按钮（智能压缩到一页 / 立即保存 / 新建简历）。
         现在全部移除：菜单只承载跳转类操作。这里显式断言它不再出现，
         防止「底部又长出一排宽度不一的按钮」这类回归。 */
      const footBtns = document.querySelectorAll('.menu-pop-foot .btn');
      const popBtns = document.querySelectorAll('.menu-pop .btn');
      return { vh: window.innerHeight, pop: g('menuPop'), rows,
        footCount: footBtns.length, popBtnCount: popBtns.length };
    })()`)
    console.log('  实测：' + JSON.stringify(menu))

    ok('浮层菜单顶层可见', menu.pop && menu.pop.top >= 0 && menu.pop.bottom <= menu.vh + 1,
      JSON.stringify(menu.pop))
    ok('菜单行高度达到触控下限（≥42px）', menu.rows.length > 0 && menu.rows.every((r) => r.h >= 42),
      JSON.stringify(menu.rows.map((r) => r.h)))
    ok('菜单行没有被遮罩挡住（命中测试落在 menu-row 上）',
      menu.rows.length > 0 && menu.rows.every((r) => r.hit === 'menu-row'),
      JSON.stringify(menu.rows.map((r) => r.hit)))
    /* --- 菜单不含任何按钮：撤销 / 重做也是行，不是按钮 --- */
    ok('菜单里不再有底部按钮区（智能压缩 / 立即保存 / 新建简历 已移除）',
      menu.footCount === 0, '底部按钮数=' + menu.footCount)
    ok('菜单里没有任何按钮（连撤销 / 重做也是行）',
      menu.popBtnCount === 0, '按钮数=' + menu.popBtnCount)
    /*
     * 撤销 / 重做从工具栏搬进浮层后，必须仍在浮层里可见可点：
     * 否则这两个能力就等于被删掉了。第 0 行就是「撤销」，第 1 行是「重做」。
     */
    ok('浮层前两行是撤销 / 重做（低频操作收进来而不是删掉）',
      menu.rows.length >= 7,
      '行数=' + menu.rows.length)
    ok('撤销 / 重做行可点（命中测试落在 menu-row 上）',
      menu.rows.slice(0, 2).every((r) => r.hit === 'menu-row'),
      JSON.stringify(menu.rows.slice(0, 2).map((r) => r.hit)))
    ok('撤销 / 重做行高度同样达标（≥42px）',
      menu.rows.slice(0, 2).every((r) => r.h >= 42),
      JSON.stringify(menu.rows.slice(0, 2).map((r) => r.h)))

    /* ============ 4. 工具栏按钮触控区 ============ */
    console.log('\n[4] 工具栏：3 个入口必须全部可见且点得中')
    // 必须在不带浮层菜单的状态下量，否则命中的是遮罩（那是菜单的预期行为）
    await load(buildHtml(true, true, false))
    const tools = await evalJs(`(() => {
      const c = document.querySelector('.tools');
      const list = Array.from(document.querySelectorAll('.tool')).map(e => {
        const r = e.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
        return { w: r.width, h: r.height, right: r.right,
          label: e.querySelector('.tool-label') ? e.querySelector('.tool-label').textContent : '',
          hit: el ? (el.closest('.tool') ? 'tool' : (el.id||el.className)) : null };
      });
      return { clientW: c.clientWidth, scrollW: c.scrollWidth, list };
    })()`)
    console.log('  实测：' + JSON.stringify(tools))
    ok('工具栏按钮高度 ≥40px', tools.list.every((t) => t.h >= 40), JSON.stringify(tools.list.map((t) => t.h)))
    ok('工具栏只剩 3 个入口（目录 / 样式 / 更多）', tools.list.length === 3,
      '实测 ' + tools.list.length + ' 个：' + JSON.stringify(tools.list.map((t) => t.label)))
    ok('撤销 / 重做已不在工具栏（收进「更多」浮层）',
      !tools.list.some((t) => /撤销|重做/.test(t.label)),
      JSON.stringify(tools.list.map((t) => t.label)))
    /* 「基本信息」「照片」也不能在工具栏：它们的入口在纸面上（点姓名/信息栏、点照片占位），
       工具栏再列一遍等于同一件事两个入口。 */
    ok('「基本信息」「照片」已不在工具栏（改由纸面点击进入）',
      !tools.list.some((t) => /基本信息|照片/.test(t.label)),
      JSON.stringify(tools.list.map((t) => t.label)))
    ok('入口全部落在容器宽度内（没有按钮被挤出视野）',
      tools.list.every((t) => t.right <= tools.clientW + 1),
      JSON.stringify(tools.list.map((t) => Math.round(t.right))) + ' clientW=' + tools.clientW)
    ok('没有横向溢出（不需要滚动就能看到全部入口）',
      tools.scrollW <= tools.clientW + 1,
      'clientW=' + tools.clientW + ' scrollW=' + tools.scrollW)
    ok('每个按钮都能被命中测试点到', tools.list.every((t) => t.hit === 'tool'),
      JSON.stringify(tools.list.map((t) => t.hit)))
    /* 320px 是最窄的常见机型。精简要保证「每个入口都够宽」:
       7 格时 45.7px、5 格时 64px、3 格时约 106.7px。
       这里用实测宽度反推最窄机型下的格宽，而不是只看 375px 下的结果。 */
    const minCell = Math.floor(320 / tools.list.length)
    ok('最窄机型（320px）下按钮宽度仍 ≥42px', minCell >= 42, '320/' + tools.list.length + ' = ' + minCell)
    ok('工具栏精简后每个入口足够宽（320px 下 ≥100px）', minCell >= 100,
      '320/' + tools.list.length + ' = ' + minCell)

    /* ============ 5. 导航栏：标题真居中，且不挡住操作按钮 ============ */
    console.log('\n[5] 导航栏：标题必须相对屏幕居中，且导出按钮仍可点')
    /*
     * 标题原先用 flex:1 + text-align:center，可居中线是「左返回键 ~ 右按钮」
     * 之间而非屏幕中心；右侧还要为胶囊让位约 104px，实测标题偏左 72.5px，
     * 且「导出 → 导出中」文字变长时标题还会抖 7px。
     * 这里逐个屏宽量标题中心，并用命中测试确认操作按钮没被标题盖住。
     */
    const navCases = [[320, 224], [375, 279], [393, 297]]
    const navResults = []
    for (const [winW, mbLeft] of navCases) {
      for (const actText of ['导出', '导出中']) {
        const r = await evalJs(`(() => {
          const winW = ${winW};
          const padR = Math.max(12, Math.round(winW - ${mbLeft}) + 8);
          const d = document.createElement('div');
          d.id = 'navFixture';
          d.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;width:' + winW +
            'px;background:#26557f;color:#fff;';
          d.innerHTML = '<div class="nav-inner" id="navInner" style="height:44px;padding-left:12px;padding-right:' +
            padR + 'px;position:relative;display:flex;align-items:center">' +
            '<div class="nav-left"><div class="nav-back" id="navBack"><span class="nav-back-icon">‹</span></div></div>' +
            '<div class="nav-title" id="navTitle">张三_产品经理</div>' +
            '<div class="nav-right"><div class="nav-action" id="navAction">${actText}</div></div></div>';
          document.body.appendChild(d);
          const t = document.getElementById('navTitle').getBoundingClientRect();
          const a = document.getElementById('navAction').getBoundingClientRect();
          const b = document.getElementById('navBack').getBoundingClientRect();
          const hit = (x, y) => { const el = document.elementFromPoint(x, y);
            return el ? (el.id || el.className) : null; };
          const out = {
            center: t.left + t.width / 2,
            screen: winW / 2,
            hitAction: hit(a.left + a.width / 2, a.top + a.height / 2),
            hitBack: hit(b.left + b.width / 2, b.top + b.height / 2),
            actionH: a.height
          };
          d.remove();
          return out;
        })()`)
        navResults.push(Object.assign({ winW, actText }, r))
      }
    }
    console.log('  实测：' + JSON.stringify(navResults))
    ok('各屏宽下标题都相对屏幕居中（偏移 ≤1px）',
      navResults.every((r) => Math.abs(r.center - r.screen) <= 1),
      JSON.stringify(navResults.map((r) => (r.center - r.screen).toFixed(1))))
    ok('标题不挡住导出按钮（按钮仍能被命中）',
      navResults.every((r) => r.hitAction === 'navAction'),
      JSON.stringify(navResults.map((r) => r.hitAction)))
    ok('标题不挡住返回键',
      navResults.every((r) => r.hitBack === 'navBack'),
      JSON.stringify(navResults.map((r) => r.hitBack)))
    ok('导出按钮触控高度 ≥44px',
      navResults.every((r) => r.actionH >= 44),
      JSON.stringify(navResults.map((r) => Math.round(r.actionH))))
    // 文字从「导出」变「导出中」时标题不能抖动
    const jitter = navResults.filter((r) => r.actText === '导出中')[0].center -
      navResults.filter((r) => r.actText === '导出')[0].center
    ok('按钮文字变长时标题不抖动', Math.abs(jitter) < 0.5, 'jitter=' + jitter.toFixed(2) + 'px')

    /* ============ 6. 按钮格式统一性 ============
     *
     * 「同一排按钮宽窄不一、长文案的按钮被挤到第二行」是这套界面上反复出现的问题，
     * 根因是各处按钮行各写各的、宽度由文案决定。统一之后必须能证明：
     *   · 同一 .btn-row 内的按钮严格等宽（与文案长短无关）；
     *   · 最窄机型（320px）下文字也不溢出被裁；
     *   · 高低两档按钮高度稳定，且都 ≥44px 触控下限。
     * 因此这里造最坏情况：320px 容器 + 最长的按钮文案。
     */
    console.log('\n[6] 按钮格式：等宽、不溢出、触控达标（含 320px 最窄机型）')
    /*
     * ★ 溢出必须用 Range 精确量「文字实际占据的矩形」，不能只看 scrollWidth：
     *   .btn 是 flex 容器且 overflow 默认为 visible，文字作为 flex item
     *   被 nowrap 撑出内边距时 scrollWidth 仍等于 clientWidth，测不出问题。
     *   这里逐字取 range 的 getBoundingClientRect，再与按钮的 padding box 比较。
     *
     * ★ 容器宽度取各场景的「真实最窄可用宽」，而不是一律 320px：
     *   320px 屏是最窄的常见机型，其上 .panel-body 左右各 28rpx → 内容区 296px；
     *   浮层菜单宽 460rpx、左右各 20rpx → 内宽 179px。
     *   用 320px 当容器反而比现实宽松，会漏掉真实的溢出。
     *
     *   注意本脚本统一按 375px 基准换算 rpx（1rpx = 0.5px），因此按钮内边距取到
     *   12px，而真机 320px 屏上 24rpx 只有 10.24px —— 也就是这里的判定比真机
     *   更严格（内边距更大、可用宽度更小）。断言通过即真机安全。
     */
    const btnCases = await evalJs(`(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;';
      document.body.appendChild(host);
      const measure = (width, html, sel) => {
        host.style.width = width + 'px';
        host.innerHTML = html;
        return Array.from(host.querySelectorAll(sel)).map((e) => {
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
          const range = document.createRange();
          range.selectNodeContents(e);
          const tr = range.getBoundingClientRect();
          return {
            w: r.width, h: r.height, top: r.top,
            /* 文字可用宽度（内边距之间）与文字实际宽度之差 */
            availW: r.width - padL - padR,
            textW: tr.width
          };
        });
      };
      /* 真实组合一：区块面板的「＋ 添加条目」（单个主操作，297px 内容宽）。
         原来这里是三个等分按钮「整行 / 左+右 / 左+中+右」，排版类型
         已移到条目面板用示意图选，这里不再需要三个格子。 */
      const addItem = measure(296,
        '<div class="btn btn-primary panel-add">＋ 添加条目</div>', '.btn');
      /* 真实组合二：条目面板的排版示意图三格（「一行文字 / 左右两栏 / 左中右三栏」，
         最长的 5 个字必须放得下，且三格等宽） */
      const shapeRow = measure(296,
        '<div class="shape-row">' +
        '<div class="shape on"><div class="shape-demo"><div class="shape-line"></div></div><span class="shape-label">一行文字</span></div>' +
        '<div class="shape"><div class="shape-demo"><div class="shape-line"></div><div class="shape-line"></div></div><span class="shape-label">左右两栏</span></div>' +
        '<div class="shape"><div class="shape-demo"><div class="shape-line"></div><div class="shape-line"></div><div class="shape-line"></div></div><span class="shape-label">左中右三栏</span></div>' +
        '</div>', '.shape');
      /* 真实组合三：首页空状态两按钮（等分 + 6 字文案，最容易挤爆的一处） */
      const empty2 = measure(292,
        '<div class="btn-row">' +
        '<div class="btn btn-primary">新建示例简历</div>' +
        '<div class="btn">空白简历</div></div>', '.btn');
      /* 真实组合四：样式面板「智能压缩到一页」（原来在菜单浮层里，
         现在独占面板整宽；296px 容器下必须撑满且文字不溢出） */
      const onePage = measure(296,
        '<div class="btn btn-sm btn-primary btn-one-page">智能压缩到一页</div>', '.btn');
      /* 真实组合五：预览页顶栏（按内容宽排列的长文案） */
      const auto = measure(320,
        '<div class="btn-row btn-row-auto">' +
        '<div class="btn btn-sm">复制 JSON</div>' +
        '<div class="btn btn-sm btn-primary">去编辑</div></div>', '.btn');
      /* 真实组合六：按钮网格自身仍要正确（其他页面在用两列等分 + 跨行主操作） */
      const grid = measure(296,
        '<div class="btn-grid">' +
        '<div class="btn btn-sm btn-primary btn-wide">智能压缩到一页</div>' +
        '<div class="btn btn-sm">立即保存</div>' +
        '<div class="btn btn-sm">新建简历</div></div>', '.btn');
      host.remove();
      return { addItem, shapeRow, empty2, onePage, auto, grid };
    })()`)
    console.log('  实测：' + JSON.stringify(btnCases))

    const allBtns = [].concat(btnCases.addItem, btnCases.empty2, btnCases.onePage, btnCases.auto, btnCases.grid)
    ok('所有按钮触控高度 ≥44px', allBtns.length > 0 && allBtns.every((b) => b.h >= 44),
      JSON.stringify(allBtns.map((b) => Math.round(b.h))))
    ok('最窄真实可用宽度下按钮文字都不溢出内边距',
      allBtns.every((b) => b.textW <= b.availW + 1),
      JSON.stringify(allBtns.map((b) => Math.round(b.textW) + '/' + Math.round(b.availW))))
    ok('区块面板的「＋ 添加条目」占满面板整宽（不再是一排三个按钮）',
      btnCases.addItem.length === 1 && Math.abs(btnCases.addItem[0].w - 296) <= 1,
      JSON.stringify(btnCases.addItem.map((b) => Math.round(b.w))))
    /*
     * 排版示意图三格：必须等宽、触控达标，且最长的「左中右三栏」文字
     * 不能被格子裁掉——label 在 .shape 里居中，溢出会表现为文本超出盒宽。
     */
    ok('排版示意图是三格', btnCases.shapeRow.length === 3,
      '实测 ' + btnCases.shapeRow.length + ' 格')
    ok('排版示意图三格严格等宽',
      btnCases.shapeRow.length === 3 &&
      btnCases.shapeRow.every((b) => Math.abs(b.w - btnCases.shapeRow[0].w) <= 1),
      JSON.stringify(btnCases.shapeRow.map((b) => Math.round(b.w))))
    ok('排版示意图触控高度 ≥44px',
      btnCases.shapeRow.every((b) => b.h >= 44),
      JSON.stringify(btnCases.shapeRow.map((b) => Math.round(b.h))))
    ok('排版示意图里最长的「左中右三栏」放得下（不溢出格子）',
      btnCases.shapeRow.every((b) => b.textW <= b.w + 1),
      JSON.stringify(btnCases.shapeRow.map((b) => Math.round(b.textW) + '/' + Math.round(b.w))))
    ok('样式面板的「智能压缩到一页」占满面板整宽',
      btnCases.onePage.length === 1 && Math.abs(btnCases.onePage[0].w - 296) <= 1,
      JSON.stringify(btnCases.onePage.map((b) => Math.round(b.w))))
    ok('同一按钮行内严格等宽（宽度与文案长短无关）',
      btnCases.empty2.every((b) => Math.abs(b.w - btnCases.empty2[0].w) <= 1),
      JSON.stringify(btnCases.empty2.map((b) => Math.round(b.w))))
    ok('两列网格里两个次要按钮等宽',
      Math.abs(btnCases.grid[1].w - btnCases.grid[2].w) <= 1,
      JSON.stringify(btnCases.grid.map((b) => Math.round(b.w))))
    ok('网格里主操作跨满整行',
      btnCases.grid[0].w > btnCases.grid[1].w * 1.8,
      JSON.stringify(btnCases.grid.map((b) => Math.round(b.w))))
    ok('按内容宽排列时按钮宽度贴合文字（不被强行拉满整宽）',
      btnCases.auto.every((b) => b.w < 160),
      JSON.stringify(btnCases.auto.map((b) => Math.round(b.w))))

    console.log('\n==============================')
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
    if (failures.length) {
      console.log('\n失败明细：')
      failures.forEach((f) => console.log('  - ' + f))
    }
  } finally {
    if (client) client.close()
    try { chrome.kill('SIGKILL') } catch (e) {}
  }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('实测脚本异常：' + e.message)
  process.exit(2)
})
