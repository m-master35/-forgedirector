#!/usr/bin/env python3
import json, os, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ["RAPIDAPI_PROXY_SECRET"]
ROOT=Path(tempfile.mkdtemp(prefix="fd-duration-econ-"))
NONCE=f"{os.environ.get('GITHUB_RUN_ID','local')}-{os.environ.get('GITHUB_RUN_ATTEMPT','1')}-{time.time_ns()}"
SOURCE_URL="https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4"
DURATIONS=[12,30,60]

def http_json(path,payload,timeout=300):
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

def prepare(duration):
    raw=ROOT/"raw.mp4"
    if not raw.exists():
        urllib.request.urlretrieve(SOURCE_URL,raw)
    out=ROOT/f"clip-{duration}.mp4"
    subprocess.run([
        "ffmpeg","-hide_banner","-loglevel","error","-y",
        "-stream_loop","-1","-i",str(raw),"-t",str(duration),"-an",
        "-vf","scale='if(gt(iw,720),720,iw)':-2",
        "-c:v","libx264","-preset","veryfast","-crf","25","-pix_fmt","yuv420p",
        "-movflags","+faststart",str(out)
    ],check=True)
    actual=float(subprocess.run(
        ["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(out)],
        capture_output=True,text=True,check=True
    ).stdout.strip())
    return out,actual

def upload(path):
    size=path.stat().st_size
    st,data=http_json("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
    if st!=200:return st,None
    u=data["upload"]
    req=urllib.request.Request(
        u["uploadUrl"],data=path.read_bytes(),
        headers={"content-type":"video/mp4","content-length":str(size)},method="PUT"
    )
    with urllib.request.urlopen(req,timeout=180) as r: put=r.status
    return put,u["assetId"]

def analyze(duration):
    path,actual=prepare(duration)
    st,asset=upload(path)
    if st not in (200,201,204):
        return {"durationSeconds":duration,"http":st,"error":"upload failed"}
    payload={
        "assetId":asset,
        "platform":"General",
        "objective":"awareness",
        "audience":f"duration-cost-{duration}-{NONCE}",
        "durationSeconds":actual,
        "context":f"Fresh duration cost benchmark {duration}s {NONCE}. Audio removed. Judge visible facts only across the entire clip.",
        "requirements":{"mustShow":["motorcycle"],"mustNotShow":["wine bottle"]},
    }
    start=time.time()
    status,data=http_json("/v1/analyze",payload,timeout=300)
    meta=data.get("meta") or {}
    analysis=data.get("analysis") or {}
    primary=meta.get("usage") or {}
    verifier=meta.get("complianceVerificationUsage") or {}
    totals={
        "inputTokens":int(primary.get("inputTokens") or 0)+int(verifier.get("inputTokens") or 0),
        "outputTokens":int(primary.get("outputTokens") or 0)+int(verifier.get("outputTokens") or 0),
        "totalTokens":int(primary.get("totalTokens") or 0)+int(verifier.get("totalTokens") or 0),
    }
    # Deliberately conservative: price every token at Nova Pro standard pricing.
    cost=(totals["inputTokens"]/1_000_000*0.80)+(totals["outputTokens"]/1_000_000*3.20)
    return {
        "durationSeconds":duration,
        "actualDurationSeconds":actual,
        "fileBytes":path.stat().st_size,
        "http":status,
        "seconds":round(time.time()-start,2),
        "modelId":meta.get("modelId"),
        "primaryUsage":primary,
        "complianceVerificationModelIds":meta.get("complianceVerificationModelIds"),
        "complianceVerificationUsage":verifier,
        "combinedUsage":totals,
        "allNovaProCostCeilingUsd":round(cost,6),
        "analysisCacheHit":meta.get("analysisCacheHit"),
        "complianceStatus":(analysis.get("compliance") or {}).get("status"),
        "coverage":analysis.get("coverage"),
        "qualityGate":(analysis.get("qualityGate") or {}).get("action"),
    }

results=[analyze(d) for d in DURATIONS]
print("# ForgeDirector duration unit-economics benchmark")
print(json.dumps(results,indent=2))
failures=[]
for r in results:
    if r.get("http")!=200: failures.append(f"{r['durationSeconds']}s HTTP {r.get('http')}")
    if r.get("analysisCacheHit") is not False: failures.append(f"{r['durationSeconds']}s was not a fresh cache miss")
    if r.get("complianceStatus")!="pass": failures.append(f"{r['durationSeconds']}s compliance={r.get('complianceStatus')}")
    if not (r.get("coverage") or {}).get("fullDurationReviewed"): failures.append(f"{r['durationSeconds']}s incomplete duration coverage")
with open("/tmp/duration-unit-economics.json","w") as f: json.dump(results,f,indent=2)
with open("/tmp/duration-unit-economics.md","w") as f:
    f.write("# ForgeDirector duration unit economics\n\n")
    f.write("| Duration | Input tokens | Output tokens | Total tokens | All-Nova-Pro ceiling | Seconds |\n")
    f.write("|---:|---:|---:|---:|---:|---:|\n")
    for r in results:
        u=r.get("combinedUsage") or {}
        f.write(f"| {r['durationSeconds']}s | {u.get('inputTokens')} | {u.get('outputTokens')} | {u.get('totalTokens')} | ${r.get('allNovaProCostCeilingUsd',0):.4f} | {r.get('seconds')} |\n")
    f.write(f"\nResult: {'PASS' if not failures else 'FAIL'}\n")
if failures:
    print("## Failures")
    for x in failures: print("-",x)
raise SystemExit(2 if failures else 0)
