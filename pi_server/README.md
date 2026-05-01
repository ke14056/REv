# Revidyne Pi Server 部署指南

這個模式下的資料流是：

- 你的電腦只需要開瀏覽器連到 Pi
- 網頁（前端）會呼叫 Pi 的 HTTP API（Pi Gateway）
- Pi 才會透過 USB/Serial 對實體裝置下指令

也就是你描述的「電腦連到 Raspberry Pi，Raspberry Pi 下指令給 device」。

## 📁 資料夾結構

把整個 `pi_server` 資料夾複製到你的 Pi：

```
pi_server/
├── server.py          # Flask 主程式
├── requirements.txt   # Python 套件
└── static/            # 網頁檔案
    ├── index.html
    ├── app.js
    ├── styles.css
    └── revidyne.js
```

---

## 🚀 部署步驟

### 1️⃣ 複製檔案到 Pi

在你的 Mac 上執行（改成你的 Pi IP）：

```bash
cd /Users/yihsuanhuang/Desktop/kelly2
scp -r pi_server ubuntu@10.106.249.120:~/revidyne-server
```

### 2️⃣ SSH 進入 Pi

```bash
ssh ubuntu@10.106.249.120
```

### 3️⃣ 安裝套件

```bash
cd ~/revidyne-server
pip3 install -r requirements.txt
```

### 4️⃣ 複製網頁到 static 資料夾

一般情況下，`pi_server/static/` 已經包含網頁檔（`index.html/app.js/styles.css/revidyne.js`），不需要再從 `html/` 複製。

只有在你自行修改了 `html/` 而沒有同步到 `pi_server/static/` 時，才需要手動複製：

```bash
# 在 Mac 上
scp /Users/yihsuanhuang/Desktop/kelly2/html/* ubuntu@10.106.249.120:~/revidyne-server/static/
```

### 5️⃣ 執行 Server

```bash
cd ~/revidyne-server
python3 server.py
```

你會看到：
```
🚀 Revidyne Pi Server starting...
🔍 Scanning 4 ports...
   ✅ /dev/ttyUSB1 → generator
   ✅ /dev/ttyUSB2 → fan
   ✅ /dev/ttyUSB3 → houseload
   ✅ /dev/ttyUSB4 → solartracker
==================================================
🌐 Server ready!
   Local:   http://127.0.0.1:5000
   Network: http://10.106.249.120:5000
==================================================
```

### 6️⃣ 打開瀏覽器

在你的電腦（或任何裝置）打開：

```
http://10.106.249.120:5000

建議在頁面右上角把 **🌐 Pi Gateway** 打開（ON）。

- ON：所有指令都會走 `http://<pi-ip>:5000/api/...`，由 Pi 幫你送到 Serial 裝置（最符合 Pi 控制裝置的情境）
- OFF：會嘗試走 WebSerial（瀏覽器直連 USB），只適用於你的電腦本機直接插著裝置的情境
```

---

## 🔧 API 端點

| 端點 | 說明 |
|------|------|
| `GET /` | 主網頁 |
| `GET /api/ports` | 列出所有 Serial ports |
| `GET /api/devices` | 列出已偵測的裝置 |
| `GET /api/scan` | 重新掃描裝置 |
| `GET /api/send/{cmd}` | 發指令到預設裝置 |
| `GET /api/send/{device}/{cmd}` | 發指令到指定裝置 |
| `GET /api/send/{device}/{cmd}/{args}` | 發帶參數的指令 |
| `GET /api/broadcast/{cmd}` | 對所有裝置發指令 |

### 範例

```bash
# 對 generator 發 init
curl http://10.106.249.120:5000/api/send/generator/init

# 對 fan 開風扇
curl http://10.106.249.120:5000/api/send/fan/fanOn

# 對 houseload 開燈
curl http://10.106.249.120:5000/api/send/houseload/lightsOn

# 對所有裝置發 init
curl http://10.106.249.120:5000/api/broadcast/init
```

---

## 🔄 開機自動啟動（選用）

建立 systemd service：

```bash
sudo nano /etc/systemd/system/revidyne.service
```

貼上：
```ini
[Unit]
Description=Revidyne Pi Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/revidyne-server
ExecStart=/usr/bin/python3 /home/ubuntu/revidyne-server/server.py
Restart=always

[Install]
WantedBy=multi-user.target
```

啟用：
```bash
sudo systemctl enable revidyne
sudo systemctl start revidyne
```

---

## ❓ 常見問題

### Q: 裝置偵測不到？
A: 檢查 USB 有沒有接好，執行 `ls /dev/ttyUSB*` 看有沒有

### Q: 網頁打不開？
A: 確認 Flask 有在跑，防火牆有開 5000 port

### Q: 指令沒反應？
A: 在 Pi 上用 `screen /dev/ttyUSB1 115200` 測試 Serial 有沒有通
