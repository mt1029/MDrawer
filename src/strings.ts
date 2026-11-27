// MDrawer 畫面上的所有文字（按鈕、提示、對話框、狀態、錯誤訊息、給螢幕閱讀器的說明）。改文案只要改這個檔案。
//
// 怎麼改：
// - 字串是固定的文字，直接改。
// - 函式是要帶入數字或名稱的文字：參數名稱就是會帶入的東西（例如 count、name），改的時候保留 ${…} 的部分。
// - 依畫面分組，大致照使用者看到的順序；錯誤訊息放在最後的 errors。
//
// 不在這裡的文字：
// - index.html 的 <title> 與 description、vite.config.ts 的 PWA 名稱與說明（App 執行前就要用到，沒辦法引用這個檔案）
// - 快捷鍵的符號（⌘X、Ctrl+X、⌥ Option 等，依作業系統產生，在 Workspace.tsx）
// - 撞名時自動加的「 (2)」（名稱規則的一部分，跟同步、ZIP 匯出共用，在 lib/nodes.ts）
//
// 注意：
// - 衝突副本的名稱（errors.names.conflictCopySuffix）會存進資料，改了只影響之後新建立的副本。
// - 離線、同步的說明在 docs/offline.md 也有寫，改了的話文件一起改。
// - 這個檔案也會被 scripts/sync-check.mjs 用 Node 直接執行，只能用一般的 TypeScript（不要用 enum 等）。

/** 名稱加上「」 */
const quoted = (name: string) => `「${name}」`

