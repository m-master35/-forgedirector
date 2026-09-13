#!/usr/bin/env python3
import json, os, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ["RAPIDAPI_PROXY_SECRET"]
ROOT=Path(tempfile.mkdtemp(prefix="fd-cost-"))
NONCE=f"{os.environ.get('GITHUB_RUN_ID','local')}-{os.environ.get('GITHUB_RUN_ATTEMPT','1')}-{time.time_ns()}"
URL="https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4"

RATES={
  "nova2-lite":(0.30,2.50),
  "nova-pro":(0.80,3.20),
}
PRO_RATE=RATES["nova-pro"]
LITE_RATE=RATES["nova2-lite"]

def http_json(path,payload,timeout=240):
    req=urllib.request.Request(
        API_URL+path,
        data=json.dumps(payload).encode(),
        headers={"content-type":"application/json","x-rapidapi-proxy-secret":SECRET},
        method="POST",
    )
    start=time.time()
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            return r.status,json.loads(r.read().decode()),round(time.time()-start,2)
    except urllib.error.HTTPError as e:
        body=e.read().decode("utf-8",errors="replace")
        try: parsed=json.loads(body)
        except Exception: parsed={"error":body}
        return e.code,parsed,round(time.time()-start,2)

def model_rate(model_id):
    mid=str(model_id or "").lower()
    if "nova-2-lite" in mid: return RATES["nova2-lite"],"nova2-lite"
    if "nova-pro" in mid: return RATES["nova-pro"],"nova-pro"
    return RATES["nova-pro"],"unknown-priced-as-pro"

def token_cost(usage,rate):
    usage=usage or {}
    inp=max(0,int(usage.get("inputTokens") or 0))
    out=max(0,int(usage.get("outputTokens") or 0))
    return inp/1_000_000*rate[0] + out/1_000_000*rate[1]

def conservative_plan_cost(meta):
    usage=meta.get("requestUsage") or {}
    upper=token_cost(usage,PRO_RATE)
    lower=token_cost(usage,LITE_RATE)
    return lower,upper,usage

def video_cost(meta):
    primary_usage=meta.get("usage") or {}
    primary_rate,primary_name=model_rate(meta.get("modelId"))
    primary=token_cost(primary_usage,primary_rate)
    verifier_usage=meta.get("complianceVerificationUsage") or {}
    verifier_ids=meta.get("complianceVerificationModelIds") or []
    verifier_upper=token_cost(verifier_usage,PRO_RATE)
    verifier_lower=token_cost(verifier_usage,LITE_RATE)
    return {
      "primaryModel":primary_name,
      "primaryUsage":primary_usage,
      "verifierModelIds":verifier_ids,
      "verifierUsage":verifier_usage,
      "observedLowerUSD":round(primary+verifier_lower,6),
      "conservativeUpperUSD":round(primary+verifier_upper,6),
    }

