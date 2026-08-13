#!/usr/bin/env python3
"""生成 src/data/mtr-bus-stops.json（港鐵巴士／接駁巴士站點 → 路線索引）

資料來源：港鐵開放資料平台靜態 CSV
  https://opendata.mtr.com.hk/data/mtr_bus_routes.csv
  https://opendata.mtr.com.hk/data/mtr_bus_stops.csv

到站 API（POST）：https://rt.data.gov.hk/v1/transport/mtr/bus/getSchedule
  body: {"language":"zh","routeName":"K51"} → busStop[].bus[]（含 lineRef / arrivalTimeInSecond）

產出：
  stops = [{id, name_tc, name_en, lat, lon, routes:[{route, dir, dest_tc, stop, seq}]}]
    route  = ROUTE_ID（POST 的 routeName）
    stop   = STATION_ID（回傳 busStopId，同一實體站可能有多個 route 專屬站 ID）
    dir    = O/I；dest_tc = 該方向目的地
  lineRefs = { lineRef → dest_tc }（ETD 的 bus.lineRef 對照目的地）

同一實體站（同名 + 同座標）會被合併成一個站，routes 保留各自 route 專屬的 stop ID。

用法：python3 scripts/build-mtr-bus-data.py
"""
import csv
import io
import json
import math
import re
import urllib.request

ROUTES_URL = "https://opendata.mtr.com.hk/data/mtr_bus_routes.csv"
STOPS_URL = "https://opendata.mtr.com.hk/data/mtr_bus_stops.csv"
MERGE_M = 100  # 合併距離（公尺）：同一實體站去回程常在馬路兩側（>50m），同名站合併


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "hk-transit-builder/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8-sig")


def parse_csv(text):
    return list(csv.DictReader(io.StringIO(text)))


def split_name(name):
    """把「A至B(循環線)」拆成 (orig=A, dest=B)；無「至」者原樣返回。"""
    name = (name or "").strip()
    if "至" in name:
        orig, dest = name.split("至", 1)
    else:
        orig, dest = name, name
    dest = re.sub(r"\s*\(?\s*循環線\s*\)?\s*$", "", dest).strip()
    return orig.strip(), dest


def dist_m(a, b):
    lat = math.radians((a["lat"] + b["lat"]) / 2)
    dlat = (a["lat"] - b["lat"]) * 111320
    dlon = (a["lon"] - b["lon"]) * 111320 * math.cos(lat)
    return math.hypot(dlat, dlon)


def main():
    route_rows = parse_csv(get(ROUTES_URL))
    stop_rows = parse_csv(get(STOPS_URL))
    print(f"路線 {len(route_rows)} 條 / 停站 {len(stop_rows)} 筆")

    routes = {(r["ROUTE_ID"], r["REFERENCE_ID"]): r for r in route_rows}

    # lineRef → 目的地（含所有變體）
    line_refs = {}
    for r in route_rows:
        orig, dest = split_name(r["ROUTE_NAME_CHI"])
        up = (r.get("LINE_UP") or "").strip()
        dn = (r.get("LINE_DOWN") or "").strip()
        if up:
            line_refs[up] = dest
        if dn:
            line_refs[dn] = orig

    # 原始站點（每筆停站一行）→ 再依同名同座標合併
    raw = {}
    for s in stop_rows:
        rid = s["ROUTE_ID"]
        ref = s["REFERENCE_ID"]
        sid = s["STATION_ID"]
        rrow = routes.get((rid, ref))
        orig, dest = split_name(rrow["ROUTE_NAME_CHI"]) if rrow else ("", "")
        direction = s["DIRECTION"]
        dest_tc = dest if direction == "O" else orig

        lat = float(s["STATION_LATITUDE"])
        lon = float(s["STATION_LONGITUDE"])
        key = sid
        raw[key] = {
            "id": sid,
            "name_tc": (s["STATION_NAME_CHI"] or "").strip(),
            "name_en": (s["STATION_NAME_ENG"] or "").strip(),
            "lat": lat,
            "lon": lon,
            "routes": raw.get(key, {}).get("routes", []) if key in raw else [],
        }
        raw[key]["routes"].append({
            "route": rid,
            "dir": direction,
            "dest_tc": dest_tc,
            "stop": sid,
            "seq": int(s["STATION_SEQNO"]),
        })

    # 合併同名同座標（同一實體站多個 route 專屬站 ID）
    merged = []
    for sid in sorted(raw):
        st = raw[sid]
        placed = False
        for c in merged:
            if c["name_tc"] == st["name_tc"] and dist_m(c, st) <= MERGE_M:
                c["routes"].extend(st["routes"])
                placed = True
                break
        if not placed:
            merged.append(st)

    for c in merged:
        c["lat"] = round(c["lat"], 6)
        c["lon"] = round(c["lon"], 6)
        # 去重（同路線同方向同目的地）
        seen, uniq = set(), []
        for r in c["routes"]:
            k = (r["route"], r["dir"], r["dest_tc"])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(r)
        uniq.sort(key=lambda r: (r["route"], r["dir"], r["seq"]))
        c["routes"] = uniq
    merged.sort(key=lambda s: s["name_tc"])

    out = {"stops": merged, "lineRefs": line_refs}
    with open("src/data/mtr-bus-stops.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"完成：{len(raw)} 個原始站 ID → 合併為 {len(merged)} 個站 → src/data/mtr-bus-stops.json")


if __name__ == "__main__":
    main()
