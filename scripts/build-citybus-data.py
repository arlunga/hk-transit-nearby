#!/usr/bin/env python3
"""生成 src/data/citybus-stops.json

城巴沒有「一次抓全部站點」的端點，只能：路線 → 各方向站序 → 逐站查座標。
再把「同名 + 50 米內」的多個 stop ID 合併成一個站（城巴同站也會拆成多個站柱）。

產出：每個站點 {id, name_tc, name_en, lat, lon, routes:[{route, dir, seq, stop}]}
  route.stop = 該路線實際查 ETA 用的 stop ID。

用法：python3 scripts/build-citybus-data.py
"""
import json
import math
import re
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://rt.data.gov.hk/v2/transport/citybus"
COMPANY = "CTB"
WORKERS = 20
MERGE_M = 50  # 合併距離（公尺）


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "hk-transit-builder/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def norm_name(name):
    return re.sub(r"\s*\([A-Z]{2}\d+\)\s*$", "", name).strip()


def norm_en(name):
    return re.sub(r"\s*\([A-Z0-9]+\)\s*$", "", name).strip()


def dist_m(a, b):
    lat = math.radians((a["lat"] + b["lat"]) / 2)
    dlat = (a["lat"] - b["lat"]) * 111320
    dlon = (a["lon"] - b["lon"]) * 111320 * math.cos(lat)
    return math.hypot(dlat, dlon)


def merge_stops(stops):
    clusters = []
    for s in stops:
        nm = norm_name(s["name_tc"])
        placed = False
        for c in clusters:
            if c["name"] == nm and dist_m(c, s) <= MERGE_M:
                c["routes"].extend(s["routes"])
                placed = True
                break
        if not placed:
            clusters.append({
                "id": s["id"],
                "name": nm,
                "name_en": norm_en(s["name_en"]),
                "lat": s["lat"],
                "lon": s["lon"],
                "routes": list(s["routes"]),
            })
    return clusters


def fetch_route_stops(route):
    """回傳 [(route, dir, seq, stop_id)]"""
    out = []
    for direction in ("outbound", "inbound"):
        url = f"{BASE}/route-stop/{COMPANY}/{route}/{direction}"
        try:
            data = get_json(url).get("data", [])
        except Exception:
            continue
        for rs in data:
            out.append((route, rs.get("dir"), rs.get("seq"), rs.get("stop")))
    return out


def main():
    routes = [r["route"] for r in get_json(f"{BASE}/route/{COMPANY}").get("data", [])]
    print(f"路線數：{len(routes)}")

    # 1) 並行抓所有路線的站序
    stop_routes = {}  # stop_id -> list of {route, dir, seq}
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch_route_stops, r): r for r in routes}
        done = 0
        for f in as_completed(futs):
            done += 1
            for route, direction, seq, stop_id in f.result():
                stop_routes.setdefault(stop_id, []).append(
                    {"route": route, "dir": direction, "seq": seq}
                )
            if done % 100 == 0:
                print(f"  route-stop {done}/{len(routes)}")
    print(f"不重複站點：{len(stop_routes)}")

    # 2) 並行抓每個站點的座標
    stops = []

    def fetch_stop(sid):
        d = get_json(f"{BASE}/stop/{sid}").get("data", {})
        if not d:
            return None
        return {
            "id": sid,
            "name_tc": d.get("name_tc", ""),
            "name_en": d.get("name_en", ""),
            "lat": float(d.get("lat", 0)),
            "lon": float(d.get("long", 0)),
            "routes": [{**r, "stop": sid} for r in stop_routes.get(sid, [])],
        }

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(fetch_stop, sid) for sid in stop_routes]
        done = 0
        for f in as_completed(futs):
            done += 1
            s = f.result()
            if s:
                stops.append(s)
            if done % 500 == 0:
                print(f"  stop {done}/{len(stop_routes)}")

    merged = merge_stops(stops)
    out = [{
        "id": c["id"],
        "name_tc": c["name"],
        "name_en": c["name_en"],
        "lat": round(c["lat"], 6),
        "lon": round(c["lon"], 6),
        "routes": c["routes"],
    } for c in merged]
    out.sort(key=lambda s: s["name_tc"])

    path = "src/data/citybus-stops.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"stops": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"完成：{len(stops)} 個原始站點 → 合併為 {len(out)} 個站 → {path}")


if __name__ == "__main__":
    main()
