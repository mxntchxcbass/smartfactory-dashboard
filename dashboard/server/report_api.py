# -*- coding: utf-8 -*-
"""스마트팩토리 실시간 대시보드 — 로그/집계 서버 (모델 없음, 경량)

역할:
  · 대시보드(브라우저)가 보내는 매 판정을 predictions.jsonl 에 기록
  · 0등급(불량) 이면 n8n Webhook 으로 서버 간 중계 → Discord 알림
  · n8n 스케줄이 /daily_report 를 호출 → 당일 집계 + 이메일용 본문 반환

실행:
  uvicorn report_api:app --host 127.0.0.1 --port 8000 --app-dir server   (로컬)
  (또는 server 폴더에서:  uvicorn report_api:app --host 127.0.0.1 --port 8000)

엔드포인트: GET /health · POST /ingest · POST /ingest_batch · POST /ai · GET /daily_report
"""
import os
import json
import time
import datetime
import urllib.request
from typing import List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE = os.path.dirname(os.path.abspath(__file__))
_cfg_path = os.path.join(BASE, "config.json")
CFG = json.load(open(_cfg_path, encoding="utf-8")) if os.path.exists(_cfg_path) else {}
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(BASE, "logs"))
os.makedirs(LOG_DIR, exist_ok=True)
PRED_LOG = os.path.join(LOG_DIR, "predictions.jsonl")
AI_LOG = os.path.join(LOG_DIR, "ai.jsonl")

LABELS = CFG.get("class_labels", {"0": "불량", "1": "정상", "2": "양품"})
N8N_URL = os.environ.get("N8N_WEBHOOK_URL") or CFG.get("n8n_webhook_url", "")
# AI 에이전트 웹훅: config 에 없으면 defect 웹훅 베이스에서 /webhook/ai 로 유도
AI_N8N_URL = os.environ.get("N8N_AI_WEBHOOK_URL") or CFG.get("n8n_ai_webhook_url", "")
if not AI_N8N_URL and N8N_URL:
    AI_N8N_URL = N8N_URL.split("/webhook")[0] + "/webhook/ai"

# 대시보드 정적 파일 폴더 (server 의 상위)
DASH_DIR = os.path.dirname(BASE)
# Discord 알림 최소 간격(초) — 공개 배포 시 과도한 알림 폭주 방지 (0 = 제한 없음)
DISCORD_MIN_INTERVAL = float(
    os.environ.get("DISCORD_MIN_INTERVAL_SEC")
    or CFG.get("discord_min_interval_sec", 0) or 0)
_last_discord = [0.0]
# 시뮬레이션 경계 리포트: 주기별 직전 발송 시각(그 이후 레코드만 집계) — 서버 시작 시각으로 초기화
_report_since = {p: datetime.datetime.now().isoformat(timespec="seconds")
                 for p in ("daily", "weekly", "monthly")}

app = FastAPI(title="스마트팩토리 리포트 서버", version="1.0")
# 대시보드(브라우저)에서 직접 호출하므로 CORS 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000",
                   "http://127.0.0.1:5500"],
    allow_origin_regex=r"^https://[a-z0-9-]+\.vercel\.app$",
    allow_methods=["*"], allow_headers=["*"],
)


# ---------- 모델 ----------
class Pred(BaseModel):
    id: str
    product_group: str
    grade: int
    grade_label: str = ""
    y_quality: float = 0.0
    confidence: float = 0.0
    missing: int = 0
    ts: Optional[str] = None


class Batch(BaseModel):
    items: List[Pred]


class AiReq(BaseModel):
    mode: str = "chat"        # 'report' | 'chat'
    question: str = ""
    context: dict = {}


# ---------- 유틸 ----------
def _now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _today():
    return datetime.date.today().isoformat()


def _append(path, rec):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _notify_n8n(rec):
    """0·2 불량을 n8n Webhook 으로 중계. 쿨다운으로 과도한 알림 방지, 실패는 조용히 무시."""
    if not N8N_URL:
        return False
    now = time.time()
    if DISCORD_MIN_INTERVAL > 0 and (now - _last_discord[0]) < DISCORD_MIN_INTERVAL:
        return False   # 쿨다운 중 — 알림 폭주 방지
    try:
        data = json.dumps(rec, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            N8N_URL, data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=3)
        _last_discord[0] = now
        return True
    except Exception:
        return False


