// 用 A、B 兩個測試帳號，對真正的 Supabase 專案檢查 nodes 表的 RLS、觸發器與限制。
// 執行：npm run test:rls（需要 .env.local 與 .env.test.local，見 docs/database.md）
// 測試資料都放在一個「RLS 測試 <時間>」資料夾裡，結束時會刪除。

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const env = process.env
const required = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'TEST_A_EMAIL',
  'TEST_A_PASSWORD',
  'TEST_B_EMAIL',
  'TEST_B_PASSWORD',
]
const missing = required.filter((name) => !env[name])
if (missing.length > 0) {
  console.error(`缺少環境變數：${missing.join('、')}`)
  console.error('請照 docs/database.md 建立 .env.test.local，再執行 npm run test:rls')
  process.exit(1)
}

const newClient = () =>
  createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

async function signIn(label, email, password) {
  const client = newClient()
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) {
    console.error(`${label} 帳號登入失敗：${error.message}`)
    process.exit(1)
  }
  return { client, uid: data.user.id }
}

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  → ${detail}` : ''}`)
}

const a = await signIn('A', env.TEST_A_EMAIL, env.TEST_A_PASSWORD)
const b = await signIn('B', env.TEST_B_EMAIL, env.TEST_B_PASSWORD)
const anon = newClient()

if (a.uid === b.uid) {
  console.error('A 和 B 是同一個帳號，請在 .env.test.local 填兩個不同的帳號')
  process.exit(1)
}

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
const createdByA = []
const createdByB = []

/** 以指定使用者新增一筆，回傳 { data, error } */
async function insert(user, row, bucket) {
  const result = await user.client.from('nodes').insert(row).select().maybeSingle()
  if (!result.error && result.data) bucket.push(result.data.id)
  return result
}

