/**
 * 导出内容完整性诊断 —— 实测「导出文件字显示不全」发生在哪条链路。
 *
 * 手法与 check-geometry 相同：无头 Chrome 真实执行 utils 源码。
 *   1. canvas 链路（PNG / PDF 共用，utils/render.js）：
 *      真实 canvas 2d 渲染后，逐行文字审计「绘制宽度是否越出列盒 / 内容区」，
 *      导出整页 PNG 到 .work/ 供肉眼比对。
 *   2. Word 链路（utils/word.js）：
 *      生成的 HTML 在 698px（A4 内容区）宽度下真实排版，
 *      量每个元素是否横向溢出，截图存证。
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9334
const PROFILE = path.join(ROOT, '.work/chrome-exportdiag')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get (url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(d))
    }).on('error', reject)
  })
}

async function waitForPageTarget (tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'))
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (e) {}
    await sleep(400)
  }
  throw new Error('Chrome DevTools page target 未就绪')
}

function connect (wsUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl)
    const key = Buffer.from(Math.random().toString()).toString('base64').slice(0, 16)
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': key }
    })
    req.on('upgrade', (res, socket) => {
      let id = 0
      const pending = new Map()
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) break
          const opcode = buf[0] & 0x0f
          const masked = (buf[1] & 0x80) !== 0
          let len = buf[1] & 0x7f
          let off = 2
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
          if (masked) off += 4
          if (buf.length < off + len) break
          const payload = buf.slice(off, off + len)
          buf = buf.slice(off + len)
          if (opcode === 1 || opcode === 0) {
            try {
              const msg = JSON.parse(payload.toString('utf8'))
              if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
            } catch (e) {}
          }
          if (opcode === 8) socket.end()
        }
      })
      const send = (method, params) => new Promise((res2) => {
        const mid = ++id
        pending.set(mid, res2)
        const data = Buffer.from(JSON.stringify({ id: mid, method, params }))
        const len = data.length
        let header
        if (len < 126) header = Buffer.from([0x81, 0x80 | len])
        else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(len, 2) }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(len), 2) }
        const mask = Buffer.from([1, 2, 3, 4])
        const masked = Buffer.alloc(len)
        for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4]
        socket.write(Buffer.concat([header, mask, masked]))
      })
      resolve({ send, close: () => socket.end() })
    })
    req.on('error', reject)
    req.end()
  })
}

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')) }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

/* ---------------- 用例 ---------------- */
function buildCases (model) {
  const cases = []
  cases.push({ label: 'classic', resume: model.normalizeResume(model.buildThumbSample('classic')) })
  const r = model.normalizeResume(model.createBlankResume())
  r.baseInfo = { name: '张明明明', gender: '男', age: '25', education: '本科（全日制）', phone: '138 0000 0000', email: 'zhangmingming@example.com.cn', jobIntention: '高级产品经理（AI 方向）', city: '上海（徐汇）', experience: '3 年' }
  r.baseFields = ['name', 'gender', 'age', 'education', 'phone', 'email', 'jobIntention', 'city', 'experience']
  r.sections = [
    model.createSection('教育背景', [
      model.createItem('THREE', { leftContent: '华东理工大学', centerContent: '计算机科学与技术（本科·全日制）', rightContent: '2019.09 - 2023.06' }),
      model.createItem('THREE', { leftContent: '某非常长的公司名称有限公司上海分公司', centerContent: '高级前端开发工程师（负责大型中台系统）', rightContent: '2023.07 - 至今' })
    ]),
    model.createSection('项目经历', [
      model.createItem('ONE', { centerContent: '1、负责用户增长中台的搭建与迭代，月活提升 30%\n2、主导 A/B 实验平台设计，实验吞吐提升 5 倍（500%）\n3、指导 3 名初级工程师完成核心模块交付' })
    ]),
    model.createSection('专业技能', [
      model.createItem('TWO', { leftContent: 'JavaScript / TypeScript / React / Vue / Node.js / Webpack / Vite 等前端技术栈', rightContent: '精通' }),
      model.createItem('ONE', { centerContent: '这是一个没有任何空格的超长测试串 Supercalifragilisticexpialidocious-antidisestablishmentarianism 用来测试硬断行是否完整保留每个字' })
    ])
  ]
  cases.push({ label: 'stress', resume: r })
  const r2 = model.normalizeResume(model.buildThumbSample('classic'))
  r2.pageLayout = 'LEFT'
  r2.baseInfoRatio = 60
  cases.push({ label: 'left60', resume: r2 })
  const r3 = model.normalizeResume(model.buildThumbSample('elegant'))
  r3.fontFamily = 'songti'
  r3.fontSpacing = 1.5
  cases.push({ label: 'elegant-songti-ls', resume: r3 })
  return cases
}

