#!/usr/bin/env python3
import json
import os
import urllib.error
import urllib.request

API_URL=os.environ["API_URL"].rstrip("/")
SECRET=os.environ.get("RAPIDAPI_PROXY_SECRET","")

def request(path, body=None, method="POST", auth=True, raw=False, content_type="application/json"):
    headers={"content-type":content_type}
    if auth and SECRET:
        headers["x-rapidapi-proxy-secret"]=SECRET
    if body is None:
        data=None
    elif raw:
        data=body if isinstance(body,bytes) else str(body).encode()
    else:
        data=json.dumps(body).encode()
    req=urllib.request.Request(API_URL+path,data=data,headers=headers,method=method)
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            raw_body=r.read().decode("utf-8",errors="replace")
            try: parsed=json.loads(raw_body) if raw_body else {}
            except Exception: parsed={"raw":raw_body}
            return r.status,parsed
    except urllib.error.HTTPError as e:
        raw_body=e.read().decode("utf-8",errors="replace")
        try: parsed=json.loads(raw_body) if raw_body else {}
        except Exception: parsed={"raw":raw_body}
        return e.code,parsed
    except Exception as e:
        return 0,{"error":str(e)}

cases=[
    ("gateway-bypass","/v1/plan",{"brief":"test"},401,False,False),
    ("malformed-json","/v1/plan",'{"brief":',400,True,True),
    ("oversized-json","/v1/plan",'{"brief":"'+("x"*125000)+'"}',413,True,True),
    ("upload-missing-content-type","/v1/uploads",{},400,True,False),
    ("upload-missing-size","/v1/uploads",{"contentType":"video/mp4"},400,True,False),
    ("upload-unsupported-content-type","/v1/uploads",{"contentType":"application/pdf","sizeBytes":100},400,True,False),
    ("upload-zero-size","/v1/uploads",{"contentType":"video/mp4","sizeBytes":0},400,True,False),
    ("upload-too-large","/v1/uploads",{"contentType":"video/mp4","sizeBytes":31457281},400,True,False),
    ("analyze-missing-asset","/v1/analyze",{},400,True,False),
    ("analyze-invalid-uuid","/v1/analyze",{"assetId":"not-a-uuid"},400,True,False),
    ("analyze-unknown-asset","/v1/analyze",{"assetId":"00000000-0000-4000-8000-000000000001"},404,True,False),
    ("revise-missing-campaign","/v1/revise",{"instruction":"make it better"},400,True,False),
    ("revise-array-campaign","/v1/revise",{"campaign":[],"instruction":"make it better"},400,True,False),
    ("unknown-endpoint","/v1/does-not-exist",{},404,True,False),
]

rows=[]
failures=[]
for name,path,body,expected,auth,raw in cases:
    status,data=request(path,body,auth=auth,raw=raw)
    error=data.get("error") if isinstance(data,dict) else None
    request_id=data.get("requestId") if isinstance(data,dict) else None
    ok=status==expected and bool(error) and bool(request_id)
    rows.append((name,status,expected,error,request_id,ok))
    if not ok:
        failures.append(f"{name}: expected {expected} with error+requestId, got {status} {data}")


# Verify that an uploaded object is deleted even when analysis request validation
# rejects the request before Bedrock runs.
fake_video=b"not-a-real-video-but-valid-for-pre-model-validation"
status,upload=request("/v1/uploads",{
    "contentType":"video/mp4",
    "sizeBytes":len(fake_video),
})
if status==200:
    upload_url=upload.get("upload",{}).get("uploadUrl")
    asset_id=upload.get("upload",{}).get("assetId")
    put_status=0
    try:
        put_req=urllib.request.Request(
            upload_url,
            data=fake_video,
            headers={
                "content-type":"video/mp4",
                "content-length":str(len(fake_video)),
            },
            method="PUT",
        )
        with urllib.request.urlopen(put_req,timeout=30) as put_resp:
            put_status=put_resp.status
    except urllib.error.HTTPError as e:
        put_status=e.code
    except Exception:
        put_status=0

    invalid_status,invalid_body=request("/v1/analyze",{
        "assetId":asset_id,
        "objective":"definitely-not-valid",
    })
    second_status,second_body=request("/v1/analyze",{"assetId":asset_id})
    cleanup_ok=(
        put_status in (200,201)
        and invalid_status==400
        and second_status==404
        and bool(invalid_body.get("requestId"))
        and bool(second_body.get("requestId"))
    )
    rows.append((
        "rejected-analysis-cleans-upload",
        second_status if cleanup_ok else invalid_status,
        404,
        "asset deleted after validation rejection" if cleanup_ok else str({
            "put":put_status,
            "invalid":invalid_status,
            "second":second_status,
        }),
        second_body.get("requestId") if isinstance(second_body,dict) else None,
        cleanup_ok,
    ))
    if not cleanup_ok:
        failures.append(
            f"rejected-analysis-cleans-upload: put={put_status}, invalid={invalid_status}, second={second_status}"
        )
else:
    failures.append(f"rejected-analysis-cleans-upload: could not create upload, HTTP {status} {upload}")


# Method mismatch should be a clean 404 JSON error as well.
status,data=request("/v1/plan",None,method="GET",auth=True)
ok=status==404 and bool(data.get("error")) and bool(data.get("requestId"))
rows.append(("wrong-method",status,404,data.get("error"),data.get("requestId"),ok))
if not ok:
    failures.append(f"wrong-method: expected 404 JSON error, got {status} {data}")

print("# ForgeDirector negative API contract benchmark")
print()
print("| Case | HTTP | Expected | Error | Request ID |")
print("|---|---:|---:|---|---|")
for name,status,expected,error,request_id,ok in rows:
    safe_error=str(error or "-").replace("|","/")
    print(f"| {name} | {status} | {expected} | {safe_error[:90]} | {'yes' if request_id else 'no'} |")

print()
if failures:
    print("## Failures")
    for failure in failures:
        print(f"- {failure}")
else:
    print("## Result")
    print(f"- PASS: {len(rows)}/{len(rows)} malformed/unauthorized client requests returned predictable 4xx JSON errors with request IDs and no 5xx responses.")

with open("/tmp/negative-contract-summary.md","w",encoding="utf-8") as f:
    f.write("# ForgeDirector negative API contract benchmark\n\n")
    f.write(f"- Cases: {len(rows)}\n")
    f.write(f"- Failures: {len(failures)}\n")
    f.write(f"- Result: {'PASS' if not failures else 'FAIL'}\n")

raise SystemExit(2 if failures else 0)