def normalize(duration):
    raw=ROOT/"raw.mp4"
    if not raw.exists(): urllib.request.urlretrieve(URL,raw)
    out=ROOT/f"clip-{duration}.mp4"
    subprocess.run([
        "ffmpeg","-hide_banner","-loglevel","error","-y",
        "-stream_loop","-1","-i",str(raw),"-t",str(duration),"-an",
        "-vf","scale='if(gt(iw,720),720,iw)':-2",
        "-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p",
        "-movflags","+faststart",str(out)
    ],check=True)
    probe=subprocess.run(
        ["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(out)],
        capture_output=True,text=True,check=True,
    )
    return out,float(probe.stdout.strip())

def upload(path):
    size=path.stat().st_size
    st,data,_=http_json("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
    if st!=200:return st,None
    u=data["upload"]
    req=urllib.request.Request(
        u["uploadUrl"],data=path.read_bytes(),
        headers={"content-type":"video/mp4","content-length":str(size)},method="PUT"
    )
    with urllib.request.urlopen(req,timeout=120) as r: put=r.status
    return put,u["assetId"]

rows=[]
failures=[]

def add_plan(name,payload):
    st,data,secs=http_json("/v1/plan",payload)
    if st!=200:
        failures.append(f"{name}: HTTP {st} {data.get('error','')}")
        return
    meta=data.get("meta") or {}
    lower,upper,usage=conservative_plan_cost(meta)
    rows.append({
      "case":name,"type":"plan","seconds":secs,
      "modelCalls":meta.get("modelCallCount"),
      "usage":usage,
      "lowerUSD":round(lower,6),"upperUSD":round(upper,6),
      "qualityGate":(meta.get("qualityGate") or {}).get("passed"),
    })

add_plan("plan-normal",{
  "brief":"Create a 15-second vertical launch video for a fictional focus timer app. Start on a distracted desk, show the timer beginning, and resolve on a clean focused-work end frame. Do not invent performance claims.",
  "constraints":{"durationSeconds":15,"platform":"TikTok","aspectRatio":"9:16"}
})
add_plan("plan-weak",{"brief":"make it good"})

def add_video(name,duration,requirements=None):
    path,actual_duration=normalize(duration)
    st,asset=upload(path)
    if st not in (200,201,204):
        failures.append(f"{name}: upload HTTP {st}")
        return
    payload={
      "assetId":asset,
      "platform":"General",
      "objective":"awareness",
      "durationSeconds":actual_duration,
      "context":f"ForgeDirector launch cost benchmark {NONCE} {name}. Audio removed. Judge visible facts only across the entire clip.",
    }
    if requirements: payload["requirements"]=requirements
    st,data,secs=http_json("/v1/analyze",payload,timeout=300)
    if st!=200:
        failures.append(f"{name}: HTTP {st} {data.get('error','')}")
        return
    meta=data.get("meta") or {}
    cost=video_cost(meta)
    rows.append({
      "case":name,"type":"video","durationSeconds":round(actual_duration,2),"seconds":secs,
      "cacheHit":meta.get("analysisCacheHit"),"usage":meta.get("usage"),
      **cost,
      "complianceStatus":((data.get("analysis") or {}).get("compliance") or {}).get("status"),
    })

add_video("video-12s-plain",12)
requirements={"mustShow":["motorcycle"],"mustNotShow":["wine bottle"],"ctaRequired":False}
add_video("video-12s-requirements",12,requirements)
add_video("video-30s-requirements",30,requirements)
add_video("video-60s-requirements",60,requirements)

print("# ForgeDirector live unit-cost profile")
print()
print("| Case | Type | Duration | Seconds | Input/output usage | Conservative upper model cost USD |")
print("|---|---|---:|---:|---|---:|")
for row in rows:
    usage=row.get("usage") or {}
    if row["type"]=="video":
        vusage=row.get("verifierUsage") or {}
        usage_text=f"primary {usage.get('inputTokens',0)}/{usage.get('outputTokens',0)}; verifier {vusage.get('inputTokens',0)}/{vusage.get('outputTokens',0)}"
    else:
        usage_text=f"{usage.get('inputTokens',0)}/{usage.get('outputTokens',0)}"
    upper=row["upperUSD"] if "upperUSD" in row else row["conservativeUpperUSD"]
    print(f"| {row['case']} | {row['type']} | {row.get('durationSeconds','-')} | {row['seconds']} | {usage_text} | {upper:.6f} |")

print()
print("## JSON")
print(json.dumps(rows,indent=2))
print()
if failures:
    print("## Failures")
    for failure in failures: print(f"- {failure}")
else:
    print("## Result")
    print(f"- PASS: {len(rows)}/{len(rows)} fresh production cost-profile cases returned usable results.")

with open("/tmp/cost-profile.json","w") as f: json.dump({"rows":rows,"failures":failures},f,indent=2)
with open("/tmp/cost-profile-summary.md","w") as f:
    f.write("# ForgeDirector live unit-cost profile\n\n")
    for row in rows:
        cost=row.get("upperUSD",row.get("conservativeUpperUSD"))
        f.write(f"- {row['case']}: <= ${cost:.6f} conservative model-cost estimate\n")
    f.write(f"- Result: {'PASS' if not failures else 'FAIL'}\n")

raise SystemExit(2 if failures else 0)
