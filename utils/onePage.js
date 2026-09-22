/**
 * 智能一页：把简历参数压缩到「刚好一页」。
 *
 * 设计要点
 * --------
 * 1. 分级优先：不同参数的视觉损失差别很大。区块间距从 18px 压到 10px 几乎无感，
 *    而字号从 14px 压到 11px 会明显影响阅读。因此按损失从小到大排队，
 *    前面的参数尽量保留，实在不够才动后面的。
 * 2. 每级二分：找到「刚好放得下」的最宽松值，而不是一路压到下限。
 *    这样能在满足一页的前提下，尽可能少地牺牲排版。
 * 3. 无解时不假装成功：全部压到极限仍超过一页时如实返回 ok=false，
 *    并把最紧的参数一并给出，让调用方明确告知用户「内容确实太多」。
 */

/**
 * 行距的安全下限（无单位倍数）。
 *
 * 参考站 polebrief 的 decLineHeight 里有一条硬约束：行距小于 1.5 倍字号时不再下压
 * （那时代码直接 return）。它的行距以 px 存储、字号以 pt 存储，
 * 折算成「行距 / 字号」的倍数大约是 1.12——与我们滑杆的 min（1.1）几乎一致。
 *
 * 这个下限必须保留：行距是相对字号的无单位倍数，压得过小时
 * 中文字形会上下相接、几乎糊成一片。
 */
const MIN_LINE_HEIGHT_RATIO = 1.1;

/**
 * 可读性下限（智能一页压缩时不得越过）。
 *
 * 字号：中文正文低于 12px 时笔画开始粘连，屏幕上看着就"糊"，
 *   打印出来更吃力。参考站的字号是 11pt ≈ 14.67px，12px 已是相当克制的底线。
 *   滑杆允许到 10px 是留给用户手动微调的，但自动压缩不该主动走到那么小。
 * 行距：见 MIN_LINE_HEIGHT_RATIO 的说明。
 */
const MIN_READABLE_FONT_SIZE = 12;

/**
 * 判页容差（设计 px）——「内容算不算占用了下一页」的宽容量。
 *
 * 为什么需要它：内容高度由「行数 × 字号 × 行高」累加而来，天然带小数。
 * 实测这份简历内容底边 1087.9px，加上 36px 下边距得 1123.9px，而 A4 只有
 * 1123px——**只超出 0.9px**，浏览器却据此切出第 2 页，那一页只落着一两行，
 * 看着就像凭空多了一张纸。
 *
 * 取 1px 而不是更大：有效下边距会变成 `verticalPadding − 1`，而各回归用例
 * 与产品预期都以「每页底部至少留出 `verticalPadding − 1`」为准（见
 * tools/print-preview-test.mjs 的 MIN_GAP）。1px 恰好吸收这类亚像素取整误差，
 * 又不至于让页脚留白明显变窄。
 *
 * 这是**唯一事实来源**，三处必须取同一个值，否则会出现
 * 「屏幕 1 页、导出 2 页」或「智能一页说溢出、页数提示说刚好」的自相矛盾：
 *   1. 纸张判页与下内边距（ResumePaper）
 *   2. 打印分页（usePrintPageMargin 把它从 @page 的下边距里让出来）
 *   3. 智能一页试算（EditView 用它抬高目标高度）
 */
const PAGINATION_SLACK = 1

/** 智能一页的自动压缩下限；手动设置和模板预设仍可使用更小的边距。 */
const MIN_HORIZONTAL_PADDING = 40;
const MIN_VERTICAL_PADDING = 30;

/**
 * 压缩优先级（损失从小到大）与各自的安全下限。
 *
 * min 限制自动压缩；已有值低于下限时保留原值，不在压缩过程中放大。
 */
const FIT_LEVELS = [
  { key: 'sectionSpacing', min: 6, max: 40, step: 1, label: '区块间距', unit: 'px', decimals: 0 },
  { key: 'verticalPadding', min: MIN_VERTICAL_PADDING, max: 80, step: 1, label: '上下边距', unit: 'px', decimals: 0 },
  { key: 'lineHeight', min: MIN_LINE_HEIGHT_RATIO, max: 2.4, step: 0.01, label: '行距', unit: '', decimals: 2 },
  { key: 'fontSpacing', min: -0.5, max: 3, step: 0.1, label: '字距', unit: 'px', decimals: 1 },
  { key: 'horizontalPadding', min: MIN_HORIZONTAL_PADDING, max: 90, step: 1, label: '左右边距', unit: 'px', decimals: 0 },
  { key: 'fontSize', min: MIN_READABLE_FONT_SIZE, max: 20, step: 0.5, label: '字号', unit: 'px', decimals: 1 }
]

/** 参与智能一页的字段名 */
const FIT_KEYS = FIT_LEVELS.map((l) => l.key)

/** 按各字段的步长对齐，避免出现 1.4300000000000002 这类浮点噪声 */
function alignTo(value, step) {
  const n = Math.round(value / step) * step
  // 步长含小数时按步长的小数位收敛，消除二进制浮点残差
  const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0
  return Number(n.toFixed(decimals))
}

