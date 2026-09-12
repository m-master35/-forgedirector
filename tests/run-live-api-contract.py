#!/usr/bin/env python3
import json
import os
import urllib.error
import urllib.request

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ.get("RAPIDAPI_PROXY_SECRET","")

def send(method,path,body=None,secret="correct",content_type="application/json"):
    headers={}
    if content_type:
        headers["content-type"]=content_type
    if secret=="correct" and SECRET:
        headers["x-rapidapi-proxy-secret"]=SECRET
    elif secret=="wrong":
        headers["x-rapidapi-proxy-secret"]="definitely-wrong-secret"
    data=None
    if body is not None:
        data=body if isinstance(body,(bytes,bytearray)) else str(body).encode()
    req=urllib.request.Request(API_URL+path,data=data,headers=headers,method=method)
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            raw=r.read().decode("utf-8",errors="replace")
            status=r.status
    except urllib.error.HTTPError as e:
        status=e.code
        raw=e.read().decode("utf-8",errors="replace")
    except Exception as e:
        return 0,{"transportError":str(e)},str(e)
    try:
        parsed=json.loads(raw) if raw else {}
    except Exception:
        parsed={"raw":raw}
    return status,parsed,raw

cases=[
    ("wrong-gateway-secret","POST","/v1/plan",json.dumps({"brief":"test"}),"wrong",401),
    ("malformed-json","POST","/v1/plan",'{"brief":',"correct",400),
    ("oversized-body","POST","/v1/plan",json.dumps({"brief":"x"*125000}),"correct",413),
    ("upload-missing-content-type","POST","/v1/uploads",json.dumps({}),"correct",400),
    ("upload-unsupported-type","POST","/v1/uploads",json.dumps({"contentType":"image/png","sizeBytes":100}),"correct",400),
    ("upload-zero-size","POST","/v1/uploads",json.dumps({"contentType":"video/mp4","sizeBytes":0}),"correct",400),
    ("upload-too-large","POST","/v1/uploads",json.dumps({"contentType":"video/mp4","sizeBytes":31457281}),"correct",400),
    ("analyze-missing-asset","POST","/v1/analyze",json.dumps({}),"correct",400),
    ("analyze-invalid-uuid","POST","/v1/analyze",json.dumps({"assetId":"not-a-uuid"}),"correct",400),
    ("analyze-missing-object","POST","/v1/analyze",json.dumps({"assetId":"11111111-1111-4111-8111-111111111111"}),"correct",404),
    ("revise-missing-campaign","POST","/v1/revise",json.dumps({"instruction":"make it better"}),"correct",400),
    ("qa-missing-campaign","POST","/v1/qa",json.dumps({}),"correct",400),
    ("unknown-route","POST","/v1/does-not-exist",json.dumps({}),"correct",404),
    ("wrong-method","GET","/v1/plan",None,"correct",404),
]

rows=[]
failures=[]
for name,method,path,body,secret,expected in cases:
    status,data,raw=send(method,path,body,secret)
    err=data.get("error") if isinstance(data,dict) else None
    rows.append((name,status,expected,err))
    if status!=expected:
        failures.append(f"{name}: expected HTTP {expected}, got {status}: {raw[:400]}")
    if status>=500:
        failures.append(f"{name}: unexpected server error {status}")
    if status>=400 and not isinstance(data,dict):
        failures.append(f"{name}: error response is not JSON")
    if status>=400 and isinstance(data,dict) and not data.get("error"):
        failures.append(f"{name}: missing error message")
    if status>=400 and isinstance(data,dict) and not data.get("requestId"):
        failures.append(f"{name}: missing requestId")

print("# ForgeDirector API contract abuse benchmark")
print()
print("| Case | HTTP | Expected | Error |")
print("|---|---:|---:|---|")
for name,status,expected,err in rows:
    safe=(err or "").replace("|","\\|")
    print(f"| {name} | {status} | {expected} | {safe} |")
print()
if failures:
    print("## Failures")
    for failure in failures:
        print(f"- {failure}")
else:
    print("## Result")
    print(f"- PASS: {len(cases)}/{len(cases)} malformed/unauthorized requests failed cleanly with the expected 4xx contract.")

with open("/tmp/api-contract-summary.md","w") as f:
    f.write("# ForgeDirector API contract abuse benchmark\n\n")
    f.write(f"- Cases: {len(cases)}\n")
    f.write(f"- Failures: {len(failures)}\n")
    f.write(f"- Result: {'PASS' if not failures else 'FAIL'}\n")

raise SystemExit(2 if failures else 0)
