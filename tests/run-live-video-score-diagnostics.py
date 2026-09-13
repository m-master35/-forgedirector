#!/usr/bin/env python3
import json, os, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ["RAPIDAPI_PROXY_SECRET"]
ROOT=Path(tempfile.mkdtemp(prefix="fd-score-diag-"))
CASES=[
  {
    "name":"motorcycle",
    "url":"https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4",
    "requirements":{"mustShow":["motorcycle"],"mustNotShow":["wine bottle"]},
  },
  {
    "name":"camber-tumbler",
    "url":"https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-tumbler-ugc-10s.mp4",
    "requirements":{"mustShow":["person","insulated coffee tumbler"],"mustNotShow":["gooseneck kettle"]},
  },
]
RUNS=5

def http_json(path,payload,timeout=180):
  req=urllib.request.Request(API_URL+path,data=json.dumps(payload).encode(),headers={"content-type":"application/json","x-rapidapi-proxy-secret":SECRET},method="POST")
  try:
    with urllib.request.urlopen(req,timeout=timeout) as r: return r.status,json.loads(r.read().decode())
  except urllib.error.HTTPError as e:
    b=e.read().decode("utf-8",errors="replace")
    try:return e.code,json.loads(b)
    except:return e.code,{"error":b}

def prep(item):
  raw=ROOT/(item["name"]+"-raw.mp4"); out=ROOT/(item["name"]+".mp4")
  urllib.request.urlretrieve(item["url"],raw)
  subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(raw),"-t","12","-an","-vf","scale='if(gt(iw,720),720,iw)':-2","-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p","-movflags","+faststart",str(out)],check=True)
  dur=float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(out)],capture_output=True,text=True,check=True).stdout.strip())
  return out,dur

def upload(path):
  size=path.stat().st_size
  st,data=http_json("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
  if st!=200:return st,None
  u=data["upload"]
  req=urllib.request.Request(u["uploadUrl"],data=path.read_bytes(),headers={"content-type":"video/mp4","content-length":str(size)},method="PUT")
  with urllib.request.urlopen(req,timeout=120) as r: ps=r.status
  return ps,u["assetId"]

rows=[]
for item in CASES:
  path,duration=prep(item)
  for run in range(1,RUNS+1):
    us,asset=upload(path)
    if us not in (200,201,204):
      rows.append({"clip":item["name"],"run":run,"http":us,"error":"upload"});continue
    payload={"assetId":asset,"platform":"General","objective":"awareness","durationSeconds":duration,"context":"Score repeatability diagnostics. Audio removed. Judge visible facts only across the entire clip.","requirements":item["requirements"]}
    start=time.time(); st,data=http_json("/v1/analyze",payload); elapsed=round(time.time()-start,2)
    a=data.get("analysis") or {}; scores=a.get("scores") or {}; gate=a.get("qualityGate") or {}
    rows.append({
      "clip":item["name"],"run":run,"http":st,"seconds":elapsed,
      "scores":scores,
      "hookVerdict":(a.get("hook") or {}).get("verdict"),
      "continuityVerdict":(a.get("continuity") or {}).get("verdict"),
      "ctaClarity":(a.get("cta") or {}).get("clarity"),
      "platformFitVerdict":(a.get("platformAssessment") or {}).get("fit"),
      "highRetentionRisks":sum(1 for x in a.get("retentionRisks",[]) if str(x.get("severity","")).lower()=="high"),
      "highImpactFixes":sum(1 for x in a.get("fixes",[]) if str(x.get("impact","")).lower()=="high"),
      "gate":gate.get("action"),"confidence":gate.get("confidence"),"blockers":gate.get("blockers"),"reasons":gate.get("reasons"),
      "compliance":(a.get("compliance") or {}).get("status"),
    })

print("# ForgeDirector score diagnostics")
for r in rows:
  print(json.dumps(r,sort_keys=True))
with open("/tmp/video-score-diagnostics.json","w") as f: json.dump(rows,f,indent=2)
