# 스마트팩토리 실시간 품질 모니터링 대시보드

공정 센서 데이터로 제품 품질을 실시간 판정하고, **불량(0·2등급)은 Discord로 즉시 알림**,
**하루 요약은 매일 Gmail로 리포트**하는 대시보드입니다.

---

## 📦 구성

```
smartfactory_html_dashboard/
├── index.html            # 실시간 대시보드 — 토큰·CSS·탭 마크업 (Kraken 디자인 시스템)
├── app.js                # 대시보드 로직 — 재생·차트·렌더러
├── DESIGN-NOTES.md       # 변환 노트 (디자인 시스템 적용 내역·판단 근거)
├── index_legacy_backup.html  # 변환 이전 원본 (다크 테마·단일 스크롤)
├── data.js               # 실제 선택피처 데이터 (A 316 · TO 592행) 재생용
├── img/                  # 분석 시각화 이미지
├── server/
│   ├── report_api.py     # FastAPI 로그·집계 서버 (모델 없음, 경량)
│   ├── config.json       # n8n 웹훅 주소·임계값·등급 라벨
│   └── logs/             # predictions.jsonl (자동 생성)
├── n8n/
│   ├── wf_discord.json   # 불량 → Discord 알림 워크플로우
│   └── wf_daily.json     # 매일 09:00 → Gmail 리포트 워크플로우
└── README.md
```

## 🔄 데이터 흐름

```
브라우저 대시보드 ──매 판정──▶ FastAPI /ingest ──(0·2 불량)──▶ n8n Webhook ──▶ 🔔 Discord
                                    └ predictions.jsonl 기록
n8n 매일 09:00 ──▶ FastAPI /daily_report(집계) ──▶ 📧 Gmail 리포트
```

- 등급: **0·2 = 불량** (0 저품질 / 2 고품질) · **1 = 정상(양품)** — 규격을 벗어나면 낮아도 높아도 불량
- 서버가 없어도 대시보드는 **SIM 모드**로 항상 동작합니다(로그/알림만 비활성).

---

## ▶ 실행 순서

### 1) FastAPI 서버
```bash
python -m uvicorn report_api:app --host 127.0.0.1 --port 8000 --app-dir "C:/Users/Administrator/Desktop/smartfactory_html_dashboard/server"
```
> 최초 1회 패키지 설치가 필요하면: `pip install fastapi uvicorn`

### 2) 대시보드 (로컬 서버로 열기 — `file://` 아님)
```bash
python -m http.server 8823 --directory "C:/Users/Administrator/Desktop/smartfactory_html_dashboard"
```
브라우저에서 **http://localhost:8823** 접속.

화면은 왼쪽 사이드바의 **6개 탭**으로 나뉩니다 (스크롤 없이 탭 전환):

| 탭 | 내용 |
|---|---|
| 01 개요 | 핵심 KPI 4개 · 불량률 추이 · 등급 구성 · 제품군별 불량률 |
| 02 판정 스트림 | 판정 결과 표(CSV 내보내기) · 판정 근거 드릴다운 |
| 03 정밀검사 큐 | 재검 진행 관리 · 알림 로그 |
| 04 공정 변수 | 핵심 센서 관리한계(±3σ) 감시 |
| 05 모델 성능 | 등급별 F1 · 불량 검출률 · 혼동행렬 |
| 06 데이터 신뢰성 | 결측 · 드리프트 · 등급 경계 임계값 · 데이터 계보 |

사이드바 하단 **연동 상태** 배지 의미:
- `SIM 모드` — FastAPI 꺼짐 (시뮬레이션만)
- `API 연결 · n8n 대기` — FastAPI 켜짐, n8n 아직 꺼짐
- `연동 LIVE` — FastAPI + n8n 모두 실행 중

> 인터넷이 차단된 환경에서는 IBM Plex Sans(Google Fonts)를 못 받아와 시스템 폰트로 대체됩니다.
> 레이아웃과 기능에는 영향이 없습니다.

### 3) n8n (브라우저 UI, `127.0.0.1:5678`)
`n8n/wf_discord.json`, `n8n/wf_daily.json` 을 각각 **Import from File** 로 불러옵니다.

---

## ⚙️ n8n 설정 (비밀값은 직접 입력)

### 🔔 Discord 알림 — `wf_discord.json`
1. Discord 채널 → **채널 편집 → 연동 → 웹훅 → 새 웹훅 → URL 복사**
2. n8n **`Discord 전송`** 노드의 `url` 에 붙여넣기 (`PASTE-YOUR-DISCORD-WEBHOOK-URL` 교체)
3. 워크플로우 **Active ON**
4. 운영 웹훅 경로가 `http://127.0.0.1:5678/webhook/defect` 인지 확인
   → `server/config.json` 의 `n8n_webhook_url` 과 일치해야 함

### 📧 데일리 리포트 — `wf_daily.json`
1. Gmail **2단계 인증 → 앱 비밀번호** 생성 (16자리)
2. n8n **Credentials → New → SMTP**:
   - Host `smtp.gmail.com` · Port `465` · SSL 사용
   - User `본인@gmail.com` · Password `앱 비밀번호`
3. **`Gmail 발송 (SMTP)`** 노드: `fromEmail`·`toEmail` 을 실제 주소로 교체, 위 SMTP 자격증명 연결
4. 스케줄 `0 9 * * *`(매일 09:00) — 필요 시 조정
5. 워크플로우 **Active ON**
6. 즉시 테스트하려면 `집계 요청` 노드부터 수동 실행(Execute)

---

## ✅ 동작 확인
- 대시보드 재생 중 → `server/logs/predictions.jsonl` 에 판정이 쌓임
- 브라우저에서 집계 확인: **http://127.0.0.1:8000/daily_report**
- 0·2 불량 발생 → Discord 채널에 알림 (n8n Active 시)

## 🛠 트러블슈팅
| 증상 | 확인 |
|---|---|
| 배지가 계속 `SIM` | FastAPI 실행/포트(8000) 확인, `Ctrl+Shift+R` 하드 리프레시 |
| n8n 연결 안 됨 | 주소는 반드시 `127.0.0.1` (n8n이 localhost를 IPv6 `::1`로 잡아 실패) |
| Discord 안 옴 | 웹훅 URL·워크플로우 Active·`config.json` 경로 일치 |
| 메일 안 옴 | 앱 비밀번호·SMTP 465·수신함/스팸함 확인 |
| 대시보드 수정 반영 안 됨 | 브라우저 하드 리프레시 `Ctrl+Shift+R` |
| 화면이 빈 채로 멈춤 | `app.js`가 같은 폴더에 있는지 확인 (개발자도구 Console 확인) |
| 폰트가 다르게 보임 | 외부 네트워크 차단 환경 — 기능 영향 없음 |
| "재생이 멈춰 있어…" 배너 | 정상 동작. 일시정지 상태를 알리는 배너로, `재생 시작`을 누르면 사라집니다 |
