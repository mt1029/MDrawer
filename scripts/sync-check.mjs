// 離線 L2 的同步，在真正的 Supabase 上檢查一次（單元測試用的是假的雲端，這裡確認真的資料庫行為一致）。
// 直接使用 App 的 src/lib/cloud.ts（Node 可以直接執行 TypeScript），檢查的就是 App 實際送出的請求。
// 執行：npm run test:sync（需要 .env.local 與 .env.test.local，同 npm run test:rls）
// 測試資料都放在一個「同步測試 <時間>」資料夾裡，結束時會實際刪除；圖片檔的檢查會上傳測試用的小檔案，結束時也會刪掉。
// 垃圾桶的檢查需要先執行 supabase/migrations/20261127000000_trash.sql（purged_at 欄位）。

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createCloud } from '../src/lib/cloud.ts'

const env = process.env
const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'TEST_A_EMAIL', 'TEST_A_PASSWORD', 'TEST_B_EMAIL', 'TEST_B_PASSWORD']
const missing = required.filter((name) => !env[name])
if (missing.length > 0) {
  console.error(`缺少環境變數：${missing.join('、')}`)
  console.error('請照 docs/database.md 建立 .env.test.local，再執行 npm run test:sync')
  process.exit(1)
}

async function signIn(label, email, password) {
  const client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) {
    console.error(`${label} 帳號登入失敗：${error.message}`)
    process.exit(1)
  }
  return client
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `（${detail}）` : ''}`)
  if (!ok) failures++
}

async function kindOf(promise) {
  try {
    await promise
    return 'ok'
  } catch (err) {
    return err?.kind ?? String(err)
  }
}

const clientA = await signIn('A', env.TEST_A_EMAIL, env.TEST_A_PASSWORD)
const clientB = await signIn('B', env.TEST_B_EMAIL, env.TEST_B_PASSWORD)
// 每頁只讀 2 筆，才能用少量資料測到「接著上一頁往下讀」的條件
const a = createCloud(clientA, { pageSize: 2 })
const b = createCloud(clientB, { pageSize: 2 })

const created = [] // 結束時刪除（子項目先）
const folderId = randomUUID()
// 圖片檔的檢查用的測試檔（結束時若還在就刪掉）
const fileId = randomUUID()
let filePath = null
const otherPaths = []
const startedAt = new Date(Date.now() - 60_000).toISOString()

try {
  // ── 新增：upsert + ignoreDuplicates ──
  const folder = await a.insertIfAbsent({ id: folderId, parent_id: null, type: 'folder', name: `同步測試 ${new Date().toISOString()}`, content: null })
  created.unshift(folderId)
  check('新增資料夾，version 與時間由資料庫寫入', folder?.version === 1 && !!folder.updated_at && folder.deleted_at === null, JSON.stringify(folder))
  const again = await a.insertIfAbsent({ id: folderId, parent_id: null, type: 'folder', name: '改過的名稱', content: null })
  check('同一個 id 再送一次：不報錯、不覆蓋，回傳 null（回應遺失時重送也安全）', again === null)

  const noteIds = []
  for (const name of ['筆記一', '筆記二', '筆記三']) {
    const id = randomUUID()
    await a.insertIfAbsent({ id, parent_id: folderId, type: 'note', name, content: `${name}的內容` })
    created.unshift(id)
    noteIds.push(id)
  }

  check(
    '同層同名（不分大小寫）：回報 duplicate_name',
    (await kindOf(a.insertIfAbsent({ id: randomUUID(), parent_id: folderId, type: 'note', name: '筆記一'.toUpperCase(), content: '' }))) === 'duplicate_name',
  )
  check(
    '上層不存在：回報 not_found（外鍵）',
    (await kindOf(a.insertIfAbsent({ id: randomUUID(), parent_id: randomUUID(), type: 'note', name: '孤兒', content: '' }))) === 'not_found',
  )

  // ── 修改：version 吻合才更新 ──
  const [one, two, three] = noteIds
  const updated = await a.updateIfVersion(one, { content: '改過的內容' }, 1)
  check('version 吻合：更新成功，version 變成 2', updated?.version === 2 && updated.content === '改過的內容', JSON.stringify(updated))
  const stale = await a.updateIfVersion(one, { content: '用舊版本改' }, 1)
  check('version 不吻合（被別台改過）：不更新，回傳 null', stale === null)
  const [afterStale] = await a.getRows([one])
  check('不吻合時雲端內容沒有被改', afterStale?.content === '改過的內容')
  check('改名撞名：回報 duplicate_name', (await kindOf(a.updateIfVersion(two, { name: '筆記三' }, 1))) === 'duplicate_name')

  // ── 刪除與還原 ──
  // 跟 App 的推送一樣，刪除時一併把 purged_at 設成 null（欄位不存在時這裡會失敗）
  const deleted = await a.updateIfVersion(three, { deleted_at: new Date().toISOString(), purged_at: null }, 1)
  check('標記刪除', deleted?.deleted_at !== null && deleted?.version === 2)
  const [deletedRow] = await a.getRows([three])
  check('getRows 讀得到已刪除的列', deletedRow?.deleted_at !== null)
  const restored = await a.updateIfVersion(three, { deleted_at: null, content: '還原時帶上的修改' }, 2)
  check('還原（刪除不會蓋掉較新的修改）', restored?.deleted_at === null && restored.content === '還原時帶上的修改')
  await a.updateIfVersion(three, { deleted_at: new Date().toISOString() }, 3)

  // ── 拉取：分頁、含已刪除、依時間排序 ──
  const pulled = await a.pullSince(startedAt)
  const ids = pulled.map((row) => row.id)
  check('拉取到這次新增的 4 列（每頁 2 筆，跨頁接續讀取）', [folderId, ...noteIds].every((id) => ids.includes(id)), `拉到 ${ids.length} 列`)
  check('拉取結果沒有重複', new Set(ids).size === ids.length)
  check('拉取結果包含已刪除的列', pulled.some((row) => row.id === three && row.deleted_at !== null))
  check(
    '依 updated_at 排序',
    pulled.every((row, i) => i === 0 || Date.parse(pulled[i - 1].updated_at) <= Date.parse(row.updated_at)),
  )

  // ── 帳號隔離（RLS） ──
  const pulledByB = await b.pullSince(startedAt)
  check('B 拉不到 A 的資料', !pulledByB.some((row) => [folderId, ...noteIds].includes(row.id)))
  check('B 用 A 的 id 讀取：查無資料', (await b.getRows([one])).length === 0)
  check('B 修改 A 的列：沒有作用', (await b.updateIfVersion(one, { content: 'B 改的' }, 2)) === null)
  await kindOf(b.insertIfAbsent({ id: one, parent_id: null, type: 'note', name: 'B 的', content: 'B 的' }))
  const [stillA] = await a.getRows([one])
  check('B 修改、用 A 的 id 新增之後，A 的資料維持原樣', stillA?.content === '改過的內容' && stillA.version === 2)

  // ── 垃圾桶：列出、永久刪除（purged_at） ──
  const inTrash = async (cloud, id) => (await cloud.listTrash()).find((row) => row.id === id)
  const trashed = await inTrash(a, three)
  check('垃圾桶列出已刪除的列，不含筆記的內容', !!trashed && !('content' in trashed), JSON.stringify(trashed))
  check('B 的垃圾桶看不到 A 的', !(await inTrash(b, three)))
  check('B 永久刪除 A 的列：沒有作用', (await b.purge([three])).length === 0 && !!(await inTrash(a, three)))
  check('永久刪除沒有刪除的列：沒有作用', (await a.purge([one])).length === 0)
  const [purged] = await a.purge([three])
  check('永久刪除：筆記內容清掉、列保留（仍是已刪除）', purged?.content === null && purged.deleted_at !== null, JSON.stringify(purged))
  check('永久刪除後垃圾桶不再列出', !(await inTrash(a, three)))
  check('已經永久刪除的再永久刪除一次：沒有作用', (await a.purge([three])).length === 0)
  // 另一台離線時改過、推上來（修改優先）：還原並清掉 purged_at，之後再刪除會回到垃圾桶
  const revived = await a.updateIfVersion(three, { deleted_at: null, purged_at: null, content: '另一台的修改' }, purged.version)
  check('永久刪除的列被修改還原', revived?.deleted_at === null && revived.content === '另一台的修改')
  await a.updateIfVersion(three, { deleted_at: new Date().toISOString(), purged_at: null }, revived.version)
  check('還原後再刪除：回到垃圾桶', !!(await inTrash(a, three)))

  // ── 圖片檔上傳（uploadImage）：id 由前端產生，離線時插入的圖片同步時也用這個上傳 ──
  const uidA = (await clientA.auth.getSession()).data.session.user.id
  filePath = `${uidA}/${fileId}`
  // 用 list 查 Storage 的資料表，不用 download：下載會經過 CDN 快取，刪除後一段時間內可能還拿得到
  const fileInfo = async (id = fileId) => {
    const { data, error } = await clientA.storage.from('images').list(uidA, { search: id })
    if (error) throw error
    return data.find((file) => file.name === id)
  }
  const fileExists = async () => !!(await fileInfo())
  const uploaded = await kindOf(a.uploadImage(fileId, new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'image/webp' })))
  check('上傳圖片檔：用前端產生的 id', uploaded === 'ok' && (await fileExists()), uploaded)
  const resent = await kindOf(a.uploadImage(fileId, new Blob([new Uint8Array(8)], { type: 'image/webp' })))
  check('同一個 id 再傳一次（回應遺失時重送）：當成已上傳，不報錯', resent === 'ok', resent)
  const size = (await fileInfo())?.metadata?.size
  check('重送不會覆蓋原本的檔案', size === 4, `大小 ${size}`)
  const pngId = randomUUID()
  otherPaths.push(`${uidA}/${pngId}`)
  const png = await kindOf(a.uploadImage(pngId, new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })))
  check('格式不對（PNG）：回報錯誤，不會當成已上傳', png === 'unknown' && !(await fileInfo(pngId)), png)

  // ── 資料夾裡的圖片：永久刪除後清掉 Storage 的檔案（removeImageIfUnused） ──

  const imageOne = randomUUID()
  const imageTwo = randomUUID()
  for (const [id, name] of [[imageOne, '圖.webp'], [imageTwo, '圖的副本.webp']]) {
    await a.insertIfAbsent({ id, parent_id: folderId, type: 'image', name, content: fileId })
    created.push(id)
  }
  await a.updateIfVersion(imageOne, { deleted_at: new Date().toISOString(), purged_at: null }, 1)
  await a.purge([imageOne])
  check('永久刪除一張、另一張還用同一個檔案：保留', (await a.removeImageIfUnused(fileId)) === false && (await fileExists()))

  check('B 呼叫：查不到 A 的資料，也刪不到 A 的檔案', (await b.removeImageIfUnused(fileId)) === false && (await fileExists()))

  const secondDeleted = await a.updateIfVersion(imageTwo, { deleted_at: new Date().toISOString(), purged_at: null }, 1)
  check('另一張刪除（在垃圾桶、還能還原）：保留', (await a.removeImageIfUnused(fileId)) === false && (await fileExists()))

  const secondPurged = await a.purge([imageTwo])
  check('永久刪除圖片：content 仍是檔案的 id（資料庫限制）', secondPurged[0]?.content === fileId, JSON.stringify(secondPurged))
  const removed = await kindOf(a.removeImageIfUnused(fileId).then((result) => { if (!result) throw new Error('回傳 false') }))
  check('都永久刪除了：removeImageIfUnused 刪掉檔案', removed === 'ok', `第二張刪除${secondDeleted ? '成功' : '失敗'}，結果：${removed}`)
  check('刪掉之後 Storage 裡查不到這個檔案', !(await fileExists()))
} catch (err) {
  failures++
  console.error('✗ 執行時發生錯誤：', err)
} finally {
  // 實際刪除測試資料（子項目先，避免外鍵錯誤）
  const { error } = await clientA.from('nodes').delete().in('id', created.filter((id) => id !== folderId))
  const { error: folderError } = await clientA.from('nodes').delete().eq('id', folderId)
  if (error || folderError) console.error('清除測試資料失敗：', error ?? folderError)
  if (filePath) await clientA.storage.from('images').remove([filePath, ...otherPaths])
}

console.log(failures === 0 ? '\n全部通過' : `\n${failures} 項失敗`)
process.exit(failures === 0 ? 0 : 1)
