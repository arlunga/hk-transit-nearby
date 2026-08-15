import { loadStaticData, buildMtrCodeMap, buildRouteStops } from "./src/lib/data.js";
import { findNearest, formatDistance } from "./src/lib/geo.js";
import { getSetting, setSetting, removeSetting, clearAllData } from "./src/lib/store.js";
import {
  fetchKmbEta,
  fetchCitybusEta,
  fetchMtrSchedule,
  fetchGmbEta,
  fetchMtrBusEta,
  asyncPool,
  minutesUntil,
} from "./src/api/eta.js";

const LINE_NAMES = {
  AEL: "機場快綫", TCL: "東涌綫", TML: "屯馬綫", TKL: "將軍澳綫", EAL: "東鐵綫",
  SIL: "南港島綫", TWL: "荃灣綫", ISL: "港島綫", KTL: "觀塘綫", DRL: "迪士尼綫",
};

const MAX_STOPS = 10;       // 每種巴士最多顯示站數
const MAX_ROUTES = 20;      // 每站（含合併）最多抓的路線/站柱數
const MAX_BUS_ROWS = 8;     // 每站最多顯示的到站列數
const REFRESH_MS = 30000;   // 自動更新週期
const MTR_MIN_RADIUS = 1500; // 港鐵站較稀疏，用較大範圍

const state = {
  data: null,        // {mtr, kmb, citybus, gmb, mtrBus, tmr}
  mtrCodeMap: null,  // code -> 中文站名
  routeStops: null,  // {kmb, ctb, gmb, mtrbus} -> "route|dir" -> [站名順序]
  location: null,    // {lat, lon, label}
  locationError: null, // 定位失敗時的人話提示
  radius: 600,
  timer: null,
};

const $ = (id) => document.getElementById(id);

/** 跳脫 HTML 特殊字元，避免 innerHTML 注入 */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- 定位 ----------

function getHome() {
  const h = getSetting("home");
  return h && typeof h.lat === "number" ? h : null;
}

function getLocationLabel(loc) {
  if (loc.label) return loc.label;
  return `📍 (${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)})`;
}

function geolocate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("不支援定位"));
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: "📍 目前位置",
        }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

/** 把定位錯誤碼轉成清楚的提示，讓用戶知道去開手機定位／授權 */
function geoErrorText(err) {
  if (!navigator.geolocation) {
    return "此瀏覽器不支援定位 — 請用系統瀏覽器開啟，或「⚙️ 設定位置」手動輸入";
  }
  switch (err && err.code) {
    case 1: // PERMISSION_DENIED
      return "瀏覽器封鎖了定位（常見於 app 內建瀏覽器或曾按「拒絕」）— 請用系統瀏覽器開啟並允許，或「⚙️ 設定位置」手動輸入";
    case 2: // POSITION_UNAVAILABLE
      return "抓不到位置 — 請確認手機已開「定位服務／GPS」，再點「📍 目前位置」重試";
    case 3: // TIMEOUT
      return "定位逾時 — 請確認已開定位，再點「📍 目前位置」重試";
    default:
      return "無法定位 — 點「📍 目前位置」重試，或「⚙️ 設定位置」手動輸入";
  }
}

async function determineLocation() {
  const home = getHome();
  if (home) {
    state.location = { ...home, label: "🏠 我家" };
    state.locationError = null;
    return;
  }
  try {
    state.location = await geolocate();
    state.locationError = null;
  } catch (err) {
    state.location = null;
    state.locationError = geoErrorText(err);
    setStatus(state.locationError);
  }
}

function setStatus(text) {
  $("loc-status").textContent = text;
}

// ---------- 資料載入 ----------

async function loadData(force = false) {
  setStatus("載入站點資料…");
  state.data = await loadStaticData(force);
  state.mtrCodeMap = buildMtrCodeMap(state.data.mtr);
  state.routeStops = buildRouteStops(state.data);
}

// ---------- 計算附近站點 ----------

function nearby() {
  const { lat, lon } = state.location;
  const r = state.radius;
  return {
    mtr: findNearest(state.data.mtr, lat, lon, Math.max(r, MTR_MIN_RADIUS), 2),
    kmb: findNearest(state.data.kmb, lat, lon, r, MAX_STOPS),
    citybus: findNearest(state.data.citybus, lat, lon, r, MAX_STOPS),
    gmb: findNearest(state.data.gmb, lat, lon, r, MAX_STOPS),
    mtrBus: findNearest(state.data.mtrBus.stops, lat, lon, r, MAX_STOPS),
  };
}

