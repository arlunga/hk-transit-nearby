// 即時到站 API（港鐵 / 九巴 / 城巴 / 綠色小巴 / 港鐵巴士）

const KMB_BASE = "https://data.etabus.gov.hk/v1/transport/kmb";
const CTB_BASE = "https://rt.data.gov.hk/v2/transport/citybus";
const MTR_BASE = "https://rt.data.gov.hk/v1/transport/mtr";
const GMB_BASE = "https://data.etagmb.gov.hk";
const MTR_BUS_BASE = "https://rt.data.gov.hk/v1/transport/mtr/bus";

async function fetchJson(url, timeoutMs = 15000, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, ...options });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** ISO 時間 → 距離現在的分鐘數；無效／空值回傳 null（表示無預測） */
export function minutesUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 60000));
}

/** 九巴到站（回傳 data 陣列） */
export async function fetchKmbEta(stop, route, serviceType) {
  const d = await fetchJson(`${KMB_BASE}/eta/${stop}/${route}/${serviceType}`);
  return d.data || [];
}

/** 九巴路線沿途到站（回傳 data 陣列，每項含 seq/eta_seq/eta/dir/dest_tc） */
export async function fetchKmbRouteEta(route, serviceType) {
  const d = await fetchJson(`${KMB_BASE}/route-eta/${route}/${serviceType}`);
  return d.data || [];
}

/** 城巴到站 */
export async function fetchCitybusEta(stop, route) {
  const d = await fetchJson(`${CTB_BASE}/eta/CTB/${stop}/${route}`);
  return d.data || [];
}

/** 港鐵到站（回傳 { UP, DOWN }，每個元素含 dest/ttnt/plat/time） */
export async function fetchMtrSchedule(line, station) {
  const d = await fetchJson(`${MTR_BASE}/getSchedule.php?line=${line}&sta=${station}`);
  if (d.status !== 1 || !d.data) return { UP: [], DOWN: [] };
  const key = Object.keys(d.data)[0];
  return d.data[key] || { UP: [], DOWN: [] };
}

/** 綠色小巴到站（回傳 data 陣列，每項含 route_id/route_seq/eta:[{diff,timestamp,remarks_tc}]） */
export async function fetchGmbEta(stopId) {
  const d = await fetchJson(`${GMB_BASE}/eta/stop/${stopId}`);
  return d.data || [];
}

/** 港鐵巴士到站（POST routeName，回傳 {busStop:[{busStopId,bus:[{lineRef,arrivalTimeInSecond}]}]}） */
export async function fetchMtrBusEta(routeName) {
  return fetchJson(
    `${MTR_BUS_BASE}/getSchedule`,
    15000,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "zh", routeName }),
    }
  );
}

/**
 * 並行池：限制同時執行的 Promise 數量。
 * @param {Array<() => Promise>} tasks
 * @param {number} limit
 * @returns {Promise<Array>} 依輸入順序的結果（失敗項為 null）
 */
export async function asyncPool(tasks, limit = 8) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (cursor < tasks.length) {
        const i = cursor++;
        try {
          results[i] = await tasks[i]();
        } catch {
          results[i] = null;
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}
