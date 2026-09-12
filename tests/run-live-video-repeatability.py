#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ["RAPIDAPI_PROXY_SECRET"]
ROOT=Path(tempfile.mkdtemp(prefix="fd-video-repeat-"))

SOURCES=[
    {
        "name":"motorcycle",
        "url":"https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4",
        "requirements":{"mustShow":["motorcycle"],"mustNotShow":["wine bottle"]},
        "expected":[("mustShow","motorcycle","pass"),("mustNotShow","wine bottle","pass")],
        "gateNot":"accept-never-required",
    },
    {
        "name":"wine",
        "url":"https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/wine-label/sample-output/assets/05-hero.mp4",
        "requirements":{"mustShow":["wine bottle"],"mustNotShow":["motorcycle"]},
        "expected":[("mustShow","wine bottle","pass"),("mustNotShow","motorcycle","pass")],
    },
    {
        "name":"camber-tumbler",
        "url":"https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-tumbler-ugc-10s.mp4",
        "requirements":{"mustShow":["person","insulated coffee tumbler"],"mustNotShow":["gooseneck kettle"]},
        "expected":[("mustShow","person","pass"),("mustShow","insulated coffee tumbler","pass"),("mustNotShow","gooseneck kettle","pass")],
    },
    {
        "name":"camber-kettle",
        "url":"https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-kettle-ugc-10s.mp4",
        "requirements":{"mustShow":["person","gooseneck pour-over kettle"],"mustNotShow":["hand coffee grinder"]},
        "expected":[("mustShow","person","pass"),("mustShow","gooseneck pour-over kettle","pass"),("mustNotShow","hand coffee grinder","pass")],
    },
]

RUNS_PER_CASE=3

def http_json(path,payload,timeout=120):
    data=json.dumps(payload).encode()
    req=urllib.request.Request(
        API_URL+path,
        data=data,
        headers={"content-type":"application/json","x-rapidapi-proxy-secret":SECRET},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body=e.read().decode("utf-8",errors="replace")
        try: parsed=json.loads(body)
        except Exception: parsed={"error":body}
        return e.code,parsed

def download_normalize(item):
    raw=ROOT/(item["name"]+"-raw.mp4")
    out=ROOT/(item["name"]+".mp4")
    urllib.request.urlretrieve(item["url"],raw)
    subprocess.run([
        "ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(raw),
        "-t","12","-an","-vf","scale='if(gt(iw,720),720,iw)':-2",
        "-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p","-movflags","+faststart",str(out)
    ],check=True)
    return out

def upload(path):
    size=path.stat().st_size
    status,data=http_json("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
    if status!=200:
        return status,None,data
    u=data["upload"]
    payload=path.read_bytes()
    req=urllib.request.Request(
        u["uploadUrl"],data=payload,
        headers={"content-type":"video/mp4","content-length":str(size)},method="PUT"
    )
    try:
        with urllib.request.urlopen(req,timeout=120) as r:
            put_status=r.status
    except urllib.error.HTTPError as e:
        return e.code,None,{"error":"PUT failed"}
    if put_status not in (200,201,204):
        return put_status,None,{"error":"PUT failed"}
    return 200,u["assetId"],data

def find_check(analysis,typ,rule):
    for check in (analysis.get("compliance") or {}).get("checks",[]):
        if check.get("type")==typ and check.get("rule")==rule:
            return check.get("status")
    return "missing"

rows=[]
failures=[]
for item in SOURCES:
    path=download_normalize(item)
    for run in range(1,RUNS_PER_CASE+1):
        us,asset,_=upload(path)
        if us!=200:
            rows.append((item["name"],run,us,"upload-fail","-","-"))
            failures.append(f"{item['name']} run {run}: upload failed HTTP {us}")
            continue
        probe=subprocess.run(
            ["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(path)],
            capture_output=True,text=True,check=True,
        )
        duration=float(probe.stdout.strip())
        payload={
            "assetId":asset,
            "platform":"General",
            "objective":"awareness",
            "durationSeconds":duration,
            "context":"Repeatability benchmark. Audio removed. Judge visible facts only across the entire clip.",
            "requirements":item["requirements"],
        }
        start=time.time()
        status,result=http_json("/v1/analyze",payload,timeout=180)
        elapsed=round(time.time()-start,2)
        if status!=200:
            rows.append((item["name"],run,status,"analyze-fail","-",elapsed))
            failures.append(f"{item['name']} run {run}: HTTP {status} {result.get('error','')}")
            continue
        analysis=result.get("analysis") or {}
        mismatches=[]
        for typ,rule,expected in item["expected"]:
            actual=find_check(analysis,typ,rule)
            if actual!=expected:
                mismatches.append(f"{typ}:{rule}={actual}, expected {expected}")
        spoken=(analysis.get("hook") or {}).get("spokenHook")
        timeline_speech=[x.get("speech") for x in analysis.get("timeline",[]) if x.get("speech")]
        speech_clean=not spoken and not timeline_speech
        if mismatches:
            failures.append(f"{item['name']} run {run}: "+ "; ".join(mismatches))
        if not speech_clean:
            failures.append(f"{item['name']} run {run}: hallucinated speech")
        coverage=(analysis.get("coverage") or {})
        coverage_ok=coverage.get("fullDurationReviewed") is True
        if not coverage_ok:
            failures.append(
                f"{item['name']} run {run}: incomplete duration coverage "
                f"{coverage.get('observedThroughSeconds')}/{coverage.get('declaredDurationSeconds')}"
            )
        gate=(analysis.get("qualityGate") or {}).get("action")
        verdict="pass" if (not mismatches and speech_clean and coverage_ok) else "FAIL"
        rows.append((item["name"],run,status,verdict,gate,elapsed))

print("# ForgeDirector video QA repeatability benchmark")
print()
print("| Clip | Run | HTTP | Compliance | Gate | Seconds |")
print("|---|---:|---:|---|---|---:|")
for row in rows:
    print(f"| {row[0]} | {row[1]} | {row[2]} | {row[3]} | {row[4]} | {row[5]} |")
print()
if failures:
    print("## Failures")
    for f in failures: print(f"- {f}")
else:
    print("## Result")
    print(f"- PASS: {len(rows)}/{len(rows)} repeated real-video analyses met compliance, no-speech, and full-duration coverage requirements.")

with open("/tmp/video-repeatability-summary.md","w") as f:
    f.write("# ForgeDirector video QA repeatability\n\n")
    f.write(f"- Calls: {len(rows)}\n- Failures: {len(failures)}\n- Result: {'PASS' if not failures else 'FAIL'}\n")

raise SystemExit(2 if failures else 0)
