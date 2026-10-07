# 線上撞球（雙人 8 號球）

## 啟動

```bash
npm install
npm start
```

打開 http://localhost:3000 → 輸入暱稱 →「建立房間」產生 6 碼邀請碼 → 把邀請碼或邀請連結傳給朋友加入。

- 同一個 Wi‑Fi：朋友用 `http://你的電腦IP:3000` 開啟（Windows 用 `ipconfig` 查 IPv4）。
- 不同網路：部署到 Render / Railway / Fly.io 等支援 WebSocket 的 Node 主機（會自動使用 `PORT` 環境變數），或用 `ngrok http 3000` 暫時對外開放。

## 部署到 Render（免費）

1. 把這個專案推到 GitHub。
2. 到 https://render.com 用 GitHub 登入 → **New → Blueprint** → 選這個 repo（會讀取 `render.yaml`）。
   也可以選 **New → Web Service**，Build Command 填 `npm install`、Start Command 填 `npm start`、方案選 Free。
3. 部署完成後把 Render 給的網址傳給朋友即可。

免費方案閒置約 15 分鐘會休眠，下次開啟需等 30～60 秒；休眠或重新部署會清空所有房間。

## 操作

- 視角：右鍵拖曳旋轉、滾輪縮放（手機兩指）；右上角切換「球桿視角／俯視／自由視角」。
- 俯視／自由視角：滑鼠指向瞄準，按住左鍵往後拉決定力道，放開擊球。
- 球桿視角：左鍵左右拖曳轉動瞄準，力道條或按住空白鍵蓄力，放開擊球；右鍵上下拖曳調整鏡頭高低。
- 加塞：左下角白球圖示選擇擊球點（上＝跟桿、下＝拉桿、左右＝左右塞），雙擊回中心。

## 檔案

- `server.js`：HTTP + WebSocket 伺服器、房間與邀請碼、8 號球規則判定；`/vendor/three/` 提供 Three.js。
- `public/physics.js`：球桌幾何與含旋轉的物理模擬（滑動／滾動摩擦、塞、吃庫），在伺服器端執行，雙方畫面一致。
- `public/client.js`：Three.js 3D 場景、鏡頭、瞄準與出桿、動畫回放、音效、聊天。