// ---------- 抓取 ETA ----------

async function fetchKmbEtasForStop(stop) {
  // 合併站點含多個站柱，每個 (stop, route, service_type) 只回傳該站柱的方向，
  // 故以「站柱 + 路線 + 服務型態」去重，逐一查詢才能湊齊雙方向。
  const keys = [];
  const seen = new Set();
  for (const rt of stop.routes) {
    const k = `${rt.stop}|${rt.route}|${rt.service_type}`;
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(rt);
      if (keys.length >= MAX_ROUTES) break;
    }
  }
  const results = await asyncPool(
    keys.map((rt) => () => fetchKmbEta(rt.stop, rt.route, rt.service_type)),
    10
  );
  return keys.map((rt, i) => ({ rt, eta: results[i] || [] }));
}

async function fetchCitybusEtasForStop(stop) {
  const keys = [];
  const seen = new Set();
  for (const rt of stop.routes) {
    const k = `${rt.stop}|${rt.route}`;
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(rt);
      if (keys.length >= MAX_ROUTES) break;
    }
  }
  const results = await asyncPool(
    keys.map((rt) => () => fetchCitybusEta(rt.stop, rt.route)),
    10
  );
  return keys.map((rt, i) => ({ rt, eta: results[i] || [] }));
}

// ---------- 綠色小巴 / 港鐵巴士 ----------

/** 綠色小巴 ETA：diff 為分鐘（API 直接給），fallback 用 timestamp */
function gmbMinutes(eta) {
  const d = Number(eta.diff);
  if (Number.isFinite(d) && d >= 0) return Math.round(d);
  return minutesUntil(eta.timestamp);
}

/** 把分組好的列（每組含 times[]）依下一班排序、每組最多 4 班、截斷 */
function finalizeMinibusRows(groups) {
  const rows = [...groups.values()]
    .map((g) => {
      g.times.sort((a, b) => a - b);
      return { ...g, mins: g.times[0], times: g.times.slice(0, 4) };
    })
    .filter((g) => g.times.length > 0)
    .sort((a, b) => a.mins - b.mins);
  return rows.slice(0, MAX_BUS_ROWS);
}

/** 綠色小巴：一站一次查回所有路線，映射 route_id → 路線編號／目的地；每方向最多 4 班 */
async function fetchGmbEtasForStop(stop) {
  const data = await fetchGmbEta(stop.id);
  const byKey = new Map();
  for (const r of stop.routes) byKey.set(`${r.route_id}|${r.dir}`, r);

  const groups = new Map(); // route_id|dir -> {route, dir, route_id, dest, times}
  for (const e of data) {
    const key = `${e.route_id}|${e.route_seq}`;
    const info = byKey.get(key);
    if (!info) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        route: info.route, dir: info.dir, route_id: info.route_id,
        dest: info.dest_tc || "", times: [],
      });
    }
    const g = groups.get(key);
    for (const eta of e.eta || []) {
      const mins = gmbMinutes(eta);
      if (mins === null) continue;
      g.times.push(mins);
    }
  }
  return finalizeMinibusRows(groups);
}

/** 港鐵巴士：依 routeName 查 ETA（POST），再對回該站的 busStopId；每方向最多 4 班 */
async function fetchMtrBusEtasForStop(stop) {
  const codes = [...new Set(stop.routes.map((r) => r.route))];
  const results = await asyncPool(codes.map((c) => () => fetchMtrBusEta(c)), 4);
  const byCode = new Map();
  codes.forEach((c, i) => byCode.set(c, results[i]));
  const lineRefs = state.data.mtrBus.lineRefs || {};

  const groups = new Map(); // route|dest -> {route, dir, dest, times}
  for (const r of stop.routes) {
    const resp = byCode.get(r.route);
    if (!resp || !Array.isArray(resp.busStop)) continue;
    const bs = resp.busStop.find((b) => b.busStopId === r.stop);
    if (!bs) continue;
    for (const bus of bs.bus || []) {
      const sec = parseInt(bus.arrivalTimeInSecond, 10);
      // 108000 秒（30 小時）＝尾班已過／無資料；不顯示
      if (Number.isNaN(sec) || sec < 0 || sec >= 108000) continue;
      const dest = lineRefs[bus.lineRef] || r.dest_tc || "";
      const key = `${r.route}|${dest}`;
      if (!groups.has(key)) {
        groups.set(key, { route: r.route, dir: r.dir, dest, times: [] });
      }
      groups.get(key).times.push(Math.round(sec / 60));
    }
  }
  return finalizeMinibusRows(groups);
}

