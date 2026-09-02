# 校園尋寶

NTUST 校園尋寶活動的前後端。每隊一位隊輔帶隊，隊員投票、隊輔送出。

```
隊輔掃題目 QR ─▶ 全隊手機同時出現題目
                  隊員各自點選項（可以改，最後一次算數）
                  隊輔看得到各選項票數與已投人數，隊員看不到
隊輔按送出   ─▶ 送出最高票，公開票數與正解
隊輔按下一題 ─▶ 全隊回到等待
```

隊輔隨時可以「取消這一題」，票全部丟掉、不留紀錄。平手時送出鈕會鎖住，
要隊輔點一個要送的；沒有人投票時也送不出去。一隊一題仍然只能送一次。

## 跑起來

```bash
uv sync
uv run main.py
```

啟動時會做三件事，任何一件失敗就不啟動（不會帶著壞掉的題目上場）：

1. 驗證 `.env`（隊輔與隊員各 6 把、12 把互不相同）
2. 驗證 `questions.yaml`（id 格式與唯一性、answer 必須在 choices 裡、選項 2-10 個、points 為正數、欄位名稱沒打錯）
3. 把 `image` 的遠端圖片下載到 `static/cache/`，之後前端一律吃本地檔

nginx 反向代理到 `HOST:PORT`（預設 `192.168.10.101:20001`）。TLS 由你處理。

> **相機只能在 HTTPS 或 localhost 下使用。** 直接用 `http://192.168.10.101:20001` 從手機連會拿不到相機，
> 一定要走你的 `https://treasure.ntust.org`。

## 測試

```bash
uv run test_main.py    # 後端
node test_web.cjs      # 前端（會自己起一台伺服器）
```

都不吃測試框架，只用 assert，也都不會碰到 `.env` 或正式的 `data.json`。

- `test_main.py` — 題庫驗證、角色與權限、投票與改票、平手與零票、取消、
  重掃已答過的題、兩台隊輔同時送出、在線人數逾時、`/reset` 備份
- `test_web.cjs` — 真正的 `static/app.js` 跑在 Node 的最小 DOM stub 裡，
  打一台真的起起來的伺服器。每支模擬手機是獨立的 vm context，所以
  「隊輔 + 三台隊員」是四個真的 client 在互動

## 產生 QR-Code

```bash
uv run make_qr.py          # 一個 QR 一張 PNG
uv run make_qr.py --pdf    # A4 多頁 PDF，每頁 2x4 共 8 個，含裁切線
```

輸出到 `qr/`：

- `leader_1.png` … `leader_6.png` — **隊輔**登入用，紙上標籤是 `LEADER n`
- `member_1.png` … `member_6.png` — **隊員**登入用，紙上標籤是 `TEAM n`
- `ABCDE.png` … — 題目用，編碼五碼代碼，只有隊輔掃得動

> **隊輔那疊不要跟隊員的混在一起。** 拿到隊輔 QR 的人可以代替全隊送出答案。
> 隊輔 token 不限台數，所以隊輔手機沒電時，副隊輔掃同一張就能接手。
- `qrcodes.pdf` — `--pdf` 模式的輸出，QR 是向量圖，放大列印不會有鋸齒

一律用 `segno.make_qr()`，**不能用 `segno.make()`** —— 後者遇到五碼這種短資料會挑
Micro QR（`M2-M`，只有一個定位點），而 jsQR 不支援 Micro QR，貼出去會完全掃不動。

PDF 上的標籤刻意只用 ASCII（`TEAM 1`、`ABCDE`），這樣不必嵌中文字型。哪張貼紙對應
哪一題，看終端機印出來的對照表。

## 設定

`.env`：

| 欄位 | 說明 |
|---|---|
| `MEMBER_KEY` | 各隊**隊員** token，`;` 分隔，**順序就是隊號**（舊的 `TEAM_KEY`） |
| `LEADER_KEY` | 各隊**隊輔** token，順序同上，數量必須一樣 |
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
- **重啟會打斷進行中的投票**：還沒送出的票只存在記憶體，重啟後全隊回到「等待題目中」，
  隊輔重掃一次就繼續。已送出的答案與分數完整保留。所以要改題目的話，挑沒有隊伍正在投票的空檔。
- **分數**：即時從 `data.json` 的作答紀錄算出來，不存快取，所以改 `points` 會立刻反映在所有隊伍身上。
- **備份**：`data.json` 每次作答都整份重寫 + fsync + 原子換檔，直接複製走就是完整快照。

## 架構

- 單 process（waitress，8 執行緒）。**不要開多 worker** — 記憶體狀態會分裂，分數會互相覆蓋。
  沒有跑過 `main.py` 的 `__main__` 就啟動（例如 `gunicorn main:app`）時，每個請求都回 503，
  不會安靜地拿空的狀態把 `data.json` 蓋掉。
- 前端每 **1 秒**輪詢 `/api/state`，畫面完全由伺服器決定。沒有用 SSE/WebSocket：
  每個長連線會佔住一條 waitress 執行緒，40 台裝置遠超過 8 條。
- 送出的檢查與寫入都在同一把 `threading.Lock` 內，所以兩台隊輔同時按送出只有第一筆算數。
- 選項順序在**開局時洗一次**就固定（`RANDOM_CHOICES`）。每次輪詢重洗的話，
  選項會在使用者手指下面每秒重排。
- 隊輔的相機只在等待題目時開著，開局就關掉把畫面讓給票數；隊員登入後相機永久關閉。
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
