# -*- coding: utf-8 -*-
"""스마트팩토리 품질 리포트 — 로컬에서 집계 후 n8n 웹훅으로 push (n8n이 이메일 발송).

사용:
  python send_report.py --period daily|weekly|monthly

- send(period): 기간(오늘/최근7일/최근30일) 기준 집계 후 발송
- send_since(since_iso, label): since_iso 이후 레코드만 집계 후 발송
  (대시보드 시뮬레이션 하루 경계에서 FastAPI /report_now 가 호출)
stdlib 만 사용 — FastAPI 실행 여부와 무관.
"""
import os
import json
import argparse
import datetime
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
_cfg_path = os.path.join(BASE, "config.json")
CFG = json.load(open(_cfg_path, encoding="utf-8")) if os.path.exists(_cfg_path) else {}
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(BASE, "logs"))
PRED_LOG = os.path.join(LOG_DIR, "predictions.jsonl")
LABELS = CFG.get("class_labels", {"0": "불량·저", "1": "정상", "2": "불량·고"})
REPORT_URL = os.environ.get("N8N_REPORT_WEBHOOK_URL") or CFG.get("n8n_report_webhook_url", "")

PERIODS = {"daily": ("일간", 1), "weekly": ("주간", 7), "monthly": ("월간", 30)}


def _iter_records():
    if not os.path.exists(PRED_LOG):
        return
    with open(PRED_LOG, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def _read_range(days):
    """오늘 포함 최근 N일의 판정 레코드."""
    today = datetime.date.today()
    start = today - datetime.timedelta(days=days - 1)
    recs = []
    for r in _iter_records():
        ts = (r.get("ts") or "")[:10]
        if not ts:
            continue
        try:
            d = datetime.date.fromisoformat(ts)
        except Exception:
            continue
        if start <= d <= today:
            recs.append(r)
    return recs, start, today


def _read_since(since_iso):
    """since_iso(ISO 문자열) 이후 판정 레코드. since_iso 가 falsy 면 전체."""
    recs = []
    for r in _iter_records():
        ts = r.get("ts") or ""
        if (not since_iso) or ts > since_iso:
            recs.append(r)
    return recs


def _aggregate(recs, label, rng):
    """레코드 목록 → {subject, html, total, defect_rate}."""
    total = len(recs)
    by_grade = {0: 0, 1: 0, 2: 0}
    by_fam = {"A": 0, "TO": 0}
    conf_sum = 0.0
    defects = []
    for r in recs:
        g = r.get("grade")
        if g in by_grade:
            by_grade[g] += 1
        fam = r.get("product_group")
        if fam in by_fam:
            by_fam[fam] += 1
        conf_sum += r.get("confidence", 0) or 0
        if g != 1:                       # 0(저품질)·2(고품질) 모두 불량
            defects.append(r)
    defect_count = by_grade[0] + by_grade[2]
    defect_rate = round(defect_count / total * 100, 1) if total else 0.0
    avg_conf = round(conf_sum / total * 100, 1) if total else 0.0
    top = [
        {"id": d.get("id"), "product_group": d.get("product_group"),
         "y_quality": d.get("y_quality"), "ts": d.get("ts")}
        for d in defects[-10:][::-1]
    ]
    rows = "".join(
        f"<tr><td>{d['id']}</td><td>{d['product_group']}</td>"
        f"<td>{d['y_quality']}</td><td>{d['ts']}</td></tr>"
        for d in top
    )
    html = f"""<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:640px;color:#111">
  <h2 style="margin:0 0 4px">🏭 스마트팩토리 품질 {label} 리포트</h2>
  <p style="color:#666;margin:0 0 16px">{rng}</p>
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
  <p style="color:#999;font-size:12px;margin-top:16px">반갑다모 7팀 · 자동 생성 리포트</p>
</div>"""
    subject = f"[스마트팩토리] {label} 품질 리포트 {rng} · 불량률 {defect_rate}%"
    return {"subject": subject, "html": html, "total": total, "defect_rate": defect_rate}


def build_report(period):
    label, days = PERIODS[period]
    recs, start, today = _read_range(days)
    rng = start.isoformat() if period == "daily" else (start.isoformat() + " ~ " + today.isoformat())
    return _aggregate(recs, label, rng)


def _post(rep):
    print(f"집계: 총 {rep['total']}건 · 불량률 {rep['defect_rate']}%")
    if not REPORT_URL:
        print("config.json 의 n8n_report_webhook_url 이 비어 있어 발송을 건너뜁니다.")
        return False
    payload = json.dumps({"subject": rep["subject"], "html": rep["html"]},
                         ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        REPORT_URL, data=payload,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"n8n 전송 완료 (HTTP {resp.status}): {resp.read().decode('utf-8')[:200]}")
        return True
    except Exception as e:
        print(f"n8n 전송 실패: {e}")
        print("→ n8n 워크플로우가 Publish(활성) 상태인지, 웹훅 주소가 맞는지 확인하세요.")
        return False


def send(period):
    """기간 리포트 발송."""
    return _post(build_report(period))


def send_since(since_iso, rng_label, period_label="일간"):
    """since_iso 이후 레코드만 집계해 발송 (시뮬레이션 경계용). period_label = 일간|주간|월간."""
    return _post(_aggregate(_read_since(since_iso), period_label, rng_label))


def main():
    ap = argparse.ArgumentParser(description="스마트팩토리 품질 리포트 발송")
    ap.add_argument("--period", choices=list(PERIODS), default="daily")
    args = ap.parse_args()
    send(args.period)


if __name__ == "__main__":
    main()