/** 抽出当前排版参数 */
function readFitParams(resume) {
  const out = {}
  for (const k of FIT_KEYS) out[k] = Number(resume[k])
  return out
}

/** 从旧值到新值的变化清单，用于告诉用户「动了哪些参数」 */
function diffParams(before, after) {
  const changes = []
  for (const lv of FIT_LEVELS) {
    const a = Number(before[lv.key])
    const b = Number(after[lv.key])
    if (Math.abs(a - b) < 1e-6) continue
    changes.push({
      key: lv.key,
      label: lv.label,
      unit: lv.unit,
      decimals: lv.decimals,
      from: a,
      to: b
    })
  }
  return changes
}

/** 把变化清单格式化成一句人话，用于 toast 提示 */
function describeChanges(changes) {
  return changes
    .map((c) => `${c.label} ${c.from.toFixed(c.decimals)}${c.unit} → ${c.to.toFixed(c.decimals)}${c.unit}`)
    .join('，')
}

/**
 * 求一组能让内容「刚好撑满但不超过」targetHeight 的排版参数（双向）。
 *
 * 两个方向各自解决一个真实诉求：
 *  - 溢出时向下压缩：把内容收进一页（也见 fitToOnePage）。
 *  - 内容不足时向上撑满：一页简历只有半页内容会显得单薄，
 *    这里放大行距把它铺满整页（参考站 autoOnePage 的 ascLineHeight 就是这个意图）。
 *
 * 之所以把「撑满」也纳入：只做压缩的话，用户点完按钮可能得到
 * 「一页但下半页空白」的结果，观感反而不如原来。
 *
 * @param {object} start   当前参数
 * @param {(p: object) => number} measure 给定参数返回内容高度（含上下边距）
 * @param {number} targetHeight 目标高度，即一页 A4
 * @param {object} [opts]
 * @param {number} [opts.growKey] 用于撑满的参数（默认 lineHeight，与参考站一致）
 * @param {number} [opts.growMax] 该参数的上限
 * @param {number} [opts.tolerance] 视为「刚好」的容差（px）
 */
function fitOnePageSmart(start, measure, targetHeight, opts = {}) {
  const growKey = opts.growKey || 'lineHeight'
  const growLevel = FIT_LEVELS.find((l) => l.key === growKey) || FIT_LEVELS[2]
  const growMax = opts.growMax ?? 2.4
  const tolerance = opts.tolerance ?? 8

  const current = measure(start)

  // 溢出：先按优先级压缩
  if (current > targetHeight) {
    const fitted = fitToOnePage(start, measure, targetHeight)
    return { ...fitted, mode: fitted.ok ? (fitted.alreadyFits ? 'none' : 'shrink') : 'tight' }
  }

  // 已经比较满（差距在容差内）：不动，避免为了几像素做无谓改动
  if (targetHeight - current <= tolerance) {
    return { params: { ...start }, ok: true, alreadyFits: true, changes: [], mode: 'none' }
  }

  // 内容不足一页：先放大行距，行距到顶后再放大字号。
  //
  // 为什么要两级：行距只作用于「行与行之间」，内容行数很少时
  // （例如只有两行简介）把行距从 1.65 拉到上限也只能多占几十像素，
  // 仍然铺不满一页。此时放大字号才是有效手段——它同时增大行高与字面高度。
  // 参考站只做行距这一级，因此内容极少时它的撑满几乎看不出效果。
  const params = { ...start }
  let changed = false

  // 一级：行距（视觉损失小，优先）
  const lhBase = Number(params[growKey])
  if (lhBase > 0 && lhBase < growMax) {
    if (measure({ ...params, [growKey]: growMax }) <= targetHeight) {
      params[growKey] = alignTo(growMax, growLevel.step)
      changed = true
    } else {
      let lo = lhBase
      let hi = growMax
      while (hi - lo > growLevel.step) {
        const mid = alignTo((lo + hi) / 2, growLevel.step)
        if (!(mid > lo) || !(mid < hi)) break
        if (measure({ ...params, [growKey]: mid }) <= targetHeight) lo = mid
        else hi = mid
      }
      params[growKey] = alignTo(lo, growLevel.step)
      changed = true
    }
  }

  // 还不够满 → 二级：字号（在行距已达上限的基础上继续逼近目标）
  if (measure(params) < targetHeight - tolerance) {
    const fsLevel = FIT_LEVELS.find((l) => l.key === 'fontSize')
    const fsBase = Number(params.fontSize)
    const fsMax = opts.fontSizeMax ?? 20
    if (fsBase > 0 && fsBase < fsMax) {
      if (measure({ ...params, fontSize: fsMax }) <= targetHeight) {
        params.fontSize = alignTo(fsMax, fsLevel.step)
        changed = true
      } else {
        let lo = fsBase
        let hi = fsMax
        while (hi - lo > fsLevel.step) {
          const mid = alignTo((lo + hi) / 2, fsLevel.step)
          if (!(mid > lo) || !(mid < hi)) break
          if (measure({ ...params, fontSize: mid }) <= targetHeight) lo = mid
          else hi = mid
        }
        // 只在确实能放大时才写回，避免把字号改小
        if (lo > fsBase) {
          params.fontSize = alignTo(lo, fsLevel.step)
          changed = true
        }
      }
    }
  }

  // 三级：弹性留白（区块间距、上下边距）。
  //
  // 内容极少时（例如只填了姓名 + 电话），行距与字号都到顶也铺不满整页——
  // 因为「能撑高的只有那么几行」，这是内容量决定的，放大字号解决不了。
  // 此时唯一既不动内容、又不损伤可读性的手段是「把留白拉开」：
  // 区块之间、页面上下都多留些空间，让整页看起来舒展而不是挤在顶部。
  // 这也是排版软件里「垂直对齐 / 分散对齐」的常规做法。
  if (measure(params) < targetHeight - tolerance) {
    for (const key of opts.spreadKeys || ['sectionSpacing', 'verticalPadding']) {
      const lv = FIT_LEVELS.find((l) => l.key === key)
      if (!lv) continue
      const base = Number(params[key])
      const max = opts.spreadMax?.[key] ?? lv.max ?? base
      if (!(base > 0) || base >= max) continue
      if (measure({ ...params, [key]: max }) <= targetHeight) {
        params[key] = alignTo(max, lv.step)
        changed = true
        continue
      }
      let lo = base
      let hi = max
      while (hi - lo > lv.step) {
        const mid = alignTo((lo + hi) / 2, lv.step)
        if (!(mid > lo) || !(mid < hi)) break
        if (measure({ ...params, [key]: mid }) <= targetHeight) lo = mid
        else hi = mid
      }
      if (lo > base) {
        params[key] = alignTo(lo, lv.step)
        changed = true
      }
    }
  }

  const finalH = measure(params)

  // 一个参数都改不动 = 所有可放大的参数都已在上限。
  // 走到这里说明内容确实不足一页（内容够的情况在函数开头就已提前返回），
  // 因此必须报「撑不满」而不是「已经刚好一页」——否则用户会以为功能没生效。
  if (!changed) {
    return {
      params: { ...start },
      ok: true,
      alreadyFits: false,
      changes: [],
      mode: 'underfilled',
      filled: false,
      finalHeight: finalH
    }
  }

  // filled=false 表示参数已尽力仍不满一页：纯排版解决不了，需如实告知。
  return {
    params,
    ok: true,
    alreadyFits: false,
    changes: diffParams(start, params),
    mode: 'grow',
    filled: finalH >= targetHeight - tolerance,
    finalHeight: finalH
  }
}

