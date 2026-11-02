# GDrive Vault Sync

Obsidian vault 를 Google Drive 와 맞추는 플러그인. **아이패드(iOS)에서 동작한다.**

출장 중 아이패드만 들고 가서 회의록을 쓰고, 돌아와 합치는 용도로 만들었다.

## 설계 원칙

2026-10 에 다른 동기화 플러그인으로 Drive 에 중복 파일 73개가 생긴 일이 있었다.
그 원인을 구조로 막아 두었다.

1. **상태 파일을 두지 않는다.** `changesToken`·`lastSyncedAt` 같은 기기별 값을 저장하지
   않고 매번 Drive 를 직접 조회해 비교한다. 기기 사이에 덮어쓸 상태가 없으므로 어긋날 수가 없다.
2. **`.obsidian/` 을 건드리지 않는다.** 설정 폴더 동기화가 그 사고의 뿌리였다.
   설정으로도 풀 수 없게 코드에 고정했다.
3. **삭제하지 않는다.** 올리기는 새 파일만, 내려받기는 Drive 가 더 최신일 때만.
4. **권한을 좁게 받는다.** `drive.readonly` + `drive.file` 만 쓴다.
   `drive.file` 은 이 앱이 만든 파일 외에는 고치거나 지울 수 없어,
   "기존 노트를 건드리지 않는다"가 Google 쪽에서 강제된다.

## 단계

- [x] **0단계** 연결 확인 — 목록 조회만, 쓰기 없음
- [x] **1단계** 다운로드 — Drive → 로컬
- [x] **2단계** 업로드 — 새로 쓴 파일만 Drive 로

## 설치

[BRAT](https://github.com/TfTHacker/obsidian42-brat) 으로 설치한다.
BRAT → `Add beta plugin` → `Hyunsu89/obsidian-gdrive-vault-sync`

## 설정

| 항목 | 설명 |
|---|---|
| 클라이언트 ID / 시크릿 | Google Cloud OAuth 클라이언트 (데스크톱 앱 유형) |
| Refresh token | `tools/auth.py` 로 발급 |
| 루트 폴더 ID | Drive 의 vault 폴더 ID |
| 제외할 최상위 폴더 | 쉼표 구분. `.obsidian` `.trash` 는 항상 제외 |

자격증명은 플러그인 설정(`.obsidian/plugins/.../data.json`)에만 저장되고,
`.obsidian` 은 동기화 대상이 아니므로 다른 기기로 넘어가지 않는다.

## 토큰 발급

```bash
python3 tools/auth.py url            # 주소를 PC 브라우저에서 연다
python3 tools/auth.py code <코드>     # 주소창의 code 로 토큰을 만든다
```

## 명령

- `Drive 연결 확인` — 인증과 최상위 폴더 목록 확인
- `Drive 전체 스캔 (읽기만)` — 재귀 조회로 파일 수·용량 집계
