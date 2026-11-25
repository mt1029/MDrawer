// 從 public/logo.svg 產生 PWA 需要的各尺寸圖示：npm run icons
// 產生的 PNG / ICO 放在 public/，一起提交到 Git，打包時不必再跑一次。
import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

const BRAND_BLUE = '#2f6feb'

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    // 可遮罩圖示與 iOS 主畫面圖示：logo.svg 本身已留安全邊距，不再加外框；
    // 圓角外的透明處補上品牌藍，讓系統自己裁成圓形或圓角
    maskable: { ...minimal2023Preset.maskable, padding: 0, resizeOptions: { background: BRAND_BLUE } },
    apple: { ...minimal2023Preset.apple, padding: 0, resizeOptions: { background: BRAND_BLUE } },
  },
  images: ['public/logo.svg'],
})
