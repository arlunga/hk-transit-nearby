#!/usr/bin/env python3
"""生成 src/data/mtr-stations.json

來源：
  1. Wikipedia《List of MTR stations》— 各重鐵路線的車站 + 3 字母代碼
  2. Wikidata (P1377 港鐵車站代碼) — 中文/英文站名 + 座標

用法：python3 scripts/build-mtr-data.py
輸出：src/data/mtr-stations.json
"""
import json
import re
import urllib.request
import urllib.parse

WIKI_API = "https://en.wikipedia.org/w/api.php"
WD_ENDPOINT = "https://query.wikidata.org/sparql"

LINE_CODES = {
    "East Rail line": "EAL",
    "Kwun Tong line": "KTL",
    "Tsuen Wan line": "TWL",
    "Island line": "ISL",
    "Tung Chung line": "TCL",
    "Airport Express": "AEL",
    "Tseung Kwan O line": "TKL",
    "Tuen Ma line": "TML",
    "Disneyland Resort line": "DRL",
    "South Island line": "SIL",
}

# 2021–2022 新站：Wikidata 尚未完整收錄（EXC 舊碼是 EXH），需手動補
MANUAL = {
    "EXC": {"name_tc": "會展", "name_en": "Exhibition Centre", "lat": 22.2816132, "lon": 114.1756895, "lines": ["EAL"]},
    "TKW": {"name_tc": "土瓜灣", "name_en": "To Kwa Wan", "lat": 22.3169748, "lon": 114.1876486, "lines": ["TML"]},
    "SUW": {"name_tc": "宋皇臺", "name_en": "Sung Wong Toi", "lat": 22.3258, "lon": 114.1914, "lines": ["TML"]},
}


def http_json(url, data=None, headers=None):
    hdrs = {"User-Agent": "hk-transit-builder/1.0 (personal use; contact: local)"}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_wiki_lines():
    q = urllib.parse.urlencode({
        "action": "parse", "page": "List of MTR stations",
        "prop": "wikitext", "format": "json", "formatversion": "2",
    })
    d = http_json(f"{WIKI_API}?{q}")
    wt = d["parse"]["wikitext"]
    parts = re.split(r"^==(.+?)==\s*$", wt, flags=re.M)
    wiki = {}
    for i in range(1, len(parts), 2):
        sec = parts[i].strip()
        if sec not in LINE_CODES:
            continue
        lc = LINE_CODES[sec]
        for row in re.findall(r"^\|(.*)$", parts[i + 1], flags=re.M):
            r = row.strip()
            if r.startswith(("-", "+", "!", "}")):
                continue
            cells = [c.strip() for c in r.split("||")]
            code = next((c for c in cells if re.fullmatch(r"[A-Z]{3}", c)), None)
            if code:
                wiki.setdefault(code, set()).add(lc)
    return wiki


def fetch_wikidata():
    q = """
    SELECT ?code ?zh ?en ?lat ?lon WHERE {
      ?station wdt:P1377 ?code.
      FILTER(REGEX(STR(?code), "^[A-Z]{3}$"))
      ?station wdt:P625 ?coord.
      BIND(geof:latitude(?coord) AS ?lat)
      BIND(geof:longitude(?coord) AS ?lon)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hk,zh-hant,zh". ?station rdfs:label ?zh. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". ?station rdfs:label ?en. }
    }
    """
    body = urllib.parse.urlencode({"query": q}).encode()
    d = http_json(WD_ENDPOINT, data=body, headers={
        "Accept": "application/sparql-results+json",
        "User-Agent": "hk-transit-builder/1.0 (personal use)",
    })
    wd = {}
    for x in d["results"]["bindings"]:
        wd[x["code"]["value"]] = {
            "zh": x.get("zh", {}).get("value", ""),
            "en": x.get("en", {}).get("value", ""),
            "lat": round(float(x["lat"]["value"]), 6),
            "lon": round(float(x["lon"]["value"]), 6),
        }
    return wd


def main():
    wiki = fetch_wiki_lines()
    wd = fetch_wikidata()

    stations = {}
    for code, lines in wiki.items():
        w = wd.get(code)
        if not w:
            print(f"  缺座標，略過: {code}")
            continue
        stations[code] = {
            "code": code,
            "name_tc": w["zh"].rstrip("站"),
            "name_en": re.sub(r"\s+station$", "", w["en"], flags=re.I).strip(),
            "lat": w["lat"],
            "lon": w["lon"],
            "lines": sorted(lines),
        }

    # 手動補新站
    for code, m in MANUAL.items():
        stations.setdefault(code, {"code": code, **m})

    out = {"stations": sorted(stations.values(), key=lambda s: s["code"])}
    path = "src/data/mtr-stations.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"完成：{len(out['stations'])} 個車站 → {path}")


if __name__ == "__main__":
    main()