/* ---------------- 浏览器端执行体 ---------------- */
const BROWSER_SRC = `
(async () => {
  const FILES = __FILES__;
  // 简易 CommonJS 装载器：utils 之间用 require('./x.js') 引用
  const mods = {};
  const req = (p) => mods[String(p).replace('./', '').replace('.js', '')];
  // layout.js 的 getCtx 需要 wx.createOffscreenCanvas：给真 canvas（真实浏览器度量）
  window.wx = {
    createOffscreenCanvas: (o) => {
      const c = document.createElement('canvas');
      c.width = (o && o.width) || 16; c.height = (o && o.height) || 16;
      return c;
    }
  };
  for (const name of Object.keys(FILES)) {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', FILES[name])(req, mod, mod.exports);
    mods[name] = mod.exports;
  }
  const model = mods.model, L = mods.layout, render = mods.render, word = mods.word;
  const CASES = __CASES__;
  const A4_W = L.A4_W, A4_H = L.A4_H;

  const out = { canvas: [], word: [], imgs: {} };

  for (const c of CASES) {
    const resume = c.resume;
    const g = L.layoutResume(resume);
    const S = g.pageStyle || g.style;
    const contentRight = A4_W - S.hPad;

    /* ---------- canvas 审计：每行文字的横向越界 ---------- */
    const issues = [];
    const auditCell = (cell, itemY, secTitle) => {
      const lines = cell.lines || [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const w = L.textWidth(line, cell.font, S.fontSpacing);
        const drawX = (cell.align === 'right' ? cell.x + cell.width - w : cell.x) + (cell.padLeft || 0);
        const boxOver = (cell.padLeft || 0) + w - cell.width; // 相对列盒
        const pageOver = drawX + w - contentRight;            // 相对内容区右缘
        if (boxOver > 0.6 || pageOver > 0.6) {
          issues.push({
            sec: secTitle, field: cell.field, line: i,
            text: String(line).slice(0, 22),
            w: Math.round(w * 10) / 10, cellW: Math.round(cell.width * 10) / 10,
            boxOver: Math.round(boxOver * 10) / 10, pageOver: Math.round(pageOver * 10) / 10
          });
        }
      }
    };
    for (const sec of g.sections) {
      for (const it of sec.items) for (const cell of it.cells) auditCell(cell, it.y, sec.title);
    }
    // 页眉两列信息（SINGLE）
    if (g.head) {
      for (const cell of g.head.grid) {
        for (const line of cell.lines) {
          const w = L.textWidth(line, L.fontOf(S.fontSize, 400, S.fontFamily), S.fontSpacing);
          const drawX = S.hPad + cell.valueX;
          if (drawX + w - contentRight > 0.6) {
            issues.push({ sec: '页眉', field: cell.key, text: String(line).slice(0, 22), pageOver: Math.round((drawX + w - contentRight) * 10) / 10 });
          }
        }
      }
    }
    // 侧栏（双栏）
    if (g.side) {
      for (const p of g.side.list) {
        for (const line of p.lines) {
          const w = L.textWidth(line, L.fontOf(S.fontSize, 400, S.fontFamily), S.fontSpacing);
          if (p.valueX + w - (g.side.x + g.side.width) > 0.6) {
            issues.push({ sec: '侧栏', field: p.key, text: String(line).slice(0, 22), pageOver: Math.round((p.valueX + w - (g.side.x + g.side.width)) * 10) / 10 });
          }
        }
      }
    }

    /* ---------- 真实渲染整页 PNG（与导出同一函数） ---------- */
    const canvas = document.createElement('canvas');
    // render.js 需要 canvas.createImage：浏览器端用 Image 兼容
    canvas.createImage = () => new Image();
    const ctx = canvas.getContext('2d');
    const rend = await render.renderToContext(ctx, canvas, resume, { scale: 2 });
    const dataUrl = canvas.toDataURL('image/png');
    out.imgs[c.label] = dataUrl;

    /*
     * ★ 墨迹审计：不看引擎预测，直接扫画布位图。
     * 右边距区（页面右缘往内 hPad 内）本应是空白 —— 若右对齐栏把文字画进来，
     * 这里会出现非白像素。这是「字显示不全」最直接的可观测证据，
     * 引擎级审计（对齐假设错误时）量不出来。
     */
    const inkScan = (() => {
      const w = canvas.width, h = canvas.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      // 右边距带：A4 宽 794 中最后 hPad 设计像素（×2 倍率）
      const bandX = Math.floor((A4_W - S.hPad + 2) * 2); // 容差 2px
      let ink = 0, firstX = -1, sampleY = 0;
      for (let y = 0; y < h; y += 2) {
        for (let x = bandX; x < w; x += 2) {
          const i = (y * w + x) * 4;
          if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) {
            ink++;
            if (firstX < 0) { firstX = x; sampleY = y; }
          }
        }
      }
      return { ink, firstX, sampleY, bandFrom: bandX };
    })();
    out.canvas.push({ label: c.label, issues, ink: inkScan, rend: { w: rend.width, h: rend.height } });

    /* ---------- Word 审计：698px 内容区里排版并量溢出 ---------- */
    const html = word.resumeToWordHtml(resume);
    const body = html.replace(/^[\s\S]*<body>/, '').replace(/<\\/body><\\/html>\\s*$/, '');
    const host = document.createElement('div');
    host.id = 'wordhost-' + c.label;
    host.style.cssText = 'position:absolute;left:0;top:0;width:794px;background:#fff;padding:36px 48px;box-sizing:border-box;font-size:14px;';
    host.innerHTML = body;
    document.body.appendChild(host);
    await new Promise((r) => setTimeout(r, 60));
    const hostW = 794 - 96; // 内容区宽（@page 边距 48px）
    const wOver = [];
    host.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      const over = r.right - (hr.left + 48 + hostW);
      const scrollOver = el.scrollWidth - el.clientWidth;
      if (over > 0.6 || scrollOver > 1) {
        wOver.push({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 22), right: Math.round(over * 10) / 10, scrollOver: Math.round(scrollOver) });
      }
    });
    out.word.push({ label: c.label, over: wOver.slice(0, 8), count: wOver.length });
    host.remove();
  }
  return out;
})()
`

