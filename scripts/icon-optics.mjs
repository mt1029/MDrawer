// 量 Tabler 圖示的「視覺重心」，產生 src/components/iconOptics.ts。
//
// 做法：把圖示模糊之後，只留下「看得到的那一團」（亮度超過最大值的 30%），
// 用這一團的重心與左緣來對齊，而不是用圖示的外框。細的線條、開口的形狀模糊後會變淡，
// 密的部分會連成一塊，跟眼睛看到的「重量」比較接近。
// （光是模糊不會改變重心：對稱的模糊是卷積，重心不變；有差別的是模糊後「取看得到的部分」這一步。）
//
// 使用方式（新增圖示後重跑）：
//   1. node scripts/icon-optics.mjs        找出 src 用到的圖示，產生 scripts/icon-optics.html
//   2. 用瀏覽器打開 scripts/icon-optics.html  頁面會量好並顯示 iconOptics.ts 的內容
//   3. 把內容貼到 src/components/iconOptics.ts

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as icons from '@tabler/icons-react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 跟 src/components/icons.tsx 一樣的線條粗細
const STROKE = 1.5

// 肉眼微調（格，正數往右）：量測後實際看起來還是偏的圖示，在量測值上再加這麼多。
// 登出：左邊的長方形（門）很搶眼，量測值移過去之後看起來仍然偏左
const MANUAL_ADJUST = {
  IconLogout: 0.6,
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}

const names = [
  ...new Set(sourceFiles('src').flatMap((file) => readFileSync(file, 'utf8').match(/\bIcon[A-Z][A-Za-z0-9]+\b/g) ?? [])),
]
  .filter((name) => name in icons && name !== 'Icon')
  .sort()

const svgs = Object.fromEntries(
  names.map((name) => [name, renderToStaticMarkup(createElement(icons[name], { size: 24, stroke: STROKE }))]),
)

const page = `<!doctype html>
<meta charset="utf-8">
<title>圖示視覺重心</title>
<p id="status">量測中…</p>
<pre id="output"></pre>
<script>
const SVGS = ${JSON.stringify(svgs)}
const MANUAL_ADJUST = ${JSON.stringify(MANUAL_ADJUST)}
const SCALE = 8            // 放大 8 倍來量（24 格 → 192px）
const BLUR = 2             // 模糊的標準差（格）
const THRESHOLD = 0.3      // 模糊後亮度超過最大值的 30% 算「看得到」
const MAX_SHIFT = 2        // 最多移動 2 格，避免形狀特殊的圖示被移太多
const PAD = 8 * SCALE      // 四周留空，模糊時不會被切掉

async function measure(svg) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const img = new Image()
  img.src = url
  await img.decode()
  const size = 24 * SCALE
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size + PAD * 2
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.filter = 'blur(' + BLUR * SCALE + 'px)'
  ctx.drawImage(img, PAD, PAD, size, size)
  URL.revokeObjectURL(url)
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let max = 0
  for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i])
  let sumX = 0, count = 0, left = Infinity
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= max * THRESHOLD) {
        sumX += x + 0.5 // 用像素的中心，否則左右對稱的圖示也會偏半個像素
        count++
        if (x < left) left = x
      }
    }
  }
  const toUnits = (px) => (px - PAD) / SCALE
  return { center: toUnits(sumX / count), left: toUnits(left) }
}

const round = (n) => Math.round(n * 100) / 100

;(async () => {
  const shifts = {}
  const lefts = []
  for (const [name, svg] of Object.entries(SVGS)) {
    const { center, left } = await measure(svg)
    // 讓「看得到的那一團」的重心落在 24 格的正中間（12），再加上肉眼微調
    const shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, 12 - center)) + (MANUAL_ADJUST[name] ?? 0)
    shifts[name] = round(shift)
    lefts.push(left + shift)
  }
  // 選單裡圖示靠左排：整欄往左移，讓這一團的左緣平均起來對齊文字的左邊
  const menuShift = round(-lefts.reduce((a, b) => a + b, 0) / lefts.length)
  const lines = Object.entries(shifts).map(([name, shift]) => '  ' + name + ': ' + shift + ',')
  const ts = [
    '// 由 scripts/icon-optics.mjs 產生（' + new Date().toISOString().slice(0, 10) + '），新增圖示後重跑，不要手動修改。',
    '// 數字的單位是圖示的 24 格，實際的 px 依圖示大小換算。',
    '',
    '/** 把圖示模糊後「看得到的那一團」移到正中間要水平移動多少（正數往右），已含腳本裡的肉眼微調（' + Object.keys(MANUAL_ADJUST).join('、') + '） */',
    'export const ICON_OPTICAL_SHIFT: Record<string, number> = {',
    ...lines,
    '}',
    '',
    '/** 選單的圖示靠左排時，整欄要移多少，這一團的左緣才會平均對齊文字的左邊 */',
    'export const MENU_ICON_SHIFT = ' + menuShift,
    '',
  ].join('\\n')
  document.getElementById('status').textContent = '完成：' + Object.keys(shifts).length + ' 個圖示'
  document.getElementById('output').textContent = ts
  window.__result = ts
})()
</script>
`

writeFileSync('scripts/icon-optics.html', page)
console.log(`找到 ${names.length} 個圖示：${names.join('、')}`)
console.log('已產生 scripts/icon-optics.html，用瀏覽器打開後把內容貼到 src/components/iconOptics.ts')
