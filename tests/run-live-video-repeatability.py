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
BENCH_NONCE=f"{os.environ.get('GITHUB_RUN_ID','local')}-{os.environ.get('GITHUB_RUN_ATTEMPT','1')}-{time.time_ns()}"

SOURCES=[
    {
        "name":"motorcycle",
        "url":"https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4",
        "requirements":{"mustShow":["motorcycle"],"mustNotShow":["wine bottle"]},
        "expected":[("mustShow","motorcycle","pass"),("mustNotShow","wine bottle","pass")],
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
    {
        "name":"camber-grinder",
        "url":"https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-grinder-ugc-10s.mp4",
        "requirements":{"mustShow":["person","manual hand coffee grinder"],"mustNotShow":["gooseneck kettle"]},
        "expected":[("mustShow","person","pass"),("mustShow","manual hand coffee grinder","pass"),("mustNotShow","gooseneck kettle","pass")],
    },
    {
        "name":"cosmetic-jars",
        "url":"https://raw.githubusercontent.com/arjungithu53/zeroshot_studio/main/sample-output/shot_3.3.1_sample_clip.mp4",
        "requirements":{"mustShow":["cosmetic balm jar or cosmetic jars"],"mustNotShow":["motorcycle"]},
        "expected":[("mustShow","cosmetic balm jar or cosmetic jars","pass"),("mustNotShow","motorcycle","pass")],
    },
]

# Five independent calls per genuine generated clip. This is intentionally
# more expensive than the smoke suite: it is the stochastic release gate.
RUNS_PER_CASE=5
MAX_OVERALL_RANGE=15
MAX_HOOK_RANGE=20

def http_json(path,payload,timeout=120):
    data=json.dumps(payload).encode()
    req=urllib.request.Request(API_URL+path,data=data,headers={"content-type":"application/json","x-rapidapi-proxy-secret":SECRET},method="POST")
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
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(raw),"-t","12","-an","-vf","scale='if(gt(iw,720),720,iw)':-2","-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p","-movflags","+faststart",str(out)],check=True)
    return out

def upload(path):
    size=path.stat().st_size
    status,data=http_json("/v1/uploads",{"contentType":"video/mp4","sizeBytes":size})
    if status!=200: return status,None,data
    u=data["upload"]
    req=urllib.request.Request(u["uploadUrl"],data=path.read_bytes(),headers={"content-type":"video/mp4","content-length":str(size)},method="PUT")
    try:
        with urllib.request.urlopen(req,timeout=120) as r: put_status=r.status
    except urllib.error.HTTPError as e:
        return e.code,None,{"error":"PUT failed"}
    if put_status not in (200,201,204): return put_status,None,{"error":"PUT failed"}
    return 200,u["assetId"],data

def find_check(analysis,typ,rule):
    for check in (analysis.get("compliance") or {}).get("checks",[]):
        if check.get("type")==typ and check.get("rule")==rule: return check.get("status")
    return "missing"

rows=[]
failures=[]
observations={item["name"]:{"overall":[],"hook":[],"gate":[]} for item in SOURCES}
for item in SOURCES:
    path=download_normalize(item)
    for run in range(1,RUNS_PER_CASE+1):
        us,asset,_=upload(path)
        if us!=200:
            rows.append((item["name"],run,us,"upload-fail","-","-",None)); failures.append(f"{item['name']} run {run}: upload failed HTTP {us}"); continue
        probe=subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(path)],capture_output=True,text=True,check=True)
        duration=float(probe.stdout.strip())
        payload={"assetId":asset,"platform":"General","objective":"awareness","durationSeconds":duration,"context":f"Repeatability benchmark {BENCH_NONCE} for {item['name']}. Audio removed. Judge visible facts only across the entire clip.","requirements":item["requirements"]}
        start=time.time(); status,result=http_json("/v1/analyze",payload,timeout=180); elapsed=round(time.time()-start,2)
        if status!=200:
            rows.append((item["name"],run,status,"analyze-fail","-",elapsed,None)); failures.append(f"{item['name']} run {run}: HTTP {status} {result.get('error','')}"); continue
        analysis=result.get("analysis") or {}
        meta=result.get("meta") or {}
        cache_hit=meta.get("analysisCacheHit")
        if run == 1 and cache_hit is not False:
            failures.append(f"{item['name']} run {run}: expected fresh analysis cache miss, got {cache_hit}")
        if run > 1 and cache_hit is not True:
            failures.append(f"{item['name']} run {run}: expected analysis cache hit, got {cache_hit}")
        if run > 1:
            usage=meta.get("usage") or {}
            if any(int(usage.get(k) or 0) != 0 for k in ("inputTokens","outputTokens","totalTokens")):
                failures.append(f"{item['name']} run {run}: cache hit consumed model tokens {usage}")
        mismatches=[]
        for typ,rule,expected in item["expected"]:
            actual=find_check(analysis,typ,rule)
            if actual!=expected: mismatches.append(f"{typ}:{rule}={actual}, expected {expected}")
        spoken=(analysis.get("hook") or {}).get("spokenHook")
        timeline_speech=[x.get("speech") for x in analysis.get("timeline",[]) if x.get("speech")]
        speech_clean=not spoken and not timeline_speech
        if mismatches: failures.append(f"{item['name']} run {run}: "+"; ".join(mismatches))
        if not speech_clean: failures.append(f"{item['name']} run {run}: hallucinated speech")
        coverage=(analysis.get("coverage") or {})
        coverage_ok=coverage.get("fullDurationReviewed") is True
        if not coverage_ok: failures.append(f"{item['name']} run {run}: incomplete duration coverage {coverage.get('observedThroughSeconds')}/{coverage.get('declaredDurationSeconds')}")
        gate=(analysis.get("qualityGate") or {}).get("action")
        overall=(analysis.get("scores") or {}).get("overall"); hook=(analysis.get("scores") or {}).get("hook")
        if isinstance(overall,(int,float)): observations[item["name"]]["overall"].append(float(overall))
        if isinstance(hook,(int,float)): observations[item["name"]]["hook"].append(float(hook))
        if gate: observations[item["name"]]["gate"].append(gate)
        verdict="pass" if (not mismatches and speech_clean and coverage_ok) else "FAIL"
        rows.append((item["name"],run,status,verdict,gate,elapsed,cache_hit))

