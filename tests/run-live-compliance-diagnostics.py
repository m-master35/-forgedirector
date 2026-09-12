#!/usr/bin/env python3
import json, os, subprocess, tempfile, urllib.error, urllib.request
from pathlib import Path

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ["RAPIDAPI_PROXY_SECRET"]
ROOT=Path(tempfile.mkdtemp(prefix="fd-compliance-diag-"))

CASES=[
  ("real-wine","https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/wine-label/sample-output/assets/05-hero.mp4",{"mustShow":["wine bottle"],"mustNotShow":["motorcycle"]}),
  ("veo-standup","https://github.com/user-attachments/assets/94932749-cf4c-4b8c-a6f5-4b0165aac0be",{"mustShow":["person performing stand-up comedy on a stage or in a small venue"],"mustNotShow":["dog"]}),
  ("veo-dinosaur-guitar","https://github.com/user-attachments/assets/15742a7b-2b50-4d4d-b99d-63e75e8fc086",{"mustShow":["dinosaur","acoustic guitar"]}),
  ("veo-pythagoras","https://github.com/user-attachments/assets/fc1a76f9-6d43-44c9-a458-69489a1b1bbe",{"mustShow":["person in an ancient Greek setting"],"mustNotShow":["motorcycle"]}),
  ("veo-runner-replicate","https://github.com/user-attachments/assets/499d3a54-dfa1-41db-a089-93b842844c4c",{"mustShow":["person running outdoors"],"mustIncludeText":["Replicate"]}),
  ("camber-tumbler","https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-tumbler-ugc-10s.mp4",{"mustShow":["person","insulated coffee tumbler"],"mustNotShow":["gooseneck kettle"]}),
  ("camber-kettle","https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-kettle-ugc-10s.mp4",{"mustShow":["person","gooseneck pour-over kettle"],"mustNotShow":["hand coffee grinder"]}),
  ("camber-tumbler-pan","https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-tumbler-pan-10s.mp4",{"mustShow":["black insulated travel tumbler or coffee tumbler"],"mustNotShow":["giraffe"]}),
]

def http(path,payload,timeout=180):
    data=json.dumps(payload).encode()
    req=urllib.request.Request(API_URL+path,data=data,headers={"content-type":"application/json","x-rapidapi-proxy-secret":SECRET},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw=e.read().decode("utf-8",errors="replace")
        try: parsed=json.loads(raw)
        except Exception: parsed={"error":raw}
        return e.code,parsed

def normalize(name,url):
    raw=ROOT/f"{name}-raw.mp4"; out=ROOT/f"{name}.mp4"
    urllib.request.urlretrieve(url,raw)
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(raw),"-t","12","-an","-vf","scale='if(gt(iw,720),720,iw)':-2","-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p","-movflags","+faststart",str(out)],check=True)
    return out

def upload(path):
    size=path.stat().st_size
    s,d=http("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
    if s!=200: return s,None
    u=d["upload"]
    req=urllib.request.Request(u["uploadUrl"],data=path.read_bytes(),headers={"content-type":"video/mp4","content-length":str(size)},method="PUT")
    with urllib.request.urlopen(req,timeout=120) as r: ps=r.status
    return ps,u["assetId"]

rows=[]
for name,url,requirements in CASES:
    path=normalize(name,url)
    duration=float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(path)],capture_output=True,text=True,check=True).stdout.strip())
    us,asset=upload(path)
    if us not in (200,201,204):
        rows.append({"case":name,"status":us,"stage":"upload"})
        continue
    status,result=http("/v1/analyze",{
        "assetId":asset,
        "platform":"General",
        "objective":"awareness",
        "durationSeconds":duration,
        "context":"Diagnostic repeat of a known real/generated-video compliance case. Audio removed. Judge visible facts only.",
        "requirements":requirements,
    })
    meta=result.get("meta") or {}
    rows.append({
        "case":name,
        "status":status,
        "diagnosticCode":result.get("diagnosticCode"),
        "error":result.get("error"),
        "analysisRetryUsed":meta.get("analysisRetryUsed"),
        "coverageRetryUsed":meta.get("coverageRetryUsed"),
        "complianceVerificationUsed":meta.get("complianceVerificationUsed"),
        "complianceVerificationRetryUsed":meta.get("complianceVerificationRetryUsed"),
        "complianceVerificationModelId":meta.get("complianceVerificationModelId"),
        "complianceVerificationCoverage":meta.get("complianceVerificationCoverage"),
        "complianceStatus":(result.get("analysis") or {}).get("compliance",{}).get("status"),
    })

print("# Blind compliance verifier diagnostics")
print()
print("| Case | HTTP | Diagnostic | Verification retry | Verifier | Compliance |")
print("|---|---:|---|---|---|---|")
for r in rows:
    print(f"| {r['case']} | {r['status']} | {r.get('diagnosticCode') or '-'} | {r.get('complianceVerificationRetryUsed')} | {r.get('complianceVerificationModelId') or '-'} | {r.get('complianceStatus') or '-'} |")
print()
print("## Raw")
print(json.dumps(rows,indent=2))

with open("/tmp/compliance-verifier-diagnostics.json","w") as f: json.dump(rows,f,indent=2)
with open("/tmp/compliance-verifier-diagnostics.md","w") as f:
    f.write("# Blind compliance verifier diagnostics\n\n")
    for r in rows:
        f.write(f"- {r['case']}: HTTP {r['status']}, diagnostic={r.get('diagnosticCode')}, verifier={r.get('complianceVerificationModelId')}, retry={r.get('complianceVerificationRetryUsed')}\n")