try {
  console.log('── 觸發器與欄位限制（A 帳號）')

  const folderId = randomUUID()
  const folder = await insert(
    a,
    { id: folderId, type: 'folder', name: `RLS 測試 ${stamp}` },
    createdByA,
  )
  check('A 建立資料夾，user_id 自動填入 A', folder.data?.user_id === a.uid, folder.error?.message)

  const noteId = randomUUID()
  const note = await insert(
    a,
    {
      id: noteId,
      parent_id: folderId,
      type: 'note',
      name: 'Note',
      content: 'v1',
      // 故意由前端傳值，應該被觸發器覆蓋
      version: 99,
      created_at: '2000-01-01T00:00:00Z',
    },
    createdByA,
  )
  check(
    '新增時前端傳的 version、created_at 被資料庫覆蓋',
    note.data?.version === 1 && new Date(note.data.created_at).getFullYear() > 2000,
    note.error?.message ?? `version=${note.data?.version}, created_at=${note.data?.created_at}`,
  )

  const updated = await a.client
    .from('nodes')
    .update({ content: 'v2', version: 50, created_at: '2000-01-01T00:00:00Z' })
    .eq('id', noteId)
    .select()
    .single()
  check(
    '更新時 version 加 1、created_at 不變、updated_at 變新',
    updated.data?.version === 2 &&
      updated.data.created_at === note.data?.created_at &&
      updated.data.updated_at > note.data?.updated_at,
    updated.error?.message ?? `version=${updated.data?.version}`,
  )

  const dup = await insert(a, { id: randomUUID(), parent_id: folderId, type: 'note', name: 'NOTE' }, createdByA)
  check('同一層同名（只差大小寫）被擋', dup.error?.code === '23505', dup.error?.code ?? '竟然成功了')

  const sub = await insert(a, { id: randomUUID(), parent_id: folderId, type: 'folder', name: 'Sub' }, createdByA)
  const sameNameOtherLevel = await insert(
    a,
    { id: randomUUID(), parent_id: sub.data?.id, type: 'note', name: 'Note' },
    createdByA,
  )
  check('不同層可以同名', !sameNameOtherLevel.error, sameNameOtherLevel.error?.message)

  for (const bad of ['../x', 'a/b', 'a\\b', '']) {
    const r = await insert(a, { id: randomUUID(), parent_id: folderId, type: 'note', name: bad }, createdByA)
    check(`名稱「${bad}」被擋`, r.error?.code === '23514', r.error?.code ?? '竟然成功了')
  }

  // 資料夾裡的圖片（20261126000000_images_in_folders.sql）：content 必須是圖片檔的 uuid
  const image = await insert(
    a,
    { id: randomUUID(), parent_id: folderId, type: 'image', name: '圖.webp', content: randomUUID() },
    createdByA,
  )
  check('圖片項目（content 是 uuid）可以建立', !image.error, image.error?.message)
  for (const [label, content] of [['圖片沒有 content 被擋', null], ['圖片的 content 不是 uuid 被擋', 'not-a-uuid']]) {
    const r = await insert(a, { id: randomUUID(), parent_id: folderId, type: 'image', name: `${content ?? 'empty'}.webp`, content }, createdByA)
    check(label, r.error?.code === '23514', r.error?.code ?? '竟然成功了')
  }
  const video = await insert(a, { id: randomUUID(), parent_id: folderId, type: 'video', name: 'v' }, createdByA)
  check('不認得的 type 被擋', video.error?.code === '23514', video.error?.code ?? '竟然成功了')

  const selfId = randomUUID()
  const self = await insert(a, { id: selfId, parent_id: selfId, type: 'folder', name: 'Self' }, createdByA)
  check('上層資料夾指向自己被擋', self.error?.code === '23514', self.error?.code ?? '竟然成功了')

  await a.client.from('nodes').update({ deleted_at: new Date().toISOString() }).eq('id', noteId)
  const reuse = await insert(a, { id: randomUUID(), parent_id: folderId, type: 'note', name: 'note' }, createdByA)
  check('標記刪除後可以再建同名項目', !reuse.error, reuse.error?.message)

  console.log('── 帳號隔離（B 帳號嘗試存取 A 的資料）')

  const bRead = await b.client.from('nodes').select('id').in('id', [folderId, noteId])
  check('B 用 id 查 A 的資料 → 0 筆', !bRead.error && bRead.data.length === 0, bRead.error?.message)

  const bAll = await b.client.from('nodes').select('id').eq('user_id', a.uid)
  check('B 查詢所有 A 的資料 → 0 筆', !bAll.error && bAll.data.length === 0, bAll.error?.message)

  const bUpdate = await b.client.from('nodes').update({ content: 'hacked' }).eq('id', noteId).select('id')
  check('B 修改 A 的筆記 → 0 筆受影響', !bUpdate.error && bUpdate.data.length === 0, bUpdate.error?.message)

  const bDelete = await b.client.from('nodes').delete().eq('id', noteId).select('id')
  check('B 刪除 A 的筆記 → 0 筆受影響', !bDelete.error && bDelete.data.length === 0, bDelete.error?.message)

  const still = await a.client.from('nodes').select('content').eq('id', noteId).single()
  check('A 的筆記仍在且內容沒被改', still.data?.content === 'v2', still.error?.message)

  const forged = await insert(b, { id: randomUUID(), user_id: a.uid, type: 'note', name: `RLS 冒用 ${stamp}` }, createdByB)
  check('B 冒用 A 的 user_id 新增 → 被 RLS 擋下', forged.error?.code === '42501', forged.error?.code ?? '竟然成功了')

  const attach = await insert(
    b,
    { id: randomUUID(), parent_id: folderId, type: 'note', name: `RLS 掛載 ${stamp}` },
    createdByB,
  )
  check('B 把筆記放進 A 的資料夾 → 被外鍵擋下', attach.error?.code === '23503', attach.error?.code ?? '竟然成功了')

  const bNote = await insert(b, { id: randomUUID(), type: 'note', name: `RLS 測試 ${stamp}` }, createdByB)
  check('B 建立自己的筆記', !bNote.error, bNote.error?.message)

  const steal = await b.client.from('nodes').update({ user_id: a.uid }).eq('id', bNote.data?.id)
  check('B 把自己的筆記改到 A 名下 → 被 RLS 擋下', steal.error?.code === '42501', steal.error?.code ?? '竟然成功了')

  const aReadB = await a.client.from('nodes').select('id').eq('id', bNote.data?.id)
  check('A 查 B 的筆記 → 0 筆', !aReadB.error && aReadB.data.length === 0, aReadB.error?.message)

  const anonRead = await anon.from('nodes').select('id').limit(1)
  check(
    '未登入查詢 → 被拒絕或 0 筆',
    anonRead.error?.code === '42501' || (!anonRead.error && anonRead.data.length === 0),
    anonRead.error?.code ?? `${anonRead.data?.length} 筆`,
  )
} finally {
  // 一次刪除，讓上下層的外鍵在同一個指令內檢查
  if (createdByA.length) await a.client.from('nodes').delete().in('id', createdByA)
  if (createdByB.length) await b.client.from('nodes').delete().in('id', createdByB)
  const left = await a.client.from('nodes').select('id').in('id', createdByA)
  console.log(left.data?.length ? `\n⚠️ 有 ${left.data.length} 筆測試資料沒刪掉，請到 Table Editor 手動刪除` : '\n已清除測試資料')
}

console.log(failures ? `${failures} 項失敗` : '全部通過')
process.exit(failures ? 1 : 0)
