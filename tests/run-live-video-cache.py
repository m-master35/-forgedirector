#!/usr/bin/env python3
import json, os, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ["RAPIDAPI_PROXY_SECRET"]
ROOT=Path(tempfile.mkdtemp(prefix="fd-cache-"))
BENCH_NONCE=f"{os.environ.get('GITHUB_RUN_ID','local')}-{os.environ.get('GITHUB_RUN_ATTEMPT','1')}-{time.time_ns()}"
URL="https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4"

def http_json(path,payload,timeout=180):
    req=urllib.request.Request(API_URL+path,data=json.dumps(payload).encode(),headers={"content-type":"application/json","x-rapidapi-proxy-secret":SECRET},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body=e.read().decode("utf-8",errors="replace")
        try:return e.code,json.loads(body)
        except:return e.code,{"error":body}

def prep():
    raw=ROOT/"raw.mp4"; out=ROOT/"clip.mp4"
    urllib.request.urlretrieve(URL,raw)
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(raw),"-t","12","-an","-vf","scale='if(gt(iw,720),720,iw)':-2","-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p","-movflags","+faststart",str(out)],check=True)
    duration=float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(out)],capture_output=True,text=True,check=True).stdout.strip())
    return out,duration

def upload(path):
    size=path.stat().st_size
    st,data=http_json("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
    if st!=200:return st,None
    u=data["upload"]
    req=urllib.request.Request(u["uploadUrl"],data=path.read_bytes(),headers={"content-type":"video/mp4","content-length":str(size)},method="PUT")
    with urllib.request.urlopen(req,timeout=120) as r:put=r.status
    return put,u["assetId"]

def analyze(path,duration):
    st,asset=upload(path)
    if st not in (200,201,204): return st,{},0
    payload={
      "assetId":asset,
      "platform":"General",
      "objective":"awareness",
      "durationSeconds":duration,
      "context":f"Cache idempotence benchmark {BENCH_NONCE}. Audio removed. Judge visible facts only across the entire clip.",
      "requirements":{"mustShow":["motorcycle"],"mustNotShow":["wine bottle"]},
    }
    start=time.time(); status,data=http_json("/v1/analyze",payload,timeout=180)
    return status,data,round(time.time()-start,2)

path,duration=prep()
s1,d1,t1=analyze(path,duration)
s2,d2,t2=analyze(path,duration)

a1=d1.get("analysis"); a2=d2.get("analysis")
m1=d1.get("meta") or {}; m2=d2.get("meta") or {}
u2=m2.get("usage") or {}
same=json.dumps(a1,sort_keys=True,separators=(",",":"))==json.dumps(a2,sort_keys=True,separators=(",",":"))
zero_usage=(int(u2.get("inputTokens") or 0)==0 and int(u2.get("outputTokens") or 0)==0 and int(u2.get("totalTokens") or 0)==0)
passed=(
  s1==200 and s2==200
  and m1.get("analysisCacheHit") is False
  and m2.get("analysisCacheHit") is True
  and same
  and zero_usage
  and (a2.get("compliance") or {}).get("status")=="pass"
)
print("# ForgeDirector analysis-cache benchmark")
print(json.dumps({
  "first":{"http":s1,"seconds":t1,"cacheHit":m1.get("analysisCacheHit"),"usage":m1.get("usage")},
  "second":{"http":s2,"seconds":t2,"cacheHit":m2.get("analysisCacheHit"),"cacheAgeSeconds":m2.get("analysisCacheAgeSeconds"),"usage":m2.get("usage")},
  "analysisIdentical":same,
  "zeroModelUsageOnHit":zero_usage,
  "passed":passed,
},indent=2))
raise SystemExit(0 if passed else 2)