/** 把 ETA 陣列整理成 {dest, mins, times} 列（依 dir+dest 分組，每方向最多 4 班） */
function summarizeEta(etaArray) {
  const groups = new Map();
  const order = [];
  for (const e of etaArray) {
    const mins = minutesUntil(e.eta);
    if (mins === null) continue; // 無預測（已收班等）
    const dest = e.dest_tc || e.dest_en || "";
    const key = `${e.dir}|${dest}`;
    if (!groups.has(key)) { groups.set(key, { dest, times: [] }); order.push(key); }
    groups.get(key).times.push(mins);
  }
  const rows = order.map((key) => {
    const g = groups.get(key);
    g.times.sort((a, b) => a - b);
    return { dest: g.dest, mins: g.times[0], times: g.times.slice(0, 4) };
  });
  rows.sort((a, b) => a.mins - b.mins);
  return rows.slice(0, MAX_BUS_ROWS);
}

/** 依 dir 分組 ETA（總站同一站柱會回傳雙方向），保留出現順序 */
function groupByDir(eta, fallbackDir) {
  const order = [];
  const map = new Map();
  for (const e of eta) {
    const d = e.dir || fallbackDir || "";
    if (!map.has(d)) { map.set(d, []); order.push(d); }
    map.get(d).push(e);
  }
  return order.map((d) => ({ dir: d, entries: map.get(d) }));
}

// ---------- 屯門公路轉車站轉乘 ----------

/**
 * 列出同方向其他路線於屯門公路轉車站「最近 3 班」的到站時間（相對現在）。
 * @param {string} route 路線編號
 * @param {string} bound 方向 O/I
 * @returns {Promise<{label:string, transfers:Array<{route,buses:Array<{dest,wait}>|null}>}|null>}
 */
async function computeTmrTransfer(route, bound) {
  const dirInfo = state.data?.tmr?.directions?.[bound];
  if (!dirInfo || !dirInfo.stops[route]) return null;

  // 同方向所有其他路線，各取「最近 3 班」到站時間（相對現在）。
  // 不再用 eta_seq 比對「同一班車」、也不估算「幾耐到轉車站」——
  // 實測 eta_seq 只是「該站第幾班」的序號（非跨站穩定識別碼），比對不可靠。
  const others = Object.keys(dirInfo.stops).filter((r) => r !== route);
  const results = await asyncPool(
    others.map((r2) => async () => {
      const info = dirInfo.stops[r2];
      const etas = await fetchKmbEta(info.stop, r2, info.service_type);
      return { route: r2, etas };
    }),
    10
  );

  const transfers = [];
  for (const item of results) {
    if (!item) continue;
    const buses = item.etas
      .map((e) => ({ dest: e.dest_tc || e.dest_en || "", mins: minutesUntil(e.eta) }))
      .filter((x) => x.mins !== null)
      .sort((a, b) => a.mins - b.mins)
      .slice(0, 3)
      .map((x) => ({ dest: x.dest, wait: x.mins }));
    // 無下一班（尾班車已過等）→ buses = null，顯示時標「已收車／無班次」
    transfers.push({ route: item.route, buses: buses.length ? buses : null });
  }
  transfers.sort((a, b) => {
    const aw = a.buses?.[0]?.wait ?? null;
    const bw = b.buses?.[0]?.wait ?? null;
    if (aw === null && bw === null) return a.route.localeCompare(b.route, undefined, { numeric: true });
    if (aw === null) return 1;
    if (bw === null) return -1;
    return aw - bw;
  });
  return { label: dirInfo.label, transfers };
}

/** 判斷轉車站是否在自家站下游（仍未經過）：以路線站序 seq 比較，免額外 API 呼叫 */
function transferAhead(route, bound, etaEntries) {
  const info = state.data?.tmr?.directions?.[bound]?.stops?.[route];
  if (!info) return false;
  const homeSeq = Number(etaEntries?.[0]?.seq);
  const transferSeq = Number(info.seq);
  // 判斷不到時仍顯示，交由點擊後的實際 ETA 比對把關
  if (!Number.isFinite(homeSeq) || !Number.isFinite(transferSeq)) return true;
  return transferSeq > homeSeq;
}

