#!/usr/bin/env python3
import json, os, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ["RAPIDAPI_PROXY_SECRET"]
ROOT=Path(tempfile.mkdtemp(prefix="fd-econ-"))
NONCE=f"{os.environ.get('GITHUB_RUN_ID','local')}-{os.environ.get('GITHUB_RUN_ATTEMPT','1')}-{time.time_ns()}"
VIDEO_URL="https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4"

def http_json(path,payload,timeout=180):
    req=urllib.request.Request(
        API_URL+path,
        data=json.dumps(payload).encode(),
        headers={"content-type":"application/json","x-rapidapi-proxy-secret":SECRET},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body=e.read().decode("utf-8",errors="replace")
        try:return e.code,json.loads(body)
        except:return e.code,{"error":body}

def plan(payload):
    start=time.time()
    status,data=http_json("/v1/plan",payload)
    return {
        "http":status,
        "seconds":round(time.time()-start,2),
        "modelId":(data.get("meta") or {}).get("modelId"),
        "requestUsage":(data.get("meta") or {}).get("requestUsage"),
        "modelCallCount":(data.get("meta") or {}).get("modelCallCount"),
        "briefEnrichmentUsed":(data.get("meta") or {}).get("briefEnrichmentUsed"),
        "repairUsed":(data.get("meta") or {}).get("automaticRepairUsed"),
        "rescueUsed":(data.get("meta") or {}).get("rescueRewriteUsed"),
        "tournamentUsed":(data.get("meta") or {}).get("candidateTournamentUsed"),
        "guaranteedBlueprintUsed":(data.get("meta") or {}).get("guaranteedBlueprintUsed"),
        "qualityGate":(data.get("meta") or {}).get("qualityGate"),
    }

def prep_video():
    raw=ROOT/"raw.mp4"; out=ROOT/"clip.mp4"
    urllib.request.urlretrieve(VIDEO_URL,raw)
    subprocess.run([
        "ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(raw),
        "-t","12","-an","-vf","scale='if(gt(iw,720),720,iw)':-2",
        "-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p",
        "-movflags","+faststart",str(out)
    ],check=True)
    duration=float(subprocess.run(
        ["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(out)],
        capture_output=True,text=True,check=True
    ).stdout.strip())
    return out,duration

def upload(path):
    size=path.stat().st_size
    st,data=http_json("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
    if st!=200:return st,None
    u=data["upload"]
    req=urllib.request.Request(
        u["uploadUrl"],data=path.read_bytes(),
        headers={"content-type":"video/mp4","content-length":str(size)},method="PUT"
    )
    with urllib.request.urlopen(req,timeout=120) as r: put=r.status
    return put,u["assetId"]

def analyze_fresh(path,duration):
    st,asset=upload(path)
    if st not in (200,201,204): return {"http":st,"error":"upload failed"}
    payload={
        "assetId":asset,
        "platform":"General",
        "objective":"awareness",
        "audience":f"unit-economics-{NONCE}",
        "durationSeconds":duration,
        "context":f"Unit economics benchmark {NONCE}. Audio removed. Judge visible facts only.",
        "requirements":{"mustShow":["motorcycle"],"mustNotShow":["wine bottle"]},
    }
    start=time.time()
    status,data=http_json("/v1/analyze",payload,timeout=240)
    meta=data.get("meta") or {}
    return {
        "http":status,
        "seconds":round(time.time()-start,2),
        "modelId":meta.get("modelId"),
        "primaryUsage":meta.get("usage"),
        "complianceVerificationModelIds":meta.get("complianceVerificationModelIds"),
        "complianceVerificationUsage":meta.get("complianceVerificationUsage"),
        "complianceVerificationRetryUsed":meta.get("complianceVerificationRetryUsed"),
        "analysisRetryUsed":meta.get("analysisRetryUsed"),
        "coverageRetryUsed":meta.get("coverageRetryUsed"),
        "analysisCacheHit":meta.get("analysisCacheHit"),
        "complianceStatus":((data.get("analysis") or {}).get("compliance") or {}).get("status"),
        "qualityGate":((data.get("analysis") or {}).get("qualityGate") or {}).get("action"),
    }

normal=plan({
  "brief":"Create a 15-second vertical launch video for a fictional focus timer app. Open on a distracted desk, show the timer starting, then resolve on focused work and a clean app end frame. Do not invent performance claims.",
  "constraints":{"durationSeconds":15,"platform":"Instagram Reels","aspectRatio":"9:16"},
})
weak=plan({"brief":"make it good"})
video_path,duration=prep_video()
video=analyze_fresh(video_path,duration)

result={"normalPlan":normal,"weakPlan":weak,"freshVideoAnalysis":video}
print("# ForgeDirector live unit-economics usage probe")
print(json.dumps(result,indent=2))

failures=[]
for name,item in result.items():
    if item.get("http")!=200: failures.append(f"{name}: HTTP {item.get('http')}")
if not normal.get("requestUsage"): failures.append("normalPlan: missing requestUsage")
if not weak.get("requestUsage"): failures.append("weakPlan: missing requestUsage")
if not video.get("primaryUsage"): failures.append("freshVideoAnalysis: missing primaryUsage")
if not video.get("complianceVerificationUsage"): failures.append("freshVideoAnalysis: missing complianceVerificationUsage")
if video.get("analysisCacheHit") is not False: failures.append("freshVideoAnalysis: expected fresh cache miss")
if video.get("complianceStatus")!="pass": failures.append(f"freshVideoAnalysis compliance={video.get('complianceStatus')}")

with open("/tmp/unit-economics-results.json","w") as f: json.dump(result,f,indent=2)
with open("/tmp/unit-economics-summary.md","w") as f:
    f.write("# ForgeDirector unit-economics usage probe\n\n")
    f.write(f"- Normal plan tokens: {(normal.get('requestUsage') or {}).get('totalTokens')}\n")
    f.write(f"- Weak plan tokens: {(weak.get('requestUsage') or {}).get('totalTokens')}\n")
    p=(video.get('primaryUsage') or {}).get('totalTokens') or 0
    v=(video.get('complianceVerificationUsage') or {}).get('totalTokens') or 0
    f.write(f"- Fresh video primary tokens: {p}\n")
    f.write(f"- Fresh video verifier tokens: {v}\n")
    f.write(f"- Fresh video total observed tokens: {p+v}\n")
    f.write(f"- Result: {'PASS' if not failures else 'FAIL'}\n")
if failures:
    print("## Failures")
    for x in failures: print("-",x)
raise SystemExit(2 if failures else 0)
