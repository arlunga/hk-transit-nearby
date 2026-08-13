// 地理計算：Haversine 距離 + 附近站點搜尋

const R = 6371000; // 地球半徑（公尺）

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** 兩點距離（公尺） */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 在點集合中找出半徑內最近的站點。
 * @param {Array<{lat:number, lon:number}>} points
 * @param {number} lat 中心緯度
 * @param {number} lon 中心經度
 * @param {number} radiusM 半徑（公尺）
 * @param {number} maxCount 最多回傳筆數
 * @returns {Array<{item, distanceM}>}
 */
export function findNearest(points, lat, lon, radiusM, maxCount) {
  const result = [];
  for (const p of points) {
    const d = haversineMeters(lat, lon, p.lat, p.lon);
    if (d <= radiusM) {
      result.push({ item: p, distanceM: d });
    }
  }
  result.sort((a, b) => a.distanceM - b.distanceM);
  return result.slice(0, maxCount);
}

/** 距離格式：< 1000m 顯示「xx 米」，否則「x.x 公里」 */
export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} 米`;
  return `${(m / 1000).toFixed(1)} 公里`;
}
