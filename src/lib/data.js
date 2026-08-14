// 靜態站點資料載入 + 快取（IndexedDB，7 天有效）

import { kvGet, kvSet } from "./store.js";
import { haversineMeters } from "./geo.js";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

const SOURCES = {
  mtr: { url: "src/data/mtr-stations.json", list: (d) => d.stations },
  kmb: { url: "src/data/kmb-stops.json", list: (d) => d.stops },
  citybus: { url: "src/data/citybus-stops.json", list: (d) => d.stops },
  gmb: { url: "src/data/gmb-stops.json", list: (d) => d.stops },
  mtrBus: { url: "src/data/mtr-bus-stops.json", list: (d) => d },
  tmr: { url: "src/data/tmr-interchange.json", list: (d) => d },
};

async function cachedJson(key, url, force) {
  if (!force) {
    const cached = await kvGet(key);
    if (cached && cached.data && Date.now() - cached.ts < MAX_AGE_MS) {
      return cached.data;
    }
  }
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`載入 ${url} 失敗：HTTP ${res.status}`);
  const data = await res.json();
  await kvSet(key, { data, ts: Date.now() });
  return data;
}

/**
 * 載入全部靜態資料。
 * @returns {Promise<{mtr: Array, kmb: Array, citybus: Array, gmb: Array, mtrBus: Object, tmr: Object}>}
 */
export async function loadStaticData(force = false) {
  const [mtr, kmb, citybus, gmb, mtrBus, tmr] = await Promise.all([
    cachedJson("data:mtr", SOURCES.mtr.url, force),
    cachedJson("data:kmb", SOURCES.kmb.url, force),
    cachedJson("data:citybus", SOURCES.citybus.url, force),
    cachedJson("data:gmb", SOURCES.gmb.url, force),
    cachedJson("data:mtrBus", SOURCES.mtrBus.url, force),
    cachedJson("data:tmr", SOURCES.tmr.url, force),
  ]);
  return {
    mtr: SOURCES.mtr.list(mtr),
    kmb: SOURCES.kmb.list(kmb),
    citybus: SOURCES.citybus.list(citybus),
    gmb: SOURCES.gmb.list(gmb),
    mtrBus: SOURCES.mtrBus.list(mtrBus), // {stops, lineRefs}
    tmr: SOURCES.tmr.list(tmr),
  };
}

/** 建立港鐵車站代碼 → 站名 對照表 */
export function buildMtrCodeMap(mtrStations) {
  const map = {};
  for (const s of mtrStations) {
    map[s.code] = s.name_tc;
  }
  return map;
}

/**
 * 建立「路線 × 方向 → 依序停站（含累計行車時間）」對照（供「🗺️ 路線」按鈕顯示完整途經站）。
 * 直接從已載入的站點資料反轉，無需額外資料檔。
 * 每站附 cum = 由總站起計的估算行車分鐘（依站間距離 + 平均車速推算，僅供參考）。
 * @param {{kmb:Array, citybus:Array, gmb:Array, mtrBus:Object}} data
 * @returns {{kmb:Object, ctb:Object, gmb:Object, mtrbus:Object}} 值為 [{name, cum}]
 */
const SPEED_M_PER_MIN = 300; // 平均車速約 18 km/h
const DWELL_MIN = 0.4;       // 每站停靠時間（分鐘）

/** 依 seq 排序好的站點（含座標）→ [{name, cum}]，cum 為累計分鐘 */
function cumulativeMinutes(items) {
  let cum = 0;
  return items.map((it, i) => {
    if (i > 0) {
      const prev = items[i - 1];
      cum += haversineMeters(prev.lat, prev.lon, it.lat, it.lon) / SPEED_M_PER_MIN + DWELL_MIN;
    }
    return { seq: it.seq, name: it.name, cum };
  });
}

export function buildRouteStops(data) {
  // KMB：service_type 代表不同服務時段／特別班次（停站可能不同），
  // 每個 (route, bound) 取「停站最多」的 service_type（主路線／最完整走線）。
  const kmbGroups = new Map();
  for (const s of data.kmb) {
    for (const r of s.routes || []) {
      const k = `${r.route}|${r.bound}|${r.service_type}`;
      let arr = kmbGroups.get(k);
      if (!arr) { arr = []; kmbGroups.set(k, arr); }
      arr.push([r.seq || 0, s.name_tc, s.lat, s.lon]);
    }
  }
  const kmbBest = new Map(); // route|bound -> [service_type, arr]
  for (const [k, arr] of kmbGroups) {
    const i = k.lastIndexOf("|");
    const rk = k.slice(0, i);
    const st = k.slice(i + 1);
    const cur = kmbBest.get(rk);
    if (
      !cur ||
      arr.length > cur[1].length ||
      (arr.length === cur[1].length && +st < +cur[0])
    ) {
      kmbBest.set(rk, [st, arr]);
    }
  }
  const kmb = {};
  for (const [rk, [, arr]] of kmbBest) {
    arr.sort((a, b) => a[0] - b[0]);
    kmb[rk] = cumulativeMinutes(arr.map((x) => ({ seq: x[0], name: x[1], lat: x[2], lon: x[3] })));
  }

  // 城巴／綠色小巴／港鐵巴士：依 key 分組、依 seq 排序。
  // 綠色小巴路線編號（route）跨區重複（如「44」在新界與九龍是不同路線），
  // 故須用 route_id 做 key，避免把同名不同線的站合併。
  const simple = (stops, keyOf) => {
    const groups = new Map();
    for (const s of stops) {
      for (const r of s.routes || []) {
        const k = keyOf(r);
        let arr = groups.get(k);
        if (!arr) { arr = []; groups.set(k, arr); }
        arr.push([r.seq || 0, s.name_tc, s.lat, s.lon]);
      }
    }
    const out = {};
    for (const [k, arr] of groups) {
      arr.sort((a, b) => a[0] - b[0]);
      out[k] = cumulativeMinutes(arr.map((x) => ({ seq: x[0], name: x[1], lat: x[2], lon: x[3] })));
    }
    return out;
  };

  const routeDir = (r) => `${r.route}|${r.dir}`;
  return {
    kmb,
    ctb: simple(data.citybus, routeDir),
    gmb: simple(data.gmb, (r) => `${r.route_id}|${r.dir}`),
    mtrbus: simple(data.mtrBus.stops, routeDir),
  };
}