/** 為某路線加「🚏 轉乘」按鈕與惰性載入的完整轉乘列表 */
function addTransferToggle(group, route, bound) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "transfer-toggle";
  btn.textContent = "🚏 屯門公路轉車站轉乘";

  const box = document.createElement("div");
  box.className = "transfer-list hidden";

  group.appendChild(btn);
  group.appendChild(box);

  let opened = false;
  let loading = false;
  btn.addEventListener("click", () => {
    if (opened) {
      box.classList.add("hidden");
      btn.textContent = "🚏 屯門公路轉車站轉乘";
      opened = false;
      return;
    }
    opened = true;
    btn.textContent = "🚏 收起轉乘";
    box.classList.remove("hidden");
    if (box.dataset.loaded || loading) return;
    loading = true;
    box.innerHTML = '<span class="spinner"></span>';
    computeTmrTransfer(route, bound)
      .then((res) => {
        box.dataset.loaded = "1";
        renderTransferList(box, res);
      })
      .catch(() => {
        box.innerHTML = '<div class="card-sub">載入失敗</div>';
      })
      .finally(() => {
        loading = false;
      });
  });
}

function renderTransferList(box, res) {
  box.innerHTML = "";
  if (!res) {
    box.innerHTML = '<div class="card-sub">此班次已過轉車站或無轉乘資料</div>';
    return;
  }
  const head = document.createElement("div");
  head.className = "transfer-head";
  head.textContent = `🚏 屯門公路轉車站（${res.label}）· 各線到站時間`;
  box.appendChild(head);

  if (!res.transfers.length) {
    const empty = document.createElement("div");
    empty.className = "card-sub";
    empty.textContent = "暫無即時轉乘資料";
    box.appendChild(empty);
    return;
  }
  for (const t of res.transfers) {
    const line = document.createElement("div");
    const buses = t.buses;
    line.className = "transfer-row" + (!buses ? " closed" : "");
    if (!buses) {
      line.innerHTML = `
        <span class="route-badge kmb-badge">${esc(t.route)}</span>
        <span class="wait-closed">已收車／無班次</span>`;
    } else {
      // 首班 + 其後兩班（同方向通常同一目的地，只列一次目的地）
      const [first, ...rest] = buses;
      const extra = rest.length
        ? `<span class="eta-times">${rest.map((b) => `${b.wait} 分`).join(" · ")}</span>`
        : "";
      line.innerHTML = `
        <span class="route-badge kmb-badge">${esc(t.route)}</span>
        ${first.dest ? `<span class="eta-dest">往 ${esc(first.dest)}</span>` : ""}
        <span class="eta-time ${timeClass(first.wait)}">${timeText(first.wait)}</span>
        ${extra}`;
    }
    box.appendChild(line);
  }
}

/** 去除 KMB 站名後綴（如「屯門站總站 (V8)」→「屯門站總站」） */
function bareStopName(name) {
  return String(name || "").replace(/\s*\([A-Z]{2}\d+\)\s*$/, "").trim();
}

/**
 * 為某路線加「🗺️ 路線」按鈕，點擊展開完整途經站（只列站名順序，不顯示到站時間）。
 */
function addRouteToggle(container, mode, key, currentName) {
  const stops = state.routeStops?.[mode]?.[key];
  if (!stops || !stops.length) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "route-toggle";
  btn.textContent = "🗺️ 路線";

  const box = document.createElement("div");
  box.className = "route-list hidden";

  container.appendChild(btn);
  container.appendChild(box);

  let opened = false;
  btn.addEventListener("click", () => {
    opened = !opened;
    if (opened) {
      btn.textContent = "🗺️ 收起路線";
      box.classList.remove("hidden");
      paintRouteList(box, stops, currentName);
    } else {
      btn.textContent = "🗺️ 路線";
      box.classList.add("hidden");
    }
  });
}

