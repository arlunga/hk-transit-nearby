#!/usr/bin/env python3
"""生成 src/data/kmb-stops.json

九巴有完整站表與 route-stop 端點，各一次抓取後反轉成「站點 → 路線」索引。
再把「同名 + 50 米內」的多個 stop ID 合併成一個站（九巴會把同一站拆成多個站柱）。

產出：每個站點 {id, name_tc, name_en, lat, lon, routes:[{route, bound, service_type, dest_tc, stop}]}
  route.stop = 該路線實際查 ETA 用的 stop ID。

用法：python3 scripts/build-kmb-data.py
"""
import json
import math
import re
import urllib.request

BASE = "https://data.etabus.gov.hk/v1/transport/kmb"
MERGE_M = 50  # 合併距離（公尺）


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "hk-transit-builder/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
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


def main():
    routes = get_json(f"{BASE}/route/")["data"]
    stops = get_json(f"{BASE}/stop/")["data"]
    route_stops = get_json(f"{BASE}/route-stop/")["data"]
    print(f"路線 {len(routes)} / 站點 {len(stops)} / route-stop {len(route_stops)}")

    # route+bound+service_type -> dest_tc
    dest = {}
    for r in routes:
        dest[(r["route"], r["bound"], str(r["service_type"]))] = r.get("dest_tc", "")

    # stop_id -> routes（每條路線記住自己的 stop id）
    stop_routes = {}
    for rs in route_stops:
        key = (rs["route"], rs["bound"], str(rs["service_type"]))
        stop_routes.setdefault(rs["stop"], []).append({
            "route": rs["route"],
            "bound": rs["bound"],
            "service_type": rs["service_type"],
            "dest_tc": dest.get(key, ""),
        })

    raw = []
    for s in stops:
        sid = s["stop"]
        raw.append({
            "id": sid,
            "name_tc": s.get("name_tc", ""),
            "name_en": s.get("name_en", ""),
            "lat": float(s.get("lat", 0)),
            "lon": float(s.get("long", 0)),
            "routes": [
                {**r, "stop": sid} for r in stop_routes.get(sid, [])
            ],
        })

    merged = merge_stops(raw)
    out = [{
        "id": c["id"],
        "name_tc": c["name"],
        "name_en": c["name_en"],
        "lat": round(c["lat"], 6),
        "lon": round(c["lon"], 6),
        "routes": c["routes"],
    } for c in merged]
    out.sort(key=lambda s: s["name_tc"])

    with open("src/data/kmb-stops.json", "w", encoding="utf-8") as f:
        json.dump({"stops": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"完成：{len(raw)} 個原始站點 → 合併為 {len(out)} 個站 → src/data/kmb-stops.json")


if __name__ == "__main__":
    main()