async function run () {
  const model = require(path.join(ROOT, 'utils/model.js'))
  const CASES = buildCases(model)

  const FILES = {}
  for (const f of ['model.js', 'avatars.js', 'layout.js', 'paper.js', 'render.js', 'word.js']) {
    FILES[f.replace('.js', '')] = fs.readFileSync(path.join(ROOT, 'utils', f), 'utf8')
  }

  fs.mkdirSync(PROFILE, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--allow-file-access-from-files', '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT, '--window-size=1100,1600', 'about:blank'
  ], { stdio: 'ignore' })

  let client = null
  try {
    const target = await waitForPageTarget(40)
    client = await connect(target.webSocketDebuggerUrl)
    const send = client.send
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.navigate', { url: 'about:blank' })
    await sleep(500)

    const expr = BROWSER_SRC
      .replace('__FILES__', JSON.stringify(FILES))
      .replace('__CASES__', JSON.stringify(CASES))
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r && r.error) throw new Error('CDP ' + r.error.message)
    if (r.result && r.result.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1000))
    }
    const out = r.result.result.value

    section('1. canvas 渲染（PNG / PDF 共用）：行宽审计')
    for (const c of out.canvas) {
      ok('[' + c.label + '] 引擎折行无越界（' + (c.issues.length) + ' 处）',
        c.issues.length === 0, JSON.stringify(c.issues.slice(0, 4)))
    }
    section('1b. canvas 墨迹审计：右边距带必须空白（右对齐栏不得冲出纸面）')
    for (const c of out.canvas) {
      ok('[' + c.label + '] 右边距带无墨迹（ink=' + (c.ink ? c.ink.ink : '?') + '）',
        c.ink && c.ink.ink === 0, JSON.stringify(c.ink))
    }
    section('2. canvas 导出图存证')
    for (const [label, dataUrl] of Object.entries(out.imgs)) {
      const p = path.join(ROOT, '.work', 'export-diag-canvas-' + label + '.png')
      fs.writeFileSync(p, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
      ok('[' + label + '] 整页 PNG 已存 ' + path.relative(ROOT, p) + ' (' + Math.round(fs.statSync(p).size / 1024) + ' KB)', true)
    }
    section('3. Word HTML：698px 内容区溢出审计')
    for (const w of out.word) {
      ok('[' + w.label + '] 无横向溢出元素（' + w.count + ' 处）', w.count === 0, JSON.stringify(w.over))
    }

    await client.close()
  } finally {
    try { client && client.close() } catch (e) {}
    chrome.kill()
  }

  console.log('\n==============================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (failures.length) failures.forEach((f) => console.log('  - ' + f))
  process.exit(fail ? 1 : 0)
}

run().catch((e) => { console.error('诊断失败：', e.message); process.exit(2) })