/** 渲染路線途經站：只列站名順序，標記「你在此」／「已過」。 */
function paintRouteList(box, stops, currentName) {
  let curIdx = -1;
  if (currentName) {
    curIdx = stops.indexOf(currentName);
    if (curIdx < 0) {
      const bare = bareStopName(currentName);
      curIdx = stops.findIndex((s) => bareStopName(s) === bare);
    }
  }

  box.innerHTML = "";
  const ol = document.createElement("ol");
  ol.className = "route-stop-list";
  stops.forEach((name, i) => {
    const li = document.createElement("li");
    let tag = "";
    if (i === curIdx) {
      li.className = "current";
      tag = '<span class="route-stop-tag current">你在此</span>';
    } else if (curIdx >= 0 && i < curIdx) {
      li.className = "passed";
      tag = '<span class="route-stop-tag">已過</span>';
    }
    li.innerHTML = `
      <span class="route-stop-seq">${i + 1}</span>
      <span class="route-stop-name">${esc(name)}</span>
      ${tag}`;
    ol.appendChild(li);
  });
  box.appendChild(ol);
}

async function fetchMtrForStation(station) {
  const lineResults = await asyncPool(
    station.lines.map((ln) => async () => ({ ln, data: await fetchMtrSchedule(ln, station.code) })),
    4
  );
  return lineResults.filter((r) => r && r.data && (r.data.UP.length || r.data.DOWN.length));
}

