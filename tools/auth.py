#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
플러그인용 refresh token 발급 — 서버에서 끝낸다 (브라우저는 PC 것을 빌린다).

  python3 tools/auth.py url            로그인 주소를 찍는다
  python3 tools/auth.py code <코드>     주소창의 code 로 토큰을 만든다

권한 범위를 일부러 좁게 잡았다.

  drive.readonly  vault 를 목록 조회하고 내려받는다
  drive.file      **이 앱이 만든 파일만** 다룬다

두 번째가 핵심이다. `drive.file` 은 남이 만든 파일을 고치거나 지울 수 없어서,
"새 파일만 올리고 기존 파일은 절대 안 건드린다"는 설계가 코드가 아니라
**Google 쪽에서 강제**된다. 플러그인에 버그가 있어도 기존 노트를 못 망친다.

클라이언트는 서버와 같은 것을 쓴다(~/.opsidian_gcal_client.json).
stdlib 만 쓴다.
"""

import os
import sys
import json
import base64
import hashlib
import secrets
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
CLIENT_FILE = HOME / ".opsidian_gcal_client.json"
VERIFIER_FILE = HOME / ".obsidian_plugin_verifier"
SCOPE = ("https://www.googleapis.com/auth/drive.readonly"
         " https://www.googleapis.com/auth/drive.file")
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
PORT = 8767                      # 캘린더(8765)·챗(8766) 과 겹치지 않게


def load_client():
    d = json.loads(CLIENT_FILE.read_text(encoding="utf-8"))
    d = d.get("installed") or d.get("web") or d
    return d["client_id"], d.get("client_secret", "")


def post_form(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print("토큰 요청 실패 (%s)" % e.code)
        print("  " + e.read().decode("utf-8", "replace")[:400])
        sys.exit(1)


def cmd_url():
    cid, _ = load_client()
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    VERIFIER_FILE.write_text(verifier, encoding="utf-8")
    try:
        os.chmod(VERIFIER_FILE, 0o600)
    except OSError:
        pass
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": cid,
        "redirect_uri": "http://localhost:%d" % PORT,
        "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent",
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    print("아래 주소를 PC 브라우저에서 여세요.\n")
    print("  " + url + "\n")
    print("로그인하면 localhost:%d 로 넘어가며 '연결할 수 없음' 이 뜹니다. 정상입니다." % PORT)
    print("주소창의 code= 뒤 값(& 앞까지)을 복사해서:\n")
    print("  python3 tools/auth.py code <복사한 값>")


def cmd_code(code):
    if not VERIFIER_FILE.exists():
        print("먼저 `python3 tools/auth.py url` 을 실행하세요.")
        sys.exit(1)
    cid, csec = load_client()
    verifier = VERIFIER_FILE.read_text(encoding="utf-8").strip()
    code = urllib.parse.unquote(code.strip()).split("&")[0]
    tok = post_form(TOKEN_URL, {
        "code": code, "client_id": cid, "client_secret": csec,
        "redirect_uri": "http://localhost:%d" % PORT,
        "grant_type": "authorization_code", "code_verifier": verifier,
    })
    if "refresh_token" not in tok:
        print("refresh_token 이 안 왔습니다. 계정 설정에서 앱 액세스를 지우고 다시 하세요.")
        sys.exit(1)
    VERIFIER_FILE.unlink(missing_ok=True)
    print("\n=== 플러그인 설정에 넣을 값 ===")
    print("  클라이언트 ID   :", cid)
    print("  클라이언트 시크릿:", csec)
    print("  Refresh token   :", tok["refresh_token"])
    print("\n이 값들은 아이패드에만 저장되고 .obsidian 은 동기화하지 않으므로 다른 기기로 넘어가지 않습니다.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "url":
        cmd_url()
    elif cmd == "code" and len(sys.argv) > 2:
        cmd_code(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)
