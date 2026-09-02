# 校園尋寶

NTUST 校園尋寶活動的前後端。掃 QR-Code 登入、掃 QR-Code 開題目、答題計分。

## 跑起來

```bash
uv sync
uv run main.py
```

啟動時會做三件事，任何一件失敗就不啟動（不會帶著壞掉的題目上場）：

1. 驗證 `.env`（token 不可重複）
2. 驗證 `questions.yaml`（id 格式與唯一性、answer 必須在 choices 裡、選項 2-10 個、points 為正數、欄位名稱沒打錯）
3. 把 `image` 的遠端圖片下載到 `static/cache/`，之後前端一律吃本地檔

nginx 反向代理到 `HOST:PORT`（預設 `192.168.10.101:20001`）。TLS 由你處理。

> **相機只能在 HTTPS 或 localhost 下使用。** 直接用 `http://192.168.10.101:20001` 從手機連會拿不到相機，
> 一定要走你的 `https://treasure.ntust.org`。

## 測試

```bash
uv run test_main.py
```

不吃測試框架，只用 assert。涵蓋題庫驗證、同隊併發只算一筆、圖片快取的副檔名
白名單、端點權限、`/reset` 備份。不會碰到正式的 `data.json`。

## 產生 QR-Code

```bash
uv run make_qr.py          # 一個 QR 一張 PNG
uv run make_qr.py --pdf    # A4 多頁 PDF，每頁 2x4 共 8 個，含裁切線
```

輸出到 `qr/`：

- `login_1.png` … `login_6.png` — 登入用，編碼完整網址，手機內建相機掃也能登入
- `ABCDE.png` … — 題目用，編碼五碼代碼，由網站內建掃描器讀取
- `qrcodes.pdf` — `--pdf` 模式的輸出，QR 是向量圖，放大列印不會有鋸齒

一律用 `segno.make_qr()`，**不能用 `segno.make()`** —— 後者遇到五碼這種短資料會挑
Micro QR（`M2-M`，只有一個定位點），而 jsQR 不支援 Micro QR，貼出去會完全掃不動。

PDF 上的標籤刻意只用 ASCII（`TEAM 1`、`ABCDE`），這樣不必嵌中文字型。哪張貼紙對應
哪一題，看終端機印出來的對照表。

## 設定

`.env`：

| 欄位 | 說明 |
|---|---|
| `TEAM_KEY` | 各隊 token，`;` 分隔，**順序就是隊號** |
| `RANDOM_CHOICES` | 每次拉題目是否打亂選項順序 |
| `SHOW_SCORES_IN_MENU` | 最上方是否顯示各隊分數 |
| `RESET_TOKEN` | 清空全場的權杖。**留空則 `/reset` 端點完全停用** |
| `HOST` / `PORT` | 監聽位址 |
| `SITE_URL` | `make_qr.py` 產生登入 QR 時用的網址 |

`questions.yaml`：見檔案開頭的欄位說明。

## 清空全場

```bash
curl -X POST https://treasure.ntust.org/reset -H "X-Reset-Token: $RESET_TOKEN"
```

清掉所有隊伍的分數與作答紀錄。**清掉之前會先把 `data.json` 改名成
`data.<時間戳>.json` 留底**，所以誤觸還救得回來（把備份改名回 `data.json` 再重啟）。

- 只收 `POST`，`GET` 回 405 —— 避免被瀏覽器預抓、聊天軟體的連結預覽或爬蟲誤觸
- `RESET_TOKEN` 沒設就回 404，端點根本不存在
- `RESET_TOKEN` 若和某隊的 token 相同，啟動時就會擋下來

## 活動當中

- **改題目**：編輯 `questions.yaml` 後重啟。登入狀態存在瀏覽器的 localStorage，重啟不會把任何人登出。
- **分數**：即時從 `data.json` 的作答紀錄算出來，不存快取，所以改 `points` 會立刻反映在所有隊伍身上。
- **備份**：`data.json` 每次作答都整份重寫 + fsync + 原子換檔，直接複製走就是完整快照。

## 架構

- 單 process（waitress，8 執行緒）。**不要開多 worker** — 記憶體狀態會分裂，分數會互相覆蓋。
- 作答的檢查與寫入都在同一把 `threading.Lock` 內，所以同隊多人同時送出時只有第一筆算數。
- 前端是單頁，相機串流在登入後開一次就一直活著，切換題目不會重啟鏡頭。
- QR 解碼用 vendored 的 `static/jsQR.js`（不吃 CDN），所有裝置走同一條路徑。
  已 minify（58KB → 46KB gzip）。要換版本或改動時，取回原始碼後重跑：
  `bun build static/jsQR.js --no-bundle --minify --outfile=tmp.js && mv tmp.js static/jsQR.js`
  （`--no-bundle` 是必要的，否則 bundler 會吃掉 UMD 包裝、`window.jsQR` 就不見了。）

## 出場前手測清單

在真手機、真 HTTPS 網址上跑一遍：

- [ ] iPhone Safari：掃登入 QR → 進得去
- [ ] Android Chrome：掃登入 QR → 進得去
- [ ] 用手機內建相機掃登入 QR（會開瀏覽器帶 `?token=`）→ 進得去，且網址列的 token 有被清掉
- [ ] 按「切換鏡頭」循環，找到能對焦近物的那顆；重新整理後仍是同一顆
- [ ] 掃題目 QR → 出題 → 答對加分 → 上方分數列更新
- [ ] 答錯 → 顯示正解、得 0 分
- [ ] 重掃同一題 → 顯示「隊友已經答過了」，分數不變
- [ ] 兩台手機同一隊同時送出不同答案 → 只有一筆算數
- [ ] 拒絕相機權限 → 手動輸入五碼仍可作答
- [ ] 中午在戶外看一次螢幕，確認讀得到