function mtrTrains(schedule) {
  const trains = [];
  for (const dir of ["UP", "DOWN"]) {
    for (const t of schedule[dir] || []) {
      const dest = state.mtrCodeMap[t.dest] || t.dest;
      const mins = parseInt(t.ttnt, 10);
      trains.push({ dest, mins: Number.isNaN(mins) ? 0 : mins, plat: t.plat });
    }
  }
  // 去重（同一班車可能重複）
  const seen = new Set();
  return trains.filter((t) => {
    const k = `${t.dest}|${t.mins}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.mins - b.mins).slice(0, 8);
}

// ---------- 渲染 ----------

function timeClass(mins) {
  if (mins === 0) return "now";
  if (mins <= 2) return "soon";
  return "";
}

function timeText(mins) {
  if (mins === 0) return "即將到站";
  return `${mins} 分鐘`;
}

/** 額外班次時間（第 2–4 班），以「· X 分」串接；無則空字串 */
function extraTimesHtml(times) {
  if (!times || times.length <= 1) return "";
  return `<span class="eta-times">${times.slice(1).map((m) => `${m} 分`).join(" · ")}</span>`;
}

function renderMtr(items) {
  const list = $("mtr-list");
  list.innerHTML = "";
  if (!items.length) {
    $("mtr-section").classList.add("hidden");
    return;
  }
  $("mtr-section").classList.remove("hidden");
  for (const { item: st, distanceM } of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <span class="route-badge mtr-badge">港鐵</span>
        <span class="card-name">${esc(st.name_tc)}</span>
        <span class="card-dist">${formatDistance(distanceM)}</span>
      </div>
      <div class="mtr-groups"></div>`;
    const groups = card.querySelector(".mtr-groups");
    fetchMtrForStation(st)
      .then((lineResults) => {
        if (!lineResults.length) {
          groups.innerHTML = '<div class="card-sub">暫無班次</div>';
          return;
        }
        for (const r of lineResults) {
          const g = document.createElement("div");
          g.className = "mtr-line-group";
          g.innerHTML = `<div class="mtr-line-title">${LINE_NAMES[r.ln] || r.ln}</div><div class="mtr-trains"></div>`;
          const trainsBox = g.querySelector(".mtr-trains");
          const trains = mtrTrains(r.data);
          if (!trains.length) {
            g.querySelector(".mtr-line-title").textContent =
              `${LINE_NAMES[r.ln] || r.ln} — 暫無班次`;
          }
          for (const t of trains) {
            const el = document.createElement("span");
            el.className = "mtr-train";
            el.innerHTML = `<span class="dest">往 ${esc(t.dest)}</span> · <span class="min">${timeText(t.mins)}</span>`;
            trainsBox.appendChild(el);
          }
          groups.appendChild(g);
        }
      })
      .catch(() => {
        groups.innerHTML = '<div class="card-sub">載入失敗</div>';
      });
    list.appendChild(card);
  }
}

function renderBusStops(items, mode, listElId, sectionElId) {
  const list = $(listElId);
  list.innerHTML = "";
  if (!items.length) {
    $(sectionElId).classList.add("hidden");
    return;
  }
  $(sectionElId).classList.remove("hidden");

  const badgeClass = mode === "kmb" ? "kmb-badge" : "ctb-badge";
  const fetchFn = mode === "kmb" ? fetchKmbEtasForStop : fetchCitybusEtasForStop;

  for (const { item: stop, distanceM } of items) {
    const card = document.createElement("div");
    card.className = "card";
    const name = (stop.name_tc || stop.name_en).replace(/\s*\([A-Z]{2}\d+\)\s*$/, "");
    card.innerHTML = `
      <div class="card-head">
        <span class="card-name">${esc(name)}</span>
        <span class="card-dist">${formatDistance(distanceM)}</span>
      </div>
      <div class="eta-list"><span class="spinner"></span></div>`;
    const etaBox = card.querySelector(".eta-list");
    list.appendChild(card);

    fetchFn(stop)
      .then((routeResults) => {
        etaBox.innerHTML = "";
        let rowCount = 0;

        outer:
        for (const { rt, eta } of routeResults) {
          if (!eta.length) continue;
          // 同一站柱可能回傳雙方向（總站），依 dir 分組逐方向處理
          for (const d of groupByDir(eta, rt.bound || rt.dir)) {
            const rows = summarizeEta(d.entries);
            if (!rows.length) continue;
            const group = document.createElement("div");
            group.className = "route-group";
            let added = 0;
            for (const r of rows) {
              if (rowCount >= MAX_BUS_ROWS) break;
              rowCount++;
              added++;
              const row = document.createElement("div");
              row.className = "eta-row";
              row.innerHTML = `
                <span class="route-badge ${badgeClass}">${esc(rt.route)}</span>
                <span class="eta-dest">往 ${esc(r.dest)}</span>
                <span class="eta-time ${timeClass(r.mins)}">${timeText(r.mins)}</span>
                ${extraTimesHtml(r.times)}`;
              group.appendChild(row);
            }
            if (added === 0) break outer; // 已達每站列數上限
            etaBox.appendChild(group);

            addRouteToggle(group, mode, `${rt.route}|${d.dir}`, stop.name_tc);

            // 九巴路線若經屯門公路轉車站且轉車站在下游（尚未經過），附轉乘按鈕
            if (mode === "kmb" && transferAhead(rt.route, d.dir, d.entries)) {
              addTransferToggle(group, rt.route, d.dir);
            }
          }
        }

        if (!rowCount) {
          etaBox.innerHTML = '<div class="card-sub">暫無班次或路線未營運</div>';
        }
      })
      .catch(() => {
        etaBox.innerHTML = '<div class="card-sub">載入失敗</div>';
      });
  }
}

/** 綠色小巴／港鐵巴士共用渲染（fetchFn 回傳 [{route,dest,mins}]） */
function renderMinibusStops(items, mode, listElId, sectionElId, fetchFn) {
  const list = $(listElId);
  list.innerHTML = "";
  if (!items.length) {
    $(sectionElId).classList.add("hidden");
    return;
  }
  $(sectionElId).classList.remove("hidden");

  const badgeClass = mode === "gmb" ? "gmb-badge" : "mtrbus-badge";

  for (const { item: stop, distanceM } of items) {
    const card = document.createElement("div");
    card.className = "card";
    const name = (stop.name_tc || stop.name_en).trim();
    card.innerHTML = `
      <div class="card-head">
        <span class="card-name">${esc(name)}</span>
        <span class="card-dist">${formatDistance(distanceM)}</span>
      </div>
      <div class="eta-list"><span class="spinner"></span></div>`;
    const etaBox = card.querySelector(".eta-list");
    list.appendChild(card);

    fetchFn(stop)
      .then((rows) => {
        etaBox.innerHTML = "";
        if (!rows.length) {
          etaBox.innerHTML = '<div class="card-sub">暫無班次或路線未營運</div>';
          return;
        }
        for (const r of rows) {
          const group = document.createElement("div");
          group.className = "route-group";
          const row = document.createElement("div");
          row.className = "eta-row";
          row.innerHTML = `
            <span class="route-badge ${badgeClass}">${esc(r.route)}</span>
            ${r.dest ? `<span class="eta-dest">往 ${esc(r.dest)}</span>` : ""}
            <span class="eta-time ${timeClass(r.mins)}">${timeText(r.mins)}</span>
            ${extraTimesHtml(r.times)}`;
          group.appendChild(row);
          etaBox.appendChild(group);
          if (r.dir !== undefined && r.dir !== null) {
            const routeKey = mode === "gmb" ? `${r.route_id}|${r.dir}` : `${r.route}|${r.dir}`;
            addRouteToggle(group, mode, routeKey, stop.name_tc);
          }
        }
      })
      .catch(() => {
        etaBox.innerHTML = '<div class="card-sub">載入失敗</div>';
      });
  }
}

function renderAll() {
  if (!state.data || !state.location) return;
  const n = nearby();
  renderMtr(n.mtr);
  renderBusStops(n.kmb, "kmb", "kmb-list", "kmb-section");
  renderBusStops(n.citybus, "ctb", "ctb-list", "citybus-section");
  renderMinibusStops(n.mtrBus, "mtrbus", "mtr-bus-list", "mtr-bus-section", fetchMtrBusEtasForStop);
  renderMinibusStops(n.gmb, "gmb", "gmb-list", "gmb-section", fetchGmbEtasForStop);

  const total = n.mtr.length + n.kmb.length + n.citybus.length + n.mtrBus.length + n.gmb.length;
  $("empty").classList.toggle("hidden", total > 0);
}

function updateStatus() {
  setStatus(
    state.location
      ? `${getLocationLabel(state.location)} · 範圍 ${state.radius} 米`
      : (state.locationError || "無法定位 — 點「📍 目前位置」或「⚙️ 設定位置」手動輸入")
  );
}

function refresh() {
  if (!state.data) return;
  updateStatus();
  renderAll();
  $("last-updated").textContent = `更新於 ${new Date().toLocaleTimeString("zh-HK")}`;
}

// ---------- 控制項 ----------

function bindControls() {
  $("radius").value = String(state.radius);
  $("radius").addEventListener("change", () => {
    state.radius = parseInt($("radius").value, 10) || 600;
    setSetting("radius", state.radius);
    refresh();
  });

  $("btn-locate").addEventListener("click", async () => {
    setStatus("定位中…");
    try {
      state.location = await geolocate();
      state.locationError = null;
      removeSetting("home");
      await refresh();
    } catch (err) {
      state.location = null;
      state.locationError = geoErrorText(err);
      setStatus(state.locationError);
      $("location-panel").classList.remove("hidden");
    }
  });

  $("btn-home").addEventListener("click", async () => {
    if (!state.location) {
      try {
        state.location = await geolocate();
        state.locationError = null;
      } catch (err) {
        setStatus(geoErrorText(err));
        $("location-panel").classList.remove("hidden");
        return;
      }
    }
    setSetting("home", { lat: state.location.lat, lon: state.location.lon });
    await refresh();
  });

  $("btn-refresh").addEventListener("click", () => refresh());

  $("btn-settings").addEventListener("click", () =>
    $("location-panel").classList.toggle("hidden")
  );

  // 設定位置面板
  $("btn-apply-coord").addEventListener("click", async () => {
    const lat = parseFloat($("lat-input").value);
    const lon = parseFloat($("lon-input").value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      setStatus("請輸入有效經緯度");
      return;
    }
    state.location = { lat, lon, label: `📍 (${lat.toFixed(5)}, ${lon.toFixed(5)})` };
    $("location-panel").classList.add("hidden");
    await refresh();
  });

  $("btn-clear-home").addEventListener("click", async () => {
    removeSetting("home");
    $("location-panel").classList.add("hidden");
    await refresh();
  });

  $("btn-reload-data").addEventListener("click", async () => {
    setStatus("重新下載站點資料…");
    await loadData(true);
    await refresh();
  });

  // 一鍵清除本地資料（localStorage 設定 + IndexedDB 站點快取），清完重載頁面
  $("btn-clear-data").addEventListener("click", async () => {
    if (!confirm("確定清除所有本地資料？\n會刪除「我家」位置、範圍設定及站點快取。")) return;
    await clearAllData();
    location.reload();
  });
}

// ---------- 啟動 ----------

async function init() {
  state.radius = getSetting("radius", 600);
  bindControls();

  // 點狀態列可切換設定面板
  $("loc-status").addEventListener("click", () =>
    $("location-panel").classList.toggle("hidden")
  );

  // 定位先跑（讓權限提示盡早跳出），與載入站點資料並行
  const locationPromise = determineLocation();
  try {
    await loadData();
  } catch (e) {
    setStatus(`站點資料載入失敗：${e.message}`);
    return;
  }
  await locationPromise;
  refresh();
  state.timer = setInterval(refresh, REFRESH_MS);
}

init();
