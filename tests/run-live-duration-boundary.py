#!/usr/bin/env python3
import json, os, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ["RAPIDAPI_PROXY_SECRET"]
ROOT=Path(tempfile.mkdtemp(prefix="fd-duration-boundary-"))
NONCE=f"{os.environ.get('GITHUB_RUN_ID','local')}-{os.environ.get('GITHUB_RUN_ATTEMPT','1')}-{time.time_ns()}"
SOURCE_URL="https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4"
DURATIONS=[90,120]

def http_json(path,payload,timeout=180):
    req=urllib.request.Request(API_URL+path,data=json.dumps(payload).encode(),headers={
        "content-type":"application/json","x-rapidapi-proxy-secret":SECRET
    },method="POST")
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body=e.read().decode("utf-8",errors="replace")
        try:return e.code,json.loads(body)
        except:return e.code,{"error":body}
    except Exception as e:
        return 0,{"error":str(e)}

def prepare(duration):
    raw=ROOT/"raw.mp4"
    if not raw.exists(): urllib.request.urlretrieve(SOURCE_URL,raw)
    out=ROOT/f"clip-{duration}.mp4"
    subprocess.run([
        "ffmpeg","-hide_banner","-loglevel","error","-y","-stream_loop","-1","-i",str(raw),
        "-t",str(duration),"-an","-vf","scale='if(gt(iw,720),720,iw)':-2",
        "-c:v","libx264","-preset","veryfast","-crf","26","-pix_fmt","yuv420p",
        "-movflags","+faststart",str(out)
    ],check=True)
    return out,float(duration)

def upload(path):
    size=path.stat().st_size
    st,data=http_json("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
    if st!=200:return st,None
    u=data["upload"]
    req=urllib.request.Request(u["uploadUrl"],data=path.read_bytes(),headers={
        "content-type":"video/mp4","content-length":str(size)
    },method="PUT")
    with urllib.request.urlopen(req,timeout=180) as r: put=r.status
    return put,u["assetId"]

def run(duration):
    path,actual=prepare(duration)
    st,asset=upload(path)
    if st not in (200,201,204): return {"durationSeconds":duration,"http":st,"error":"upload failed"}
    payload={
      "assetId":asset,"platform":"General","objective":"awareness",
      "audience":f"duration-boundary-{duration}-{NONCE}","durationSeconds":actual,
      "context":f"Duration boundary benchmark {duration}s {NONCE}. Audio removed. Judge visible facts only across the entire clip.",
      "requirements":{"mustShow":["motorcycle"],"mustNotShow":["wine bottle"]},
    }
    started=time.time()
    status,data=http_json("/v1/analyze",payload,timeout=180)
    elapsed=round(time.time()-started,2)
    meta=data.get("meta") or {}; analysis=data.get("analysis") or {}
    primary=meta.get("usage") or {}; verifier=meta.get("complianceVerificationUsage") or {}
    combined={
      "inputTokens":int(primary.get("inputTokens") or 0)+int(verifier.get("inputTokens") or 0),
      "outputTokens":int(primary.get("outputTokens") or 0)+int(verifier.get("outputTokens") or 0),
    }
    combined["totalTokens"]=combined["inputTokens"]+combined["outputTokens"]
    cost=(combined["inputTokens"]/1_000_000*0.80)+(combined["outputTokens"]/1_000_000*3.20)
    return {
      "durationSeconds":duration,"fileBytes":path.stat().st_size,"http":status,"seconds":elapsed,
      "error":data.get("error"),"primaryUsage":primary,"verificationUsage":verifier,
      "combinedUsage":combined,"allNovaProCostCeilingUsd":round(cost,6),
      "complianceStatus":(analysis.get("compliance") or {}).get("status"),
      "coverage":analysis.get("coverage"),"gate":(analysis.get("qualityGate") or {}).get("action"),
    }

results=[run(d) for d in DURATIONS]
print("# ForgeDirector 90s/120s boundary benchmark")
print(json.dumps(results,indent=2))
with open("/tmp/duration-boundary.json","w") as f: json.dump(results,f,indent=2)
with open("/tmp/duration-boundary.md","w") as f:
    f.write("# ForgeDirector 90s/120s duration boundary\n\n")
    f.write("| Duration | HTTP | Seconds | Total tokens | All-Pro ceiling | Compliance | Full coverage |\n")
    f.write("|---:|---:|---:|---:|---:|---|---|\n")
    for r in results:
        u=r.get("combinedUsage") or {}; cov=r.get("coverage") or {}
        f.write(f"| {r['durationSeconds']}s | {r.get('http')} | {r.get('seconds')} | {u.get('totalTokens',0)} | ${r.get('allNovaProCostCeilingUsd',0):.4f} | {r.get('complianceStatus') or '-'} | {cov.get('fullDurationReviewed')} |\n")
# This is diagnostic: don't hide a boundary failure by crashing before evidence upload.
raise SystemExit(0)
