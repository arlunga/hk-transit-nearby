#!/usr/bin/env python3
"""生成 src/data/gmb-stops.json（綠色專線小巴站點 → 路線索引）

資料來源：運輸署綠色小巴開放資料 https://data.etagmb.gov.hk（無 /v1 前綴）

端點：
  GET /route                     → 各區路線編號（HKI/KLN/NT）
  GET /route/{region}/{code}     → route_id + 方向（route_seq 1=去程 / 2=回程，orig/dest）
  GET /route-stop/{route_id}/{route_seq} → 該方向停站（stop_id/name/stop_seq，無座標）
  GET /stop/{stop_id}            → 座標（wgs84 lat/lon）

產出：每站 {id, name_tc, name_en, lat, lon, routes:[{route, route_id, dir, dest_tc, seq}]}
  route     = 路線編號（如 "44"）
  route_id  = 數值路線 ID（查 ETA 用）
  dir       = route_seq（1=去程 / 2=回程）
  dest_tc   = 該方向目的地
  seq       = 停站序

用法：python3 scripts/build-gmb-data.py
"""
import json
import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://data.etagmb.gov.hk"
MERGE_M = 100  # 同名站合併距離（公尺）：同一實體站可能有重複 stop_id，或去回程在馬路兩側


def get_json(url, tries=6):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "hk-transit-builder/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (403, 429):  # 限流 → 退避後重試
                time.sleep(2 + i * 2)
            else:
                time.sleep(0.5)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.5)
    raise last


def dist_m(a, b):
    lat = math.radians((a["lat"] + b["lat"]) / 2)
    dlat = (a["lat"] - b["lat"]) * 111320
    dlon = (a["lon"] - b["lon"]) * 111320 * math.cos(lat)
    return math.hypot(dlat, dlon)


def merge_stops(raw):
    """同名且距離 ≦ MERGE_M 的站合併為一個（同一實體站可能有重複 stop_id）。"""
    merged = []
    for s in sorted(raw, key=lambda x: x["name_tc"]):
        placed = False
        for c in merged:
            if c["name_tc"] == s["name_tc"] and dist_m(c, s) <= MERGE_M:
                c["routes"].extend(s["routes"])
                placed = True
                break
        if not placed:
            merged.append({
                "id": s["id"],
                "name_tc": s["name_tc"],
                "name_en": s["name_en"],
                "lat": s["lat"],
                "lon": s["lon"],
                "routes": list(s["routes"]),
            })
    return merged


def main():
    all_routes = get_json(f"{BASE}/route")["data"]["routes"]
    route_codes = [(region, code) for region, codes in all_routes.items() for code in codes]
    print(f"路線編號：{len(route_codes)} 條（HKI/KLN/NT）")

    # 1) 路線詳情：route_id + 方向
    def route_detail(rc):
        region, code = rc
        try:
            data = get_json(f"{BASE}/route/{region}/{code}")["data"]
            return rc, data
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠ 路線 {region}/{code} 詳情失敗：{e}", file=sys.stderr)
            return rc, []

    details = {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = [ex.submit(route_detail, rc) for rc in route_codes]
        for f in as_completed(futs):
            rc, data = f.result()
            if data:
                details[rc] = data

    print(f"路線詳情：{len(details)} 條")

    # 2) 每個 route_id 的每個方向停站
    stop_routes = {}   # stop_id -> [route entry]
    stop_names = {}    # stop_id -> {name_tc, name_en}

    def route_stops(rc, route_id, route_seq, dest_tc):
        try:
            rs = get_json(f"{BASE}/route-stop/{route_id}/{route_seq}")["data"]["route_stops"]
            return (route_id, route_seq, dest_tc, rs)
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠ route-stop {rc}/{route_id}/{route_seq} 失敗：{e}", file=sys.stderr)
            return None

    tasks = []
    for (region, code), records in details.items():
        for rec in records:
            rid = rec["route_id"]
            for dr in rec.get("directions", []):
                tasks.append((code, rid, dr["route_seq"], dr.get("dest_tc", "")))

    print(f"方向數：{len(tasks)} 個")
    done = 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = [ex.submit(route_stops, *t) for t in tasks]
        for f in as_completed(futs):
            r = f.result()
            done += 1
            if not r:
                continue
            route_id, route_seq, dest_tc, stops = r
            for s in stops:
                sid = s["stop_id"]
                stop_routes.setdefault(sid, []).append({
                    "route": None,  # 稍後回填
                    "route_id": route_id,
                    "dir": route_seq,
                    "dest_tc": (dest_tc or "").strip(),
                    "seq": int(s.get("stop_seq", 0)),
                })
                if sid not in stop_names:
                    stop_names[sid] = {
                        "name_tc": (s.get("name_tc", "") or "").strip(),
                        "name_en": (s.get("name_en", "") or "").strip(),
                    }
            if done % 200 == 0:
                print(f"  停站處理 {done}/{len(tasks)}")

    # route_id → route code 對照
    rid_code = {}
    for (region, code), records in details.items():
        for rec in records:
            rid_code[rec["route_id"]] = code
    for sid, entries in stop_routes.items():
        for e in entries:
            e["route"] = rid_code.get(e["route_id"], "")

    print(f"唯一站點：{len(stop_names)} 個")

    # 3) 站點座標
    stop_ids = list(stop_names.keys())

    def stop_coord(sid):
        try:
            d = get_json(f"{BASE}/stop/{sid}")
            c = d["data"]["coordinates"]["wgs84"]
            return sid, float(c["latitude"]), float(c["longitude"])
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠ stop {sid} 座標失敗：{e}", file=sys.stderr)
            return sid, None, None

    coords = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(stop_coord, sid) for sid in stop_ids]
        for i, f in enumerate(as_completed(futs)):
            sid, lat, lon = f.result()
            if lat is not None:
                coords[sid] = (lat, lon)
            if (i + 1) % 500 == 0:
                print(f"  座標 {i + 1}/{len(stop_ids)}")

    # 4) 組裝輸出
    raw = []
    skipped = 0
    for sid, names in stop_names.items():
        if sid not in coords:
            skipped += 1
            continue
        lat, lon = coords[sid]
        routes = stop_routes.get(sid, [])
        # 去重（同站同路線同方向可能因 route-stop 重複）
        seen = set()
        uniq = []
        for r in routes:
            k = (r["route"], r["dir"], r["dest_tc"])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(r)
        uniq.sort(key=lambda r: (r["route"], r["dir"], r["seq"]))
        raw.append({
            "id": sid,
            "name_tc": names["name_tc"],
            "name_en": names["name_en"],
            "lat": lat,
            "lon": lon,
            "routes": uniq,
        })

    out = merge_stops(raw)
    # 合併後再去重一次 + 定座標精度
    for c in out:
        seen = set()
        uniq = []
        for r in c["routes"]:
            k = (r["route"], r["dir"], r["dest_tc"])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(r)
        uniq.sort(key=lambda r: (r["route"], r["dir"], r["seq"]))
        c["routes"] = uniq
        c["lat"] = round(c["lat"], 6)
        c["lon"] = round(c["lon"], 6)
    out.sort(key=lambda s: s["name_tc"])

    with open("src/data/gmb-stops.json", "w", encoding="utf-8") as f:
        json.dump({"stops": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"完成：{len(raw)} 個原始站 → 合併為 {len(out)} 個站（{skipped} 個缺座標略過）→ src/data/gmb-stops.json")


if __name__ == "__main__":
    main()
