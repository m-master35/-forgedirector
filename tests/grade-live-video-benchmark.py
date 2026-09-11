#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else "benchmark-results")
expectations = json.loads((root / "expectations.json").read_text())
rows = []
check_total = check_correct = 0
speech_total = speech_clean = 0
technical_failures = []

def get_check(analysis, expected):
    for check in analysis.get("compliance", {}).get("checks", []):
        if check.get("type") == expected["type"] and check.get("rule") == expected["rule"]:
            return check
    return None

for case in expectations["cases"]:
    name = case["name"]
    result_path = root / f"{name}.json"
    if not result_path.exists():
        technical_failures.append(f"{name}: result file missing")
        continue
    try:
        result = json.loads(result_path.read_text())
    except Exception as exc:
        technical_failures.append(f"{name}: invalid JSON: {exc}")
        continue

    if result.get("_httpStatus") != 200:
        technical_failures.append(f"{name}: HTTP {result.get('_httpStatus')} {result.get('error', '')}")
        rows.append({"name": name, "status": "TECH_FAIL"})
        continue

    analysis = result.get("analysis", {})
    checks_ok = 0
    checks_n = 0
    details = []
    for expected in case.get("checks", []):
        checks_n += 1
        check_total += 1
        actual = get_check(analysis, expected)
        actual_status = actual.get("status") if actual else "missing"
        ok = actual_status == expected["status"]
        if ok:
            checks_ok += 1
            check_correct += 1
        details.append({
            "type": expected["type"],
            "rule": expected["rule"],
            "expected": expected["status"],
            "actual": actual_status,
            "ok": ok,
            "evidence": actual.get("evidence", "") if actual else "",
        })

    speech_ok = None
    if case.get("expectNoSpeechHallucination"):
        speech_total += 1
        spoken_hook = analysis.get("hook", {}).get("spokenHook")
        timeline_speech = [item.get("speech") for item in analysis.get("timeline", []) if item.get("speech")]
        speech_ok = not spoken_hook and not timeline_speech
        if speech_ok:
            speech_clean += 1

    gate = analysis.get("qualityGate", {}).get("action")
    gate_ok = None
    expected_gate = case.get("gate")
    if expected_gate == "not_accept":
        gate_ok = gate != "accept"
    elif expected_gate:
        gate_ok = gate == expected_gate

    rows.append({
        "name": name,
        "status": "OK",
        "checks": f"{checks_ok}/{checks_n}" if checks_n else "-",
        "speechClean": speech_ok,
        "gate": gate,
        "gateOk": gate_ok,
        "overall": analysis.get("scores", {}).get("overall"),
        "hook": analysis.get("scores", {}).get("hook"),
        "platformFit": analysis.get("scores", {}).get("platformFit"),
        "usageTokens": result.get("meta", {}).get("usage", {}).get("totalTokens"),
        "summary": analysis.get("summary", ""),
        "limitations": analysis.get("limitations", []),
        "cta": analysis.get("cta", {}),
        "timeline": analysis.get("timeline", []),
        "details": details,
    })

by_name = {r["name"]: r for r in rows if r.get("status") == "OK"}
relational = []
for rule in expectations.get("relational", []):
    left = by_name.get(rule["higher"])
    right = by_name.get(rule["lower"])
    if not left or not right:
        relational.append({**rule, "ok": False, "reason": "missing result"})
        continue
    margin = (left.get(rule["metric"]) or 0) - (right.get(rule["metric"]) or 0)
    relational.append({**rule, "margin": margin, "ok": margin >= rule.get("minMargin", 0)})

gate_assertions = [r for r in rows if r.get("gateOk") is not None]
gate_correct = sum(1 for r in gate_assertions if r["gateOk"])

summary = {
    "technicalFailures": technical_failures,
    "complianceChecks": {
        "correct": check_correct,
        "total": check_total,
        "accuracy": round(check_correct / check_total, 4) if check_total else None,
    },
    "speechHallucinationChecks": {
        "clean": speech_clean,
        "total": speech_total,
        "accuracy": round(speech_clean / speech_total, 4) if speech_total else None,
    },
    "qualityGateChecks": {
        "correct": gate_correct,
        "total": len(gate_assertions),
        "accuracy": round(gate_correct / len(gate_assertions), 4) if gate_assertions else None,
    },
    "relationalChecks": relational,
    "cases": rows,
}

(root / "summary.json").write_text(json.dumps(summary, indent=2))

md = []
md.append("# ForgeDirector live video benchmark")
md.append("")
md.append(f"- Compliance accuracy: **{check_correct}/{check_total}**" + (f" ({check_correct/check_total:.0%})" if check_total else ""))
md.append(f"- No-speech hallucination: **{speech_clean}/{speech_total}**" + (f" ({speech_clean/speech_total:.0%})" if speech_total else ""))
md.append(f"- Quality-gate assertions: **{gate_correct}/{len(gate_assertions)}**" + (f" ({gate_correct/len(gate_assertions):.0%})" if gate_assertions else ""))
md.append(f"- Technical failures: **{len(technical_failures)}**")
md.append("")
md.append("| Case | Compliance | Gate | Overall | Hook | Platform fit | Speech clean |")
md.append("|---|---:|---|---:|---:|---:|---|")
for r in rows:
    if r.get("status") != "OK":
        md.append(f"| {r['name']} | TECH FAIL | - | - | - | - | - |")
        continue
    speech = "-" if r.get("speechClean") is None else ("yes" if r["speechClean"] else "NO")
    md.append(f"| {r['name']} | {r['checks']} | {r.get('gate')} | {r.get('overall')} | {r.get('hook')} | {r.get('platformFit')} | {speech} |")

md.append("")
md.append("## Case observations")
for r in rows:
    if r.get("status") != "OK":
        continue
    summary_text = str(r.get("summary") or "").replace("\n", " ")[:500]
    limitations_text = "; ".join(str(x) for x in r.get("limitations", []))[:500]
    cta_text = json.dumps(r.get("cta", {}), ensure_ascii=False)[:500]
    timeline_text = json.dumps(r.get("timeline", []), ensure_ascii=False)[:1200]
    md.append(f"### {r['name']}")
    md.append(f"- Summary: {summary_text or '(empty)'}")
    md.append(f"- CTA: {cta_text}")
    md.append(f"- Limitations: {limitations_text or '(none)'}")
    md.append(f"- Timeline: {timeline_text}")

if relational:
    md.append("")
    md.append("## Relational checks")
    for item in relational:
        md.append(f"- {'PASS' if item['ok'] else 'FAIL'}: {item['higher']} {item['metric']} should exceed {item['lower']} by {item.get('minMargin',0)}; observed margin {item.get('margin','n/a')}.")

if technical_failures:
    md.append("")
    md.append("## Technical failures")
    md.extend([f"- {x}" for x in technical_failures])

md.append("")
md.append("## Compliance mismatches")
mismatch_count = 0
for r in rows:
    for d in r.get("details", []):
        if not d["ok"]:
            mismatch_count += 1
            md.append(f"- **{r['name']}** — {d['type']} / {d['rule']}: expected **{d['expected']}**, got **{d['actual']}**. Evidence: {d['evidence'] or '(none)'}")
if mismatch_count == 0:
    md.append("- None.")

(root / "summary.md").write_text("\n".join(md) + "\n")
print("\n".join(md))

# This is an evidence run, not a deploy gate. Only technical failures make the workflow fail.
if technical_failures:
    sys.exit(2)