gate_rank={"regenerate":0,"revise":1,"accept":2}
stability_rows=[]
for item in SOURCES:
    name=item["name"]; obs=observations[name]
    if len(obs["overall"]) != RUNS_PER_CASE or len(obs["hook"]) != RUNS_PER_CASE or len(obs["gate"]) != RUNS_PER_CASE:
        failures.append(f"{name}: incomplete successful observations for stochastic stability")
    overall_range=(max(obs["overall"])-min(obs["overall"])) if len(obs["overall"])>=2 else 0
    hook_range=(max(obs["hook"])-min(obs["hook"])) if len(obs["hook"])>=2 else 0
    ranks=[gate_rank[g] for g in obs["gate"] if g in gate_rank]
    gate_span=(max(ranks)-min(ranks)) if len(ranks)>=2 else 0
    stable=overall_range<=MAX_OVERALL_RANGE and hook_range<=MAX_HOOK_RANGE and gate_span<=1
    stability_rows.append((name,overall_range,hook_range,gate_span,stable))
    if overall_range>MAX_OVERALL_RANGE: failures.append(f"{name}: overall score range too wide: {overall_range:.1f}")
    if hook_range>MAX_HOOK_RANGE: failures.append(f"{name}: hook score range too wide: {hook_range:.1f}")
    if gate_span>1: failures.append(f"{name}: quality gate flipped between accept and regenerate")

print("# ForgeDirector video QA repeatability benchmark\n")
print("| Clip | Run | HTTP | Compliance | Gate | Seconds | Cache hit |\n|---|---:|---:|---|---|---:|---|")
for row in rows: print(f"| {row[0]} | {row[1]} | {row[2]} | {row[3]} | {row[4]} | {row[5]} | {row[6]} |")
print("\n## Score and gate stability\n| Clip | Overall range | Hook range | Gate span | Stable |\n|---|---:|---:|---:|---|")
for name,overall_range,hook_range,gate_span,stable in stability_rows: print(f"| {name} | {overall_range:.1f} | {hook_range:.1f} | {gate_span} | {'yes' if stable else 'NO'} |")
print()
if failures:
    print("## Failures")
    for f in failures: print(f"- {f}")
else:
    print("## Result")
    print(f"- PASS: {len(rows)}/{len(rows)} repeated real-video analyses met compliance, no-speech, full-duration coverage, tighter score-stability, and quality-gate stability requirements.")
evidence={
    "clips":len(SOURCES),
    "runsPerClip":RUNS_PER_CASE,
    "calls":len(rows),
    "maxOverallRange":MAX_OVERALL_RANGE,
    "maxHookRange":MAX_HOOK_RANGE,
    "rows":[
        {"clip":r[0],"run":r[1],"http":r[2],"compliance":r[3],"gate":r[4],"seconds":r[5],"cacheHit":r[6]}
        for r in rows
    ],
    "stability":[
        {"clip":name,"overallRange":overall_range,"hookRange":hook_range,"gateSpan":gate_span,"stable":stable}
        for name,overall_range,hook_range,gate_span,stable in stability_rows
    ],
    "failures":failures,
    "result":"PASS" if not failures else "FAIL",
}
with open("/tmp/video-repeatability-results.json","w") as f:
    json.dump(evidence,f,indent=2)

with open("/tmp/video-repeatability-summary.md","w") as f:
    f.write("# ForgeDirector video QA repeatability\n\n")
    f.write(f"- Calls: {len(rows)}\n- Clips: {len(SOURCES)}\n- Runs per clip: {RUNS_PER_CASE}\n- Max overall range: {MAX_OVERALL_RANGE}\n- Max hook range: {MAX_HOOK_RANGE}\n- Failures: {len(failures)}\n- Result: {'PASS' if not failures else 'FAIL'}\n")
raise SystemExit(2 if failures else 0)