def _call_ai_n8n(payload, timeout=60):
    """AI 요청을 n8n /webhook/ai 로 중계하고 Claude 응답(JSON)을 반환. 실패 시 None."""
    if not AI_N8N_URL:
        return None
    try:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            AI_N8N_URL, data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        return json.loads(raw)
    except Exception:
        return None


def _normalize(rec):
    rec["ts"] = rec.get("ts") or _now_iso()
    if not rec.get("grade_label"):
        rec["grade_label"] = LABELS.get(str(rec.get("grade")), "")
    return rec


# ---------- 엔드포인트 ----------
def _n8n_alive():
    """n8n 인스턴스 실제 실행 여부 (webhook 경로와 별개인 /healthz). 클라우드 기준."""
    url = AI_N8N_URL or N8N_URL
    if not url:
        return False
    try:
        base = url.split("/webhook")[0]
        urllib.request.urlopen(base + "/healthz", timeout=2.0)
        return True
    except Exception:
        return False


@app.get("/health")
def health():
    return {"status": "ok",
            "build": os.environ.get("RAILWAY_GIT_COMMIT_SHA", "local")[:7],
            "n8n_configured": bool(N8N_URL),
            "n8n_alive": _n8n_alive(), "ai_configured": bool(AI_N8N_URL),
            "ts": _now_iso()}


@app.post("/ingest")
def ingest(p: Pred):
    rec = _normalize(p.dict())
    _append(PRED_LOG, rec)
    notified = _notify_n8n(rec) if rec["grade"] != 1 else False  # 0·2 모두 불량
    return {"ok": True, "notified_n8n": notified}


@app.post("/ingest_batch")
def ingest_batch(b: Batch):
    n = 0
    for p in b.items:
        _append(PRED_LOG, _normalize(p.dict()))
        n += 1
    return {"ok": True, "count": n}


@app.post("/ai")
def ai(r: AiReq):
    """대시보드 AI 요청을 n8n(Claude)으로 중계. 실패 시 ok=False → 브라우저가 SIM 응답 사용."""
    payload = {"mode": r.mode, "question": r.question, "context": r.context}
    result = _call_ai_n8n(payload)
    ok = bool(isinstance(result, dict) and result.get("text"))
    _append(AI_LOG, {"ts": _now_iso(), "mode": r.mode, "ok": ok})
    if ok:
        return {"ok": True, "source": "live", "text": result["text"]}
    return {"ok": False, "source": "sim"}