export const strings = {
  /** 很多地方共用的文字 */
  common: {
    appName: 'MDrawer',
    loading: 'Just a moment...',
    processing: 'Please wait...',
    cancel: '取消',
    retry: '重試',
    gotIt: 'OK',
    quoted,
    /** 對話框裡的操作失敗、不是預期中的錯誤 */
    unexpectedTryAgain: '發生未預期的錯誤，請稍後再試。',
    /** 檔案總管的操作失敗、不是預期中的錯誤 */
    unexpectedReload: '發生未預期的錯誤，請重新整理頁面。',
  },

  /** 登入、註冊（AuthForm） */
  auth: {
    tagline: '一個簡單的 Markdown 筆記服務',
    signIn: '登入',
    signUp: '註冊',
    email: '信箱',
    password: '密碼',
    passwordHint: (minLength: number) => `至少 ${minLength} 個字元`,
    createAccount: '建立帳號',
    haveAccount: '已經有帳號？',
    noAccount: '還沒有帳號？',
    switchToSignIn: '你可以在這裡登入',
    switchToSignUp: '你可以在這裡註冊',
    verificationSent: (email: string) => `已寄出驗證信到 ${email}，請前往收件匣確認。`,
    supabaseUnreachable: '無法連線到資料庫，請確認網路連線。',
    weakPassword: (minLength: number) => `密碼強度不足，至少需要 ${minLength} 個字元。`,
    /** Supabase 回傳的錯誤代碼對應的訊息；沒有列出的直接顯示 Supabase 的英文訊息 */
    errors: {
      invalid_credentials: '信箱或密碼錯誤。',
      email_not_confirmed: '此信箱尚未完成驗證，請前往收件匣確認。',
      user_already_exists: '此信箱已被註冊，請改為登入。',
      email_exists: '此信箱已被註冊，請改為登入。',
      email_address_invalid: '信箱格式不正確。',
      email_address_not_authorized:
        'email_address_not_authorized',
      over_email_send_rate_limit: 'over_email_send_rate_limit',
      over_request_rate_limit: '嘗試次數過多，請稍後再試。',
      signup_disabled: '目前無法註冊。',
    } as Record<string, string>,
  },

  /** 登入前後的整體畫面、上方的提示列、登出（App） */
  app: {
    /** 不能連到雲端時上方的提示：連線中但登入狀態還在確認 */
    checkingSession: '目前無法連線，仍在確認登入狀態，修改將暫時存放在這台裝置，恢復連線後會自動同步。',
    /** 不能連到雲端時上方的提示：離線 */
    offline: '目前無法連線，修改將暫時存放在這台裝置，恢復連線後會自動同步。你將無法插入 / 查看圖片。',
    /** 登入畫面：離線時 */
    signInOffline: '目前無法連線，請稍後再試。',
    /** 登入畫面：被強制登出、還有沒同步的修改 */
    sessionExpired: (email: string, count: number) =>
      `登入已失效，請重新登入。使用 ${email} 登入將同步 ${count} 項修改。`,
    /** 用別的帳號登入，但這台裝置還有前一個帳號沒同步的修改 */
    otherAccount: {
      title: '這台裝置有其他帳號的暫存資料',
      body: (email: string, count: number) =>
        `${email} 在這台裝置上有 ${count} 項修改尚未同步。使用目前的帳號繼續可能會刪除這些修改。你確定要繼續嗎？`,
      useOther: (email: string) => `改用 ${email} 登入`,
      discard: '我知道我在做什麼！',
    },
    /** 第一次在這台裝置登入、還沒下載筆記 */
    firstSync: {
      offline: '請稍後連線以進行同步。',
      failed: (message: string) => `同步失敗：${message}`,
      downloading: '正在載入筆記..',
    },
    /** 登出時還有沒同步的修改 */
    signOutUnsynced: {
      title: '目前的修改尚未同步',
      confirm: '我知道我在做什麼！',
      body: (count: number) => `有 ${count} 項修改尚未同步。現在登出可能會修改遺失。你確定要繼續嗎？`,
      offlineHint: '目前無法連線，建議等待恢復連線並同步完成後再登出。',
    },
  },

  /** 右上角的選單（AccountMenu） */
  menu: {
    label: '選單',
    signedInAs: '已登入',
    exportZip: '匯出資料',
    exportZipOffline: '匯出資料（目前無法連線）',
    signOut: '登出',
    signingOut: '正在登出...',
  },

  /** 檔案總管（側欄、樹、右鍵選單）與右側的標題區（Workspace、FileTree） */
  workspace: {
    types: { folder: '資料夾', note: '筆記', image: '圖片' },
    /** 新增到哪裡、右鍵選單標題用的「最上層」 */
    topLevel: '最上層',
    activityBar: '面板',
    explorer: 'EXPLORER',
    tree: '資料夾樹',
    newNoteIn: (place: string) => `新增筆記到${place}`,
    newFolderIn: (place: string) => `新增資料夾到${place}`,
    refresh: '重新整理',
    collapseAll: '全部收合',
    expandAll: '全部展開',
    treeEmpty: '空空如也。',
    folderEmpty: '(empty)',
    expand: (name: string) => `展開${quoted(name)}`,
    collapse: (name: string) => `收合${quoted(name)}`,
    /** 游標停在樹的項目上時顯示 */
    lastModified: (time: string) => `最後修改：${time}`,
    /** 右鍵選單 */
    contextMenu: {
      label: (name: string) => `${quoted(name)}的操作`,
      topLevelLabel: '最上層的操作',
      /** 在多選的項目上按右鍵 */
      selectionLabel: (count: number) => `已選取 ${count} 個項目`,
      deleteMany: (count: number) => `刪除 ${count} 個項目`,
      newNote: '新增筆記',
      newFolder: '新增資料夾',
      /** 資料夾的右鍵選單：選擇圖片檔上傳到這個資料夾（可以一次選多張） */
      uploadImages: '上傳圖片',
      uploadImagesOffline: '上傳圖片（離線時無法上傳）',
      /** 從裝置匯入 .md、圖片、ZIP，或整個資料夾到這裡 */
      importFiles: '匯入檔案',
      importFolder: '匯入資料夾',
      cut: '剪下',
      copy: '複製',
      paste: '貼上',
      rename: '重新命名',
      delete: '刪除',
    },
    /** 側欄下方的同步狀態 */
    sync: {
      pending: (count: number) => `${count} 項修改等待同步`,
      pendingSyncing: (count: number) => `${count} 項修改等待同步，正在同步...`,
      syncing: '同步中…',
      synced: (time: string) => `已同步：${time}`,
      failed: (message: string) => `無法同步：${message}`,
      cannotSync: (count: number, message: string) => `${count} 項修改無法同步：${message}`,
      conflicts: (count: number, copyNames: string[]) =>
        `${count} 篇筆記發生衝突。雲端版本將保留在原筆記，修改的版本將另存為${copyNames.map(quoted).join('')}，請自行處理。`,
    },
    /** 右側的標題區 */
    back: '返回 Explorer',
    /** 路徑前面給螢幕閱讀器念的字（畫面上看不到） */
    location: '位置：',
    /** 選了資料夾時右側的說明 */
    folderItems: (count: number) => `有 ${count} 個項目。`,
    folderHelp: '使用側欄上方的圖示或點按右鍵可以在這個資料夾裡新增筆記或資料夾，也可以把剪下、複製的項目貼上在這裡。',
    /** 沒有選任何項目時右側的說明 */
    noSelection: '請從 Explorer 選擇項目。',
    /** 新增、改名、刪除的對話框；type 是「資料夾」或「筆記」 */
    dialogs: {
      nameLabel: '名稱',
      createTitle: (type: string) => `新增${type}`,
      createHint: (place: string) => `會建立在${place}`,
      create: '建立',
      renameTitle: (type: string) => `重新命名${type}`,
      save: '儲存',
      deleteTitle: (type: string) => `刪除${type}`,
      delete: '刪除',
      deleteFolder: (name: string) => `${quoted(name)}和裡面所有的資料夾、筆記都會被刪除。`,
      deleteNote: (name: string) => `${quoted(name)}會被刪除。`,
      deleteImage: (name: string) => `${quoted(name)}將被刪除。`,
      deleteManyTitle: (count: number) => `刪除 ${count} 個項目`,
      deleteMany: (count: number) => `已選取的 ${count} 個項目將被刪除。`,
      /** 接在刪除的說明後面 */
      toTrash: '刪除的項目會移到垃圾桶，連線時可以從垃圾桶還原。',
    },
  },

  /** 搜尋面板（SearchPanel） */
  search: {
    title: 'SEARCH',
    /** 縮短時接在後面的符號：很長的行只顯示符合處附近、太長的資料夾路徑只留第一個字（例如 /o.../t.../） */
    ellipsis: '...',
    /** 左側圖示欄的搜尋圖示，游標停留時顯示；shortcut 是 ⇧⌘F 或 Ctrl+Shift+F */
    buttonHint: (shortcut: string) => `搜尋（${shortcut}）`,
    inputLabel: '搜尋筆記',
    placeholder: '搜尋筆記的名稱與內容',
    /** 還沒輸入時的說明 */
    hint: '搜尋這台裝置上所有筆記的名稱與內容。',
    summary: (notes: number, matches: number) => `${notes} 篇筆記，共 ${matches} 處`,
    /** 結果太多、只列出一部分時 */
    truncated: (shown: number) => `只列出前 ${shown} 篇，輸入更多字可以縮小範圍。`,
    noResults: (query: string) => `找不到${quoted(query)}。`,
    /** 一篇筆記沒有列出的行裡還有幾處 */
    more: (count: number) => `還有 ${count} 處`,
    /** 結果的說明（給螢幕閱讀器）；count 是內容裡符合的處數 */
    noteLabel: (name: string, path: string, count: number) => `${name}，在 ${path}，內容 ${count} 處`,
    lineLabel: (line: number, text: string) => `第 ${line} 行：${text}`,
    failed: '無法讀取這台裝置上的筆記，請重新整理頁面。',
  },

  /** 垃圾桶面板（TrashPanel、trash.ts）。只在連線時能用 */
  trash: {
    title: 'TRASH',
    list: '垃圾桶裡的項目',
    refresh: '重新整理',
    empty: '清空垃圾桶',
    loading: '正在讀取垃圾桶...',
    offline: '離線時無法使用垃圾桶，請連線後再試。',
    nothing: '垃圾桶是空的。',
    hint: '在項目上按右鍵（觸控裝置長按）可以還原或永久刪除。',
    /** 每一筆的第二行：原本的位置、刪除的時間；資料夾加上裡面一起刪除的項目數 */
    meta: (path: string, time: string, items: number) => [path, time, items > 0 ? `含 ${items} 個項目` : ''].filter(Boolean).join('・'),
    /** 給螢幕閱讀器 */
    itemLabel: (name: string, path: string, time: string) => `${name}，原本在 ${path}，${time} 刪除`,
    menuLabel: (name: string) => `${quoted(name)}的操作`,
    /** 在多選的項目上按右鍵 */
    selectionLabel: (count: number) => `已選取 ${count} 筆`,
    restore: '還原',
    restoreMany: (count: number) => `還原 ${count} 筆`,
    purge: '永久刪除',
    purgeMany: (count: number) => `永久刪除 ${count} 筆`,
    restoring: '正在還原...',
    restored: (name: string, path: string) => `已還原${quoted(name)}到 ${path}。`,
    restoredToRoot: (name: string) => `原本的資料夾已不在，${quoted(name)}還原到最上層。`,
    /** 還原好幾筆；toRoot 是原本的資料夾已不在、放到最上層的筆數 */
    restoredMany: (count: number, toRoot: number) =>
      `已還原 ${count} 筆。${toRoot > 0 ? `其中 ${toRoot} 筆原本的資料夾已不在，放到最上層。` : ''}`,
    purgeTitle: '永久刪除？',
    purgeItem: (name: string) => `${quoted(name)}會被永久刪除，無法復原。`,
    purgeFolder: (name: string, count: number) => `${quoted(name)}和裡面的 ${count} 個項目會被永久刪除，無法復原。`,
    /** 多選的好幾筆；count 包含資料夾裡一起刪除的項目 */
    purgeManyBody: (count: number) => `選取的 ${count} 個項目（含資料夾裡的）會被永久刪除，無法復原。`,
    emptyTitle: '清空垃圾桶？',
    emptyBody: (count: number) => `垃圾桶裡的 ${count} 個項目都會被永久刪除，無法復原。`,
    purged: (count: number) => `已永久刪除 ${count} 個項目。`,
    /** 列出垃圾桶之後，那一列被別台裝置還原、永久刪除或改過 */
    changed: '垃圾桶的內容剛被其他裝置改過，請重新整理後再試。',
  },

  /** 上傳圖片到資料夾、選了圖片時右側的預覽（Workspace、ImageViewer） */
  images: {
    /** 上傳中（側欄上方）；done、total 是第幾張、共幾張 */
    uploading: (done: number, total: number) => `正在上傳圖片...（${done}/${total}）`,
    uploaded: (count: number) => `已上傳 ${count} 張圖片。`,
    /** 有些失敗時；name 是第一張失敗的檔名 */
    someFailed: (failed: number, name: string, message: string) => `${failed} 張圖片沒有上傳（${name}：${message}）`,
    /** 預覽 */
    previewLabel: '圖片預覽',
    loading: '正在載入圖片...',
    offline: '離線時無法顯示圖片。',
    missing: '找不到這張圖片的檔案。',
    /** 圖片的寬與高（像素） */
    dimensions: (width: number, height: number) => `${width} × ${height}`,
    /** 預覽下方的說明：怎麼在筆記裡用這張圖；name 是圖片的名稱 */
    usage: (name: string) => `你可以將這張圖片從 Explorer 拖進文字編輯器，或在同一目錄的筆記填入 ![](${name})。`,
  },

  /** 從裝置匯入檔案、資料夾、ZIP（Workspace、import.ts）。結果顯示在側欄上方 */
  imports: {
    reading: '正在讀取檔案...',
    /** done、total 是第幾個、共幾個（資料夾、筆記、圖片） */
    progress: (done: number, total: number) => `正在匯入...（${done}/${total}）`,
    /** 只列出有匯入的，例如「已匯入 1 篇筆記、2 張圖片。」 */
    done: (folders: number, notes: number, images: number) => {
      const parts = [
        folders > 0 && `${folders} 個資料夾`,
        notes > 0 && `${notes} 篇筆記`,
        images > 0 && `${images} 張圖片`,
      ].filter(Boolean)
      return parts.length > 0 ? `已匯入 ${parts.join('、')}。` : '沒有匯入任何項目。'
    },
    /** 接在 done 後面 */
    skipped: (count: number) => `略過 ${count} 個不支援的檔案。`,
    offlineImages: (count: number) => `無法於離線時匯入圖片，略過 ${count} 張。`,
    /** 有些失敗時；name 是第一個失敗的檔名 */
    someFailed: (failed: number, name: string, message: string) => `${failed} 個檔案沒有匯入（${name}：${message}）`,
    nothing: '沒有可以匯入的檔案。',
    /** 檔名換掉不符合規則的字之後變成空的時候用的名稱 */
    untitled: '未命名',
    parentFailed: '所在的資料夾沒有建立。',
    readFailed: '無法讀取檔案。',
    badZip: '無法讀取資料。',
    tooMany: (max: number) => `一次最多匯入 ${max} 個檔案。`,
  },

  /** 筆記編輯器（NoteEditor） */
  editor: {
    saveState: {
      saved: '已儲存',
      dirty: '尚未儲存',
      saving: '正在儲存...',
      error: '無法儲存',
    },
    notFound: '找不到這篇筆記，可能已經被刪除。',
    loadFailed: '無法載入筆記。',
    deletedElsewhere: '這篇筆記已在其他裝置被刪除。',
    saveUnexpected: '發生未預期的錯誤。',
    /** 編輯區給螢幕閱讀器的名稱、還沒有內容時的提示 */
    inputLabel: 'Markdown 內容',
    placeholder: '# 標題\n\n寫點東西吧...',
    previewLabel: '預覽',
    /** 右上角的圖示 */
    insertImage: '插入圖片',
    insertImageOffline: '目前無法插入圖片',
    preview: '預覽 Markdown',
    backToEdit: '回到編輯',
    /** 眼睛的右鍵選單 */
    view: {
      label: '顯示方式',
      editOnly: '只顯示編輯區',
      previewOnly: '只顯示預覽',
      splitColumns: '左右並排',
      splitRows: '上下並排',
    },
    /** 插入圖片 */
    image: {
      /** 上傳時暫時放在內容裡的文字（上傳完會換掉） */
      uploadingPlaceholder: '上傳中…',
      compressing: (originalSize: string) => `正在壓縮圖片...(${originalSize})`,
      uploading: (size: string) => `上傳中...(${size})`,
      inserted: `已插入圖片`,
      placeholderRemoved: '圖片已上傳，但因插入位置的資料已遺失而無法插入。',
      failed: '無法插入圖片，請再試一次。',
      offlinePaste: '目前無法連線故插入失敗，請稍後再試。',
      /** 貼上的截圖放進資料夾時的名稱（後面會接 .webp 或 .jpg）；time 是「年月日-時分秒」 */
      pastedName: (time: string) => `截圖-${time}`,
      /** 拖進編輯區的檔案不是圖片 */
      notImage: '只能把圖片拖曳至編輯區。',
      /** 拖進來的檔案有圖片也有其他檔案：圖片插入完成後顯示 */
      skippedFiles: (count: number) => `已插入圖片，有 ${count} 個檔案不是圖片而未插入。`,
    },
  },

  /** Markdown 預覽 */
  markdown: {
    /** 離線時還沒載入過的圖片，在預覽裡顯示的文字 */
    offlineImage: '離線時無法載入圖片',
  },

  /** 匯出 ZIP（ExportDialog） */
  export: {
    title: '匯出資料？',
    intro: '匯出資料會把所有資料夾、筆記、圖片壓縮後下載到你的裝置。',
    readingNotes: '讀取資料夾與筆記...',
    noImages: '沒有圖片需要下載...',
    downloadingImages: (done: number, total: number) => `下載圖片 ${done} / ${total}...`,
    zipping: '正在壓縮...',
    /** 下載的檔名；date 是「年-月-日」 */
    fileName: (date: string) => `MDrawer-${date}.zip`,
    done: (fileName: string, size: string, folders: number, notes: number, images: number) =>
      `已下載 ${fileName}（${size}）：${folders} 個資料夾、${notes} 篇筆記、${images} 張圖片。`,
    missingImages: (count: number) => `有 ${count} 張圖片遺失。`,
    failed: '無法匯出，請稍後再試。',
    start: '開始匯出',
    running: '匯出中...',
    downloadAgain: '再次下載',
    finish: '完成',
  },

  /** 錯誤訊息（大多由資料層丟出，畫面直接顯示） */
  errors: {
    network: '無法連線到伺服器，請確認網路後再試。',
    /** Supabase 回傳無法辨識的錯誤 */
    unknown: (message: string) => `發生錯誤：${message}`,
    sessionExpired: '登入狀態已失效，請重新登入。',
    /** 名稱規則（新增、改名時檢查） */
    names: {
      empty: '名稱不能是空的。',
      tooLong: (max: number) => `名稱最多 ${max} 個字。`,
      slash: '名稱不能包含特殊字元。',
      dots: '名稱不能包含特殊字元。',
      /** 資料庫的檢查擋下來時（前端的檢查通常會先擋下） */
      invalid: (max: number) => `名稱不符格式：1 ~ ${max} 字，不能包含特殊字元。`,
      /** 衝突副本的名稱：「原名稱」後面接這段；time 是「年-月-日 時:分」 */
      conflictCopySuffix: (time: string) => ` ${time}`,
    },
    /** 新增、移動、複製、刪除 */
    nodes: {
      duplicateName: '不允許重複名稱的項目。',
      duplicateNameInTarget: '不允許重複名稱的項目。',
      notFound: '項目已遺失。請重新整理後再試。',
      parentNotFound: '上層資料夾已遺失。請重新整理後再試。',
      targetNotFound: '目標資料夾已遺失。',
      onlyInFolder: '只能放在資料夾內。',
      moveOnlyToFolder: '只能移到資料夾內。',
      moveIntoSelf: '不允許移動到自己底下（包含）的資料夾。',
      pasteIntoSelf: '不允許貼上到自己底下（包含）的資料夾。',
      cycle: '資料夾結構出現循環，請重新整理後再試。',
      /** 編輯時這篇剛好被同步改過；copyName 是衝突副本的名稱 */
      editConflict: (copyName: string) =>
        `此次修改與其它發生衝突，故另存為${quoted(copyName)}。`,
    },
    /** 圖片：插入時的壓縮 */
    imageProcessing: {
      notImage: '只能插入圖片檔。',
      unreadable: '無法讀取圖片，瀏覽器可能不支援。',
      noCanvas: '無法處理圖片。',
      convertFailed: '圖片轉檔失敗。',
      tooLarge: '圖片太大。',
    },
    /** 圖片：上傳、取得網址、下載 */
    images: {
      offlineUpload: '離線時無法上傳圖片。',
      offlineLoad: '離線時無法載入圖片。',
      offlineDownload: '離線時無法下載圖片。',
      uploadNetwork: '無法連線到伺服器，故沒有上傳圖片。',
      tooLarge: '圖片超過 2 MB 上限。',
      badFormat: '僅支援 WebP、JPEG 格式的圖片。',
      noBucket: 'images bucket 不存在。',
      noPermission: '無法上傳圖片，請確認你符合權限。',
      uploadFailed: (message: string) => `無法上傳圖片：${message}`,
      urlFailed: '無法取得圖片網址，請確認網路後重新整理。',
      notFound: '圖片已遺失。',
      downloadNetwork: '無法連線到伺服器，故沒有下載圖片。',
      /** 建立圖片項目時圖片檔的 id 不對（程式錯誤，不應該發生） */
      invalidFile: '圖片檔的資料不正確，請重新上傳。',
    },
    /** 匯出 ZIP */
    exportOffline: '離線時無法匯出，請確認網路連線。',
    /** 同步（側欄下方的「同步失敗：…」後面接這些） */
    sync: {
      unexpected: '同步時發生未預期的錯誤。',
      createdMissing: '同步失敗：新增的項目不存在。',
      keepsChanging: '同步失敗：變動過於頻繁，請稍後會再試。',
      offline: '無法連線至伺服器，修改會在恢復連線後同步。',
      noLocalCopy: '這台裝置還沒有你的筆記，連線後會自動下載。',
      storageUnavailable: '無法使用本機儲存，請檢查網頁權限或裝置可用的儲存空間。',
    },
    /** 部署設定錯誤（開發者才會看到） */
    missingEnv:
      '缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_PUBLISHABLE_KEY。' +
      '本機請照 .env.example 建立 .env.local，Vercel 請到 Settings > Environment Variables 設定後重新部署。',
  },
}
