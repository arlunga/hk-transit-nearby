#!/usr/bin/env python3
"""生成 src/data/tmr-interchange.json（屯門公路轉車站轉乘表）

不重新抓 API，直接讀已產生的 src/data/kmb-stops.json，篩出「屯門公路轉車站」系列站柱，
建立「方向 × 路線 → 站柱 ID」對應，供前端查該路線在轉車站的 ETA。

方向：O = 往九龍／市區，I = 往屯門。
每個站柱只回傳單一方向，故月台站（名字含 "(A"／"(B"／"(C"）優先於無後綴的主站。

用法：python3 scripts/build-tmr-interchange.py
"""
import json

DIR_LABELS = {"O": "往九龍／市區", "I": "往屯門"}


def is_platform(name):
    return "(" in name


def main():
    with open("src/data/kmb-stops.json", encoding="utf-8") as f:
        kmb = json.load(f)["stops"]

    interchange = [s for s in kmb if s["name_tc"].startswith("屯門公路轉車站")]
    print(f"轉車站相關站柱：{len(interchange)} 個")

    # 兩階段：先無後綴主站設預設值，再讓月台站覆寫（平台站優先）
    # 每個 route 存 {stop, service_type}；service_type 優先取 1（一般班次）
    def info(r):
        return {
            "stop": r["stop"],
            "service_type": int(r.get("service_type", 1) or 1),
            "seq": int(r.get("seq", 0) or 0),
            "dest_tc": r.get("dest_tc", ""),
        }

    stops = {"O": {}, "I": {}}
    for s in interchange:
        if is_platform(s["name_tc"]):
            continue
        for r in s["routes"]:
            if r["bound"] in stops and r["route"] not in stops[r["bound"]]:
                stops[r["bound"]][r["route"]] = info(r)
    for s in interchange:
        if not is_platform(s["name_tc"]):
            continue
        for r in s["routes"]:
            if r["bound"] not in stops:
                continue
            cur = stops[r["bound"]].get(r["route"])
            # 平台站優先；若兩者皆平台站，保留 service_type == 1 的那個
            if cur is None or cur.get("service_type") != 1:
                stops[r["bound"]][r["route"]] = info(r)

    directions = {
        d: {"label": DIR_LABELS[d], "stops": stops[d]}
        for d in ("O", "I")
    }
    out = {"name": "屯門公路轉車站", "directions": directions}

    with open("src/data/tmr-interchange.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    for d in ("O", "I"):
        routes = sorted(stops[d], key=lambda r: (int(r) if r.isdigit() else 10**9, r))
        print(f"{DIR_LABELS[d]}：{len(routes)} 條路線")
        print("  " + " ".join(routes))
    print("→ src/data/tmr-interchange.json")


if __name__ == "__main__":
    main()
