# 專案規則
- 開始前先讀 docs/spec.md。一次只做一個功能，做完停下來讓我檢查。
- UI 一律透過 src/lib/repo.ts 讀寫資料，不直接呼叫 Supabase。
- 渲染 Markdown 一律先經 DOMPurify，且 markdown-it 設 html: false。
- 不得修改 RLS 政策、觸發器或資料表結構，除非我明確同意。
- updated_at 與 version 只由資料庫寫入，前端不得自行填寫。
- 每完成一個功能，在 docs/ai-log.md 新增一列：日期、功能、提示重點、AI 產出、我修改的地方與原因、驗證結果。
- 每個功能一個 commit，訊息說明做了什麼。
