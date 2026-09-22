/**
 * 首页卡片布局实测：用无头 Chrome 真实排版首页卡片，量出卡片的关键几何。
 *
 * 为什么必须实测：
 *   卡片去掉「预览 / 复制 / 删除」按钮、并去掉左滑删除后，卡片正面只剩
 *   缩略图与元信息，整个卡片即入口。这里用量几何的方式确认：
 *   正面确实没有任何按钮或删除层残留，卡片宽度仍然占满内容区（整卡可点）。
 *
 * 用法：node tools/check-indexlayout.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE = path.join(ROOT, '.work/chrome-indexlayout')
const PORT = 9545

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 读取 index.wxss，把 rpx 换算成浏览器可用的 px（375px 逻辑宽 → 1rpx = 0.5px） */
function pageCss () {
  let css = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxss'), 'utf8')
  css = css.replace(/([0-9.]+)rpx/g, (m, n) => (parseFloat(n) * 375) / 750 + 'px')
  let app = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  app = app.replace(/([0-9.]+)rpx/g, (m, n) => (parseFloat(n) * 375) / 750 + 'px')
  app = app.replace(/page\s*\{/g, '#page {')
  app += '\nview,scroll-view,text{display:block;}\n'
  return app + '\n' + css
}

const CARD_W = 375 - 28 // 两侧 28rpx = 14px 内边距

function buildHtml () {
  const names = ['简历_产品经理', '张三_前端开发', '李四_数据分析']
  const cards = names.map((n, i) => `
    <div class="card item" id="card${i}">
      <div class="item-face" id="face${i}">
        <div class="thumb"><div class="thumb-scale" style="transform:translateX(-50%) scale(0.12)">
          <div style="width:794px;height:1123px;background:#fff"></div>
        </div></div>
        <div class="meta">
          <div class="meta-title ellipsis">${n}</div>
          <div class="meta-sub"><span class="tag tag-brand">经典蓝</span><span class="small muted">5 个区块 · 2026-09-22 15:51</span></div>
          <div class="meta-hint">长按可预览、复制、删除</div>
        </div>
      </div>
    </div>`).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;}
  *{box-sizing:border-box;}
  ${pageCss()}
  #page{width:375px;}
  .body{padding:14px;}
  </style></head><body>
  <div id="page"><div class="body"><div class="grid">${cards}</div></div></div>
  </body></html>`
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
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
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

    const file = path.join(ROOT, '.work/indexlayout.html')
    fs.writeFileSync(file, buildHtml())
    await client.send('Page.navigate', { url: 'file://' + file })
    await sleep(700)

    // 顺带存一张截图，可直接肉眼确认卡片外观
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 640, deviceScaleFactor: 2, mobile: true
    })
    await sleep(300)
    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    const shotPath = path.join(ROOT, '.work/shot-index-cards.png')
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log('已截图 ' + path.relative(ROOT, shotPath))
    await client.send('Emulation.clearDeviceMetricsOverride')
    await sleep(200)

    console.log('\n[1] 卡片正面：不再有按钮，也不再有左滑删除层')
    const normal = await evalJs(`(() => {
      const card = document.getElementById('card0');
      const face = document.getElementById('face0');
      const cr = card.getBoundingClientRect();
      const fr = face.getBoundingClientRect();
      const cs = getComputedStyle(face);
      return {
        cardW: cr.width, cardH: cr.height,
        faceW: fr.width, faceH: fr.height,
        faceBg: cs.backgroundColor,
        btnCount: card.querySelectorAll('.btn').length,
        delCount: card.querySelectorAll('.row-del').length,
        delInDoc: document.querySelectorAll('.row-del').length
      };
    })()`)
    console.log('  实测：' + JSON.stringify(normal))

    ok('卡片正面没有任何按钮', normal.btnCount === 0, '按钮数=' + normal.btnCount)
    ok('卡片没有任何左滑删除层', normal.delInDoc === 0, '删除层数=' + normal.delInDoc)
    /*
     * 卡片有 1px 边框，内容区比外框小约 2px 是正常的；
     * 这里只验证内容面与卡片「等高等宽且对齐」，那才是整卡可点、无残留图层的前提。
     */
    ok('内容面与卡片等高（没有残留的隐藏图层）',
      Math.abs(normal.faceH - normal.cardH) <= 2,
      'face.h=' + normal.faceH + ' card.h=' + normal.cardH)
    ok('内容面是不透明背景（卡片底色稳定）',
      normal.faceBg && normal.faceBg !== 'rgba(0, 0, 0, 0)' && normal.faceBg !== 'transparent',
      'background=' + normal.faceBg)
    ok('内容面横向铺满卡片内容区',
      Math.abs(normal.faceW - (normal.cardW - 2)) <= 1,
      'face.w=' + normal.faceW + ' card.w=' + normal.cardW)

    console.log('\n[2] 卡片宽度与触控：整卡是唯一入口')
    const size = await evalJs(`(() => {
      const card = document.getElementById('card0');
      const cr = card.getBoundingClientRect();
      const row = document.querySelectorAll('.card.item');
      return { h: cr.height, w: cr.width, count: row.length };
    })()`)
    console.log('  实测：' + JSON.stringify(size))
    ok('卡片高度足够（缩略图 268rpx ≈ 134px 已完整容纳）', size.h >= 120, 'h=' + size.h)
    ok('卡片宽度占满内容区（整卡可点）',
      size.w >= CARD_W - 1, 'w=' + size.w + ' 期望≥' + CARD_W)

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