def _read_day(date):
    recs = []
    if not os.path.exists(PRED_LOG):
        return recs
    with open(PRED_LOG, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if (r.get("ts") or "").startswith(date):
                recs.append(r)
    return recs


@app.get("/daily_report")
def daily_report(date: str = ""):
    date = date or _today()
    recs = _read_day(date)
    total = len(recs)
    by_grade = {0: 0, 1: 0, 2: 0}
    by_fam = {"A": 0, "TO": 0}
    defects = []
    conf_sum = 0.0
    for r in recs:
        g = r.get("grade")
        if g in by_grade:
            by_grade[g] += 1
        fam = r.get("product_group")
        if fam in by_fam:
            by_fam[fam] += 1
        conf_sum += r.get("confidence", 0) or 0
        if g != 1:                      # 0(저품질)·2(고품질) 모두 불량
            defects.append(r)
    defect_count = by_grade[0] + by_grade[2]
    defect_rate = round(defect_count / total * 100, 1) if total else 0.0
    avg_conf = round(conf_sum / total * 100, 1) if total else 0.0
    top_def = [
        {"id": d.get("id"), "product_group": d.get("product_group"),
         "y_quality": d.get("y_quality"), "ts": d.get("ts")}
        for d in defects[-10:][::-1]
    ]

    # 이메일용 텍스트 본문
    lines = [
        f"[스마트팩토리 품질 데일리 리포트] {date}",
        f"총 처리: {total}건",
        f"등급 분포 — 불량·저(0) {by_grade[0]} / 정상(1) {by_grade[1]} / 불량·고(2) {by_grade[2]}",
        f"불량률(0·2): {defect_rate}%  (검출 {defect_count}건)",
        f"제품군 — A {by_fam['A']} / TO {by_fam['TO']}",
        f"평균 신뢰도: {avg_conf}%",
        "",
        "최근 불량 제품:",
    ]
    if top_def:
        for d in top_def:
            lines.append(f"  · {d['id']} ({d['product_group']}) Y={d['y_quality']} @ {d['ts']}")
    else:
        lines.append("  (없음)")
    report_text = "\n".join(lines)

    # 이메일용 HTML 본문
    rows = "".join(
        f"<tr><td>{d['id']}</td><td>{d['product_group']}</td>"
        f"<td>{d['y_quality']}</td><td>{d['ts']}</td></tr>"
        for d in top_def
    )
    report_html = f"""<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:640px;color:#111">
  <h2 style="margin:0 0 4px">🏭 스마트팩토리 품질 데일리 리포트</h2>
  <p style="color:#666;margin:0 0 16px">{date}</p>
  <table cellpadding="7" style="border-collapse:collapse;font-size:14px">
    <tr><td>총 처리</td><td><b>{total}</b> 건</td></tr>
    <tr><td>🔴 불량·저(0)</td><td style="color:#d03b3b"><b>{by_grade[0]}</b> 건</td></tr>
    <tr><td>🟢 정상(1·양품)</td><td style="color:#0ca30c">{by_grade[1]} 건</td></tr>
    <tr><td>🟠 불량·고(2)</td><td style="color:#e8913a">{by_grade[2]} 건</td></tr>
    <tr><td><b>불량률(0·2)</b></td><td style="color:#d03b3b"><b>{defect_rate}%</b> (검출 {defect_count}건)</td></tr>
    <tr><td>제품군</td><td>A {by_fam['A']} / TO {by_fam['TO']}</td></tr>
    <tr><td>평균 신뢰도</td><td>{avg_conf}%</td></tr>
  </table>
  <h3 style="margin:18px 0 6px">최근 불량 제품</h3>
  <table cellpadding="6" border="1" style="border-collapse:collapse;font-size:13px;border-color:#ddd">
    <tr style="background:#f5f5f4"><th>제품 ID</th><th>제품군</th><th>Y_Quality</th><th>시각</th></tr>
    {rows or '<tr><td colspan="4" style="text-align:center;color:#888">불량 없음</td></tr>'}
  </table>
</div>"""

    return {
        "date": date, "total": total, "by_grade": by_grade, "by_family": by_fam,
        "defect_count": defect_count, "defect_rate": defect_rate,
        "avg_confidence": avg_conf, "top_defects": top_def,
        "report_text": report_text, "report_html": report_html,
    }


@app.post("/report_now")
def report_now(period: str = "daily"):
    """대시보드 시뮬레이션 경계에서 브라우저가 호출 → 직전 발송 이후 구간을 집계해 해당 주기 리포트 발송."""
    if period not in ("daily", "weekly", "monthly"):
        period = "daily"
    since = _report_since.get(period)
    _report_since[period] = _now_iso()
    labels = {"daily": "일간", "weekly": "주간", "monthly": "월간"}
    import threading

    def _run():
        try:
            from send_report import send_since
            send_since(since, "시뮬레이션 " + labels[period] + " 마감", labels[period])
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True}


@app.on_event("startup")
def _startup_report():
    """서버(대시보드)를 켤 때 지정 주기 리포트를 1회 발송.
       config report_on_startup = 주기 목록 (예: ["weekly","monthly"]) 또는 단일 문자열. 비면 비활성.
       Render 클라우드에선 콜드스타트마다 발송되는 스팸을 막기 위해 스킵(로컬 전용)."""
    periods = CFG.get("report_on_startup") or []
    if isinstance(periods, str):
        periods = [periods]
    periods = [p for p in periods if p in ("daily", "weekly", "monthly")]
    if not periods or os.environ.get("RENDER") or os.environ.get("RAILWAY_ENVIRONMENT"):
        return
    import threading

    def _run():
        try:
            from send_report import send
            for p in periods:
                send(p)
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True).start()


# ---------- 대시보드 정적 파일 (API 라우트 뒤에 등록해야 /ai 등이 가려지지 않음) ----------
@app.get("/")
def _dash_index():
    return FileResponse(os.path.join(DASH_DIR, "index.html"))


@app.get("/app.js")
def _dash_appjs():
    return FileResponse(os.path.join(DASH_DIR, "app.js"), media_type="application/javascript")


@app.get("/data.js")
def _dash_datajs():
    return FileResponse(os.path.join(DASH_DIR, "data.js"), media_type="application/javascript")


@app.get("/lines.js")
def _dash_linesjs():
    return FileResponse(os.path.join(DASH_DIR, "lines.js"), media_type="application/javascript")


if os.path.isdir(os.path.join(DASH_DIR, "img")):
    app.mount("/img", StaticFiles(directory=os.path.join(DASH_DIR, "img")), name="img")
