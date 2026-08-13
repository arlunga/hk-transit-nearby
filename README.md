# 附近到站 · 港鐵巴士即時

一個純前端網頁，顯示你所在位置附近的**港鐵**、**九巴**、**城巴**、**港鐵巴士**、**綠色小巴**即時到站時間。

- 零後端、零建置（純 HTML + ES Modules + CSS）
- 自動定位（瀏覽器 Geolocation）＋ 手動設定「家」的位置
- 每 30 秒自動更新，站點資料快取於 IndexedDB（7 天）
- 經「屯門公路轉車站」的路線可展開 **🚏 轉乘提示**，顯示趕上這班車後轉其他路線要等多久

## 資料來源（全部為官方開放數據，CORS 已開放）

| 交通 | API | 說明 |
|---|---|---|
| 港鐵 MTR | `rt.data.gov.hk/v1/transport/mtr/getSchedule.php` | 每 10 秒更新，最多 4 班車 |
| 九巴 KMB | `data.etabus.gov.hk/v1/transport/kmb/…` | 路線 / 站點 / ETA |
| 城巴 Citybus | `rt.data.gov.hk/v2/transport/citybus/…` | 路線 / 站點 / ETA |
| 綠色小巴 GMB | `data.etagmb.gov.hk/…` | 路線 / 站點 / ETA（約每 1 分鐘更新） |
| 港鐵巴士 MTR Bus | `rt.data.gov.hk/v1/transport/mtr/bus/getSchedule`（POST） | 每 10 秒更新 |

> 版權屬各運輸機構，資料以「資料一線通」[data.gov.hk](https://data.gov.hk) 與 [港鐵開放資料](https://opendata.mtr.com.hk) 為準。

## 本機執行

因為使用 ES Modules 與 `fetch`，需透過 HTTP 伺服器開啟（不能用 `file://`）。

```bash
cd project
python3 -m http.server 8000
# 開啟 http://localhost:8000
```

> 注意：瀏覽器定位（Geolocation）在 `localhost` 與 HTTPS 下才可用；若無法定位，可用「⚙️ 設定位置」手動輸入經緯度。

## 部署

任何靜態託管皆可（無需 Node）：

- **GitHub Pages**：把整個專案目錄推到 repo 的 `main` 分支，啟用 Pages 即可。
- **Vercel / Netlify**：匯入目錄，Build command 留空，Output 設為根目錄。

## 更新站點資料

站點/路線資料已預先算好，放在 `src/data/`。當路線或站點有異動（通常每年數次）時重新生成：

```bash
python3 scripts/build-mtr-data.py          # 港鐵站 + 代碼 + 座標（Wikipedia + Wikidata）
python3 scripts/build-kmb-data.py          # 九巴站點 → 路線索引
python3 scripts/build-citybus-data.py      # 城巴站點 → 路線索引（需抓取全港路線，約 1 分鐘）
python3 scripts/build-gmb-data.py          # 綠色小巴站點 → 路線索引（約 5 分鐘，含逐站座標查詢）
python3 scripts/build-mtr-bus-data.py      # 港鐵巴士站點 → 路線索引（讀官方 CSV）
python3 scripts/build-tmr-interchange.py   # 屯門公路轉車站轉乘表（讀 kmb-stops.json，需在建 kmb 之後跑）
```

> 在網頁上也可以直接點頁尾的「更新站點資料」強制重新下載（仍會快取 7 天）。

## 目錄結構

```
index.html              頁面結構
styles.css              樣式
app.js                  主程式（定位、找附近站、渲染、自動更新）
src/api/eta.js          港鐵/九巴/城巴/綠色小巴/港鐵巴士 ETA 抓取
src/lib/geo.js          Haversine 距離 + 附近搜尋
src/lib/store.js        IndexedDB 快取 + localStorage 設定
src/lib/data.js         靜態資料載入
src/data/*.json         預生成的站點資料（含 tmr-interchange.json 轉乘表）
scripts/build-*.py      資料生成腳本
```

## 已知限制

- 未涵蓋：新大嶼山巴士（NLB）、輕鐵、電車。
- 深夜／已收班的路線 ETA 可能為空（介面會顯示「暫無班次」）。
- 到站時間為各機構預測值，實際可能受交通影響。
