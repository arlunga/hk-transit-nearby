// 靜態站點資料載入 + 快取（IndexedDB，7 天有效）

import { kvGet, kvSet } from "./store.js";

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
