/**
 * 真实渲染复现：基本信息面板右侧开关「点了完全没反应」。
 *
 * 为什么必须有这个脚本
 * --------------------
 * tools/check-editlayout.cjs 是在无头 Chrome 里复刻一份**手写 HTML**，
 * 它能守住几何与命中，但复刻不出「小程序渲染器 + WXML 事件系统 + dataset 绑定」。
 * 「开关点不动」恰好落在那个盲区里：
 *   · 浏览器探针里 .switch 能命中，于是误判为「只有真机才有的原生组件问题」；
 *   · 而用户实测是**模拟器里就点不动**，说明根因在别处。
 * 所以只能连真实的开发者工具来跑，而不是再写一份仿真。
 *
 * 前提：开发者工具 → 设置 → 安全设置 → **服务端口 已开启**。
 * 用法：node tools/repro-base-switch.cjs
 *      （或先用 cli auto --port <port> 拿到 wsEndpoint，再 WS_ENDPOINT=... node ...）
 */
const path = require('path')
const automator = require('miniprogram-automator')

const ROOT = path.resolve(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 数组长度变了 / 内容变了都算「数据变了」 */
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b)

async function main () {
  const ws = process.env.WS_ENDPOINT
  const mp = ws
    ? await automator.connect({ wsEndpoint: ws })
    : await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })

  try {
    const page = await mp.reLaunch('/pages/edit/edit')
    await page.waitFor(1500)

    console.log('=== 1. 复刻用户路径：点纸面「姓名」进基本信息面板 ===')
    await page.callMethod('onPick', { detail: { base: 'name' } })
    await sleep(600)
    console.log('panel    =', await page.data('panel'))
    console.log('focusKey =', await page.data('focusKey'), '  ← 进面板时会自动聚焦该行输入框')

    const switches = await page.$$('.switch')
    console.log('页面上 .switch 数量 =', switches.length)
    if (!switches.length) throw new Error('没找到 .switch，说明面板没渲染出来或选择器不对')

    const first = switches[0]
    console.log('第一个开关 class    =', await first.attribute('class'))
    console.log('第一个开关 data-key =', await first.attribute('data-key'))

    console.log('\n=== 2. 二分法：是「事件没抵达 handler」还是「handler 自己坏了」 ===')
    const before = await page.data('activeFields')
    console.log('点击前 activeFields =', JSON.stringify(before))
    /* 直接调用 handler，绕开 WXML 事件系统与 dataset 绑定。
       若这样能改数据，问题就在「事件/绑定」；若也改不了，问题在 handler/store。 */
    await page.callMethod('onToggleField', { currentTarget: { dataset: { key: 'name' } } })
    await sleep(600)
    const afterDirect = await page.data('activeFields')
    console.log('直调 handler 后     =', JSON.stringify(afterDirect))
    const handlerOk = changed(before, afterDirect)
    console.log(handlerOk
      ? '  → handler 与 store 正常：问题在「事件没能抵达 handler」'
      : '  → handler 或 store 就有问题（数据没变）')

    console.log('\n=== 3. 真实点击（automator 的 tap 等价手指点击） ===')
    const before2 = await page.data('activeFields')
    console.log('tap 前 activeFields =', JSON.stringify(before2))
    await first.tap()
    await sleep(800)
    const after2 = await page.data('activeFields')
    console.log('tap 后 activeFields =', JSON.stringify(after2))
    const tapOk = changed(before2, after2)
    console.log(tapOk ? '  → tap 生效（未能复现）' : '  → tap 没生效（成功复现「点不动」）')

    console.log('\n=== 4. 补充证据：焦点是否抢走了点击 ===')
    /* 怀疑点之一：focusKey 从进面板后一直是 'name'，该行 input 持续请求焦点，
       在模拟器里可能表现为「第一次点别处只用来收焦点」。 */
    console.log('focusKey 仍为 =', await page.data('focusKey'))
    const activeEl = await page.evaluate(() => {
      const e = document.activeElement
      return e ? (e.tagName + '.' + (e.className || '')) : null
    }).catch(() => '(evaluate 不可用)')
    console.log('当前聚焦元素 =', activeEl)

    const out = path.join(ROOT, '.work/repro-base-switch.png')
    await mp.screenshot({ path: out })
    console.log('\n已截图 ' + path.relative(ROOT, out))

    console.log('\n=== 结论 ===')
    console.log('handler 正常 =', handlerOk, ' | 真实点击生效 =', tapOk)
    if (handlerOk && !tapOk) {
      console.log('→ 修复方向：让点击能抵达 .switch（遮挡 / 热区 / 事件绑定 / 焦点抢占）')
    } else if (!handlerOk) {
      console.log('→ 修复方向：onToggleField 或 store.toggleField / refresh 的数据链路')
    }
  } finally {
    await mp.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('\n复现失败：' + (e && e.message))
  console.error('若提示服务端口未开启：开发者工具 → 设置 → 安全设置 → 服务端口')
  process.exit(1)
})
