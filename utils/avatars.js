/**
 * 内置证件照头像。
 *
 * 参考站把头像内联成 dataURL SVG，好处是零请求、可离线渲染；代价是
 * SVG 无法直接交给 canvas.drawImage()（小程序 canvas 2d 不支持 SVG），
 * 而小程序的图片导出、智能一页测量都要经过 canvas。
 *
 * 因此这里改为「构建期从同一份 SVG 源渲染出的 PNG」：
 *   assets/avatar-man.png / assets/avatar-woman.png（240×320）
 * 矢量图形未变，只是载体换成了 canvas 与 <image> 都能直接用的位图。
 * 选图动作也只把短标识（asset:avatar-man）存进简历字段，真正的路径在
 * 渲染时解析——避免把大字符串写进每一份草稿。
 */

const AVATAR_MAN = '/assets/avatar-man.png'
const AVATAR_WOMAN = '/assets/avatar-woman.png'

const AVATAR_MAP = {
  'asset:avatar-man': AVATAR_MAN,
  'asset:avatar-woman': AVATAR_WOMAN
}

/**
 * 把简历里保存的照片标识解析成可直接渲染的路径。
 * 兼容参考站的 avatar:man / avatar:woman 写法（导入旧备份时会出现）。
 */
function resolvePhoto (val) {
  if (!val) return ''
  if (AVATAR_MAP[val]) return AVATAR_MAP[val]
  if (val === 'avatar:man') return AVATAR_MAN
  if (val === 'avatar:woman') return AVATAR_WOMAN
  // 用户自选照片存的是本地临时文件路径 / wxfile://，原样返回
  return val
}

/** 是否内置头像（用于区分内置素材与用户自选照片） */
function isBuiltinPhoto (val) {
  return !!(val && (AVATAR_MAP[val] || String(val).startsWith('avatar:')))
}

module.exports = { AVATAR_MAN, AVATAR_WOMAN, AVATAR_MAP, resolvePhoto, isBuiltinPhoto }