/**
 * 求一组能让内容放进 targetHeight 的排版参数。
 *
 * @param {object} start   当前参数（readFitParams 的结果）
 * @param {(p: object) => number} measure 给定参数返回内容高度（含上下边距）
 * @param {number} targetHeight 目标高度，即一页 A4
 * @returns {{ params: object, ok: boolean, alreadyFits: boolean, changes: Array }}
 */
function fitToOnePage(start, measure, targetHeight) {
  const params = { ...start }

  // 本来就放得下：不做任何改动，交由调用方提示「已经是一页」
  if (measure(params) <= targetHeight) {
    return { params, ok: true, alreadyFits: true, changes: [] }
  }

  for (const lv of FIT_LEVELS) {
    const current = Number(params[lv.key])
    // 当前值已经在下限（或低于下限）：压无可压，交给下一级
    if (!(current > lv.min)) continue

    // 这一级压到下限是否就够？不够则锁定下限，继续下一级
    if (measure({ ...params, [lv.key]: lv.min }) > targetHeight) {
      params[lv.key] = lv.min
      continue
    }

    // 够：在 [min, current] 里二分，找最宽松的可行值
    let lo = lv.min
    let hi = current
    while (hi - lo > lv.step) {
      const mid = alignTo((lo + hi) / 2, lv.step)
      if (!(mid > lo) || !(mid < hi)) break
      if (measure({ ...params, [lv.key]: mid }) <= targetHeight) lo = mid
      else hi = mid
    }
    params[lv.key] = alignTo(lo, lv.step)

    return {
      params,
      ok: true,
      alreadyFits: false,
      changes: diffParams(start, params)
    }
  }

  // 所有级别都压到极限
  const ok = measure(params) <= targetHeight
  return { params, ok, alreadyFits: false, changes: diffParams(start, params) }
}

module.exports = {
  MIN_LINE_HEIGHT_RATIO,
  MIN_READABLE_FONT_SIZE,
  PAGINATION_SLACK,
  MIN_HORIZONTAL_PADDING,
  MIN_VERTICAL_PADDING,
  FIT_LEVELS,
  FIT_KEYS,
  alignTo,
  readFitParams,
  diffParams,
  describeChanges,
  fitOnePageSmart,
  fitToOnePage
}
