#!/usr/bin/env python3
import concurrent.futures
import json
import os
import statistics
import time
import urllib.error
import urllib.request

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ.get("RAPIDAPI_PROXY_SECRET","")
HEADERS={"content-type":"application/json"}
if SECRET:
    HEADERS["x-rapidapi-proxy-secret"]=SECRET

NORMAL={
  "brief":"Create a 15-second vertical launch video for a fictional focus timer app. Open on a distracted desk, show the timer starting, then resolve on focused work and a clean app end frame. Do not invent performance claims.",
  "constraints":{"durationSeconds":15,"platform":"Instagram Reels","aspectRatio":"9:16"}
}
WEAK={"brief":"make it good"}
EMPTY={}

def call(payload):
    body=json.dumps(payload).encode()
    req=urllib.request.Request(API_URL+"/v1/plan",data=body,headers=HEADERS,method="POST")
    start=time.time()
    try:
        with urllib.request.urlopen(req,timeout=120) as r:
            data=json.loads(r.read().decode())
            status=r.status
    except urllib.error.HTTPError as e:
        status=e.code
        try:data=json.loads(e.read().decode())
        except Exception:data={}
    except Exception as e:
        return {"status":0,"seconds":round(time.time()-start,2),"error":str(e)}
    elapsed=round(time.time()-start,2)
    meta=data.get("meta") or {}
    return {
      "status":status,
      "seconds":elapsed,
      "qa":(data.get("qa") or {}).get("score"),
      "creative":(meta.get("creativeQuality") or {}).get("score"),
      "repair":meta.get("automaticRepairUsed"),
      "rescue":meta.get("rescueRewriteUsed"),
      "tournament":meta.get("candidateTournamentUsed"),
      "guaranteed":meta.get("guaranteedBlueprintUsed"),
      "fallback":meta.get("degradedFallbackUsed"),
    }

def summarize(label,rows):
    secs=[r["seconds"] for r in rows]
    ordered=sorted(secs)
    p50=statistics.median(ordered)
    p95=ordered[min(len(ordered)-1,max(0,int(len(ordered)*0.95)-1))]
    ok=sum(1 for r in rows if r.get("status")==200 and (r.get("qa") or 0)>=90)
    creative=[r.get("creative") for r in rows if r.get("creative") is not None]
    print(f"| {label} | {len(rows)} | {ok}/{len(rows)} | {p50:.2f} | {p95:.2f} | {max(secs):.2f} | {min(creative) if creative else '-'} |")
    return {"label":label,"count":len(rows),"ok":ok,"p50":p50,"p95":p95,"max":max(secs),"minCreative":min(creative) if creative else None}

groups=[]
for label,payload,count in [
    ("normal-sequential",NORMAL,4),
    ("weak-sequential",WEAK,4),
    ("empty-sequential",EMPTY,3),
]:
    rows=[call(payload) for _ in range(count)]
    groups.append((label,rows))

concurrent_payloads=[NORMAL,NORMAL,NORMAL,NORMAL,WEAK,WEAK,EMPTY,EMPTY]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    concurrent_rows=list(ex.map(call,concurrent_payloads))
groups.append(("mixed-concurrent-8",concurrent_rows))

print("# ForgeDirector latency + concurrency benchmark")
print()
print("| Group | Calls | Successful quality responses | p50 s | p95 s | max s | min creative |")
print("|---|---:|---:|---:|---:|---:|---:|")
summaries=[summarize(label,rows) for label,rows in groups]

print()
print("## Individual calls")
for label,rows in groups:
    print(f"### {label}")
    for i,row in enumerate(rows,1):
        print(f"- {i}: {json.dumps(row,sort_keys=True)}")

failures=[]
for label,rows in groups:
    for idx,row in enumerate(rows,1):
        if row.get("status")!=200:
            failures.append(f"{label} call {idx} HTTP {row.get('status')}")
        elif (row.get("qa") or 0)<90:
            failures.append(f"{label} call {idx} QA {row.get('qa')}")
        elif row.get("creative") is not None and row["creative"]<85:
            failures.append(f"{label} call {idx} creative {row['creative']}")

normal=next(x for x in summaries if x["label"]=="normal-sequential")
concurrent=next(x for x in summaries if x["label"]=="mixed-concurrent-8")
if normal["p95"]>20:
    failures.append(f"normal sequential p95 too slow: {normal['p95']}s")
if concurrent["p95"]>45:
    failures.append(f"concurrent p95 too slow: {concurrent['p95']}s")

print()
if failures:
    print("## Failures")
    for f in failures: print(f"- {f}")
else:
    print("## Result")
    print("- PASS: quality, reliability, and initial latency/concurrency thresholds met.")

with open("/tmp/performance-summary.md","w") as f:
    f.write("# ForgeDirector latency + concurrency benchmark\n\n")
    for s in summaries:
        f.write(f"- {s['label']}: {s['ok']}/{s['count']} success, p50 {s['p50']:.2f}s, p95 {s['p95']:.2f}s, max {s['max']:.2f}s\n")
    f.write(f"- Result: {'PASS' if not failures else 'FAIL'}\n")

raise SystemExit(2 if failures else 0)
