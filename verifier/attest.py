"""Verify a NEAR AI Cloud model's TEE attestation, the way docs.near.ai describes.

Usage: python3 verifier/attest.py <model id> [out.json]

Fetches the gateway and NEAR model reports with a fresh 32-byte nonce, then for
every report checks: the Intel TDX quote (dcap-qvl, Intel collateral), TCB
status, debug mode off, report_data binds the signing address and our nonce,
MRCONFIGID matches the hashed app_compose, the RTMR3 event log replays, and the
NVIDIA GPU evidence passes NRAS. Prints one JSON object; exit code 1 if any
check fails. The verified model signing addresses are what the owner registers
on chain with `add_signer`.
"""
import asyncio
import base64
import hashlib
import json
import secrets
import struct
import sys
import urllib.parse
import urllib.request

import dcap_qvl

ACCEPTED_TCB = {"UpToDate", "SWHardeningNeeded"}
API = "https://cloud-api.near.ai/v1/attestation/report"


def _json(v):
    return json.loads(v) if isinstance(v, str) else v


def http(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def replay_rtmr3(event_log):
    rtmr3 = bytes(48)
    for ev in _json(event_log):
        if ev.get("imr") != 3:
            continue
        d = hashlib.sha384(struct.pack("<I", ev["event_type"]) + b":" + ev["event"].encode() + b":" + bytes.fromhex(ev.get("event_payload") or "")).digest()
        if ev.get("digest") and bytes.fromhex(ev["digest"]) != d:
            raise ValueError("digest mismatch for event " + ev["event"])
        rtmr3 = hashlib.sha384(rtmr3 + d).digest()
    return rtmr3


def check_gpu(report, nonce):
    raw = report.get("nvidia_payload")
    if not raw:
        return None
    payload = _json(raw)
    if str(payload.get("nonce", "")).lower() != nonce.lower():
        raise ValueError("GPU evidence nonce does not match")
    out = json.loads(http("https://nras.attestation.nvidia.com/v3/attest/gpu", json.dumps(payload).encode(), {"Content-Type": "application/json", "Accept": "application/json"}))
    jwt = out[0][1]
    body = jwt.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    if claims.get("x-nvidia-overall-att-result") is not True:
        raise ValueError("NVIDIA NRAS verdict is not true")
    return True


async def check(report, nonce):
    checks = []

    def ok(name, detail=""):
        checks.append({"check": name, "ok": True, "detail": detail})

    verified = await dcap_qvl.get_collateral_and_verify(bytes.fromhex(report["intel_quote"]))
    ok("Intel TDX quote signature (dcap-qvl, Intel PCS collateral)")
    if verified.status not in ACCEPTED_TCB:
        raise ValueError("TCB status %s not accepted %s" % (verified.status, verified.advisory_ids))
    ok("TCB status accepted", verified.status)
    q = json.loads(verified.to_json())["report"]["TD10"]
    if bytes.fromhex(q["td_attributes"])[0] & 1:
        raise ValueError("TDX debug mode is on")
    ok("TDX debug mode off")
    ident = bytes.fromhex(report["signing_address"].removeprefix("0x"))
    fp = report.get("tls_cert_fingerprint")
    bound = hashlib.sha256(ident + bytes.fromhex(fp)).digest() if fp else ident.ljust(32, b"\0")
    if bytes.fromhex(q["report_data"]) != bound + bytes.fromhex(nonce):
        raise ValueError("report_data does not bind signer and nonce")
    ok("report_data binds signing address + our fresh nonce", report["signing_address"])
    if report["request_nonce"].lower() != nonce.lower():
        raise ValueError("echoed nonce mismatch")
    compose = _json(report["info"]["tcb_info"])["app_compose"]
    ch = hashlib.sha256(compose.encode()).digest()
    if bytes.fromhex(q["mr_config_id"]) != b"\x01" + ch + bytes(15):
        raise ValueError("MRCONFIGID does not match app_compose")
    ok("MRCONFIGID matches the measured app_compose", ch.hex())
    if replay_rtmr3(report["event_log"]) != bytes.fromhex(q["rt_mr3"]):
        raise ValueError("RTMR3 event log replay mismatch")
    ok("RTMR3 event log replays")
    if check_gpu(report, nonce):
        ok("NVIDIA GPU attestation (NRAS)")
    return {"signing_address": report["signing_address"].lower(), "signing_algo": report["signing_algo"], "tcb_status": verified.status, "compose_hash": ch.hex(), "checks": checks}


async def main():
    model = sys.argv[1]
    nonce = secrets.token_hex(32)
    qs = urllib.parse.urlencode({"model": model, "provider": "near", "signing_algo": "ecdsa", "nonce": nonce, "include_tls_fingerprint": "false"})
    raw = http(API + "?" + qs, headers={"x-no-aliasing": "true", "Accept": "application/json"})
    body = json.loads(raw)
    result = {"model": model, "nonce": nonce, "report_sha256": hashlib.sha256(raw).hexdigest(), "gateway": None, "models": [], "ok": False}
    try:
        result["gateway"] = await check(body["gateway_attestation"], nonce)
        cands = body.get("model_attestations") or []
        if not cands:
            raise ValueError("no NEAR model evidence returned")
        for c in cands:
            result["models"].append(await check(c, nonce))
        result["ok"] = True
    except Exception as e:  # report what failed, never pretend
        result["error"] = str(e)
    if len(sys.argv) > 2:
        open(sys.argv[2], "wb").write(raw)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["ok"] else 1)


asyncio.run(main())
