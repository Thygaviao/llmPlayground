#!/usr/bin/env python3
"""
HTTP-сервер для тренажера разметки и оценки ответов LLM.
Не требует сторонних зависимостей (работает на чистом Python 3).
"""

import csv
import io
import json
import os
import sqlite3
import sys
import urllib.request
from http import HTTPStatus
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).parent.resolve()
DB_PATH = BASE_DIR / "train.db"
PORT = 8000


def load_env():
    """Загрузка конфигурации из .env файла"""
    env_vars = {}
    env_file = BASE_DIR / ".env"
    if env_file.exists():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env_vars[k.strip()] = v.strip()
    return env_vars


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=15000;")
        conn.execute("PRAGMA synchronous=NORMAL;")
    except Exception:
        pass
    return conn


def calculate_agreement(user_scores, gold_standard, user_errors, user_pref=None):
    """
    Рассчитывает процент согласованности оценки асессора с эталоном эксперта (0-100%)
    и возвращает подробную декомпозицию вклада каждого компонента.
    """
    gold_pref = gold_standard.get("preferred")
    gold_errors = gold_standard.get("errors_present", [])
    criteria = ["instruction_following", "factuality", "completeness", "coherence_literacy"]
    
    # 1. Сравнение шкал (1-5)
    if gold_pref and ("scores_a" in gold_standard or "scores_b" in gold_standard):
        gold_a = gold_standard.get("scores_a", {})
        gold_b = gold_standard.get("scores_b", {})
        user_a = user_scores.get("scores_a") if isinstance(user_scores, dict) and "scores_a" in user_scores else user_scores
        user_b = user_scores.get("scores_b") if isinstance(user_scores, dict) and "scores_b" in user_scores else user_scores
        
        diff_a = sum(abs(float(user_a.get(c, 3)) - float(gold_a.get(c, 3))) for c in criteria)
        diff_b = sum(abs(float(user_b.get(c, 3)) - float(gold_b.get(c, 3))) for c in criteria)
        total_score_diff = diff_a + diff_b
        max_possible_diff = 32.0  # 4 критерия * 4 макс разница * 2 модели
    else:
        gold_scores = gold_standard.get("scores") or gold_standard.get("scores_a", {})
        total_score_diff = sum(abs(float(user_scores.get(c, 3)) - float(gold_scores.get(c, 3))) for c in criteria)
        max_possible_diff = 16.0

    score_match = max(0.0, 1.0 - (total_score_diff / max_possible_diff))

    # 2. Сравнение ошибок (Jaccard similarity по тегам ошибок)
    u_err = set(user_errors or [])
    g_err = set(gold_errors or [])
    if not u_err and not g_err:
        err_match = 1.0
    elif not u_err or not g_err:
        err_match = 0.3 if not g_err else 0.2
    else:
        err_match = len(u_err & g_err) / len(u_err | g_err)

    # 3. Side-by-Side совпадение
    pref_match = 1.0
    if gold_pref:
        if user_pref == gold_pref:
            pref_match = 1.0
        elif (user_pref and gold_pref) and ("model_a" in user_pref and "model_a" in gold_pref):
            pref_match = 0.8
        elif (user_pref and gold_pref) and ("model_b" in user_pref and "model_b" in gold_pref):
            pref_match = 0.8
        else:
            pref_match = 0.0

    # Взвешенный итоговый процент
    if gold_pref:
        w_score = 0.4
        w_err = 0.3
        w_pref = 0.3
        final_agreement = (score_match * w_score + err_match * w_err + pref_match * w_pref) * 100
    else:
        w_score = 0.6
        w_err = 0.4
        w_pref = 0.0
        final_agreement = (score_match * w_score + err_match * w_err) * 100

    breakdown = {
        "score_match_pct": round(score_match * 100, 1),
        "score_contribution": round(score_match * w_score * 100, 1),
        "err_match_pct": round(err_match * 100, 1),
        "err_contribution": round(err_match * w_err * 100, 1),
        "pref_match_pct": round(pref_match * 100, 1) if gold_pref else None,
        "pref_contribution": round(pref_match * w_pref * 100, 1) if gold_pref else None,
        "weights": {
            "scores": int(w_score * 100),
            "errors": int(w_err * 100),
            "preference": int(w_pref * 100)
        }
    }

    return round(final_agreement, 1), breakdown


class TrainerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def address_string(self):
        # Быстрый возврат IP клиента без медленного socket.getfqdn()
        # Устраняет задержку 5-10 секунд при обработке запросов на macOS/Linux
        return self.client_address[0]

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        
        if parsed.path == "/api/cases":
            self.handle_get_cases()
        elif parsed.path == "/api/cv-cases":
            self.handle_get_cv_cases()
        elif parsed.path == "/api/nlp-cases":
            self.handle_get_nlp_cases()
        elif parsed.path == "/api/stats":
            self.handle_get_stats(parsed.query)
        elif parsed.path == "/api/llm-config":
            self.handle_get_llm_config()
        elif parsed.path == "/api/custom-annotations":
            self.handle_get_custom_annotations()
        elif parsed.path == "/api/export-csv":
            self.handle_export_csv()
        elif parsed.path == "/api/export-json":
            self.handle_export_json()
        elif parsed.path == "/api/export-jsonl":
            self.handle_export_jsonl()
        elif parsed.path == "/api/export-legacy-fixture":
            self.handle_export_legacy_fixture()
        elif parsed.path == "/" or parsed.path == "":
            self.path = "/index.html"
            super().do_GET()
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/evaluations":
            self.handle_post_evaluation()
        elif parsed.path == "/api/custom-annotation":
            self.handle_post_custom_annotation()
        elif parsed.path == "/api/generate-llm":
            self.handle_generate_llm()
        else:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def handle_get_cases(self):
        conn = get_db()
        try:
            cases = conn.execute("SELECT * FROM cases").fetchall()
            result = []
            for c in cases:
                item = dict(c)
                item["gold_standard"] = json.loads(item["gold_standard_json"])
                del item["gold_standard_json"]
                result.append(item)
        finally:
            conn.close()

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))

    def handle_get_cv_cases(self):
        cv_file = BASE_DIR / "data" / "cv_cases.json"
        data = []
        if cv_file.exists():
            with open(cv_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def handle_get_nlp_cases(self):
        nlp_file = BASE_DIR / "data" / "nlp_cases.json"
        data = []
        if nlp_file.exists():
            with open(nlp_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def handle_get_stats(self, query_string):
        params = parse_qs(query_string)
        username = params.get("user", ["all"])[0]

        conn = get_db()
        try:
            if username == "all":
                rows = conn.execute("SELECT * FROM evaluations ORDER BY created_at DESC").fetchall()
            else:
                rows = conn.execute("SELECT * FROM evaluations WHERE username = ? ORDER BY created_at DESC", (username,)).fetchall()
        finally:
            conn.close()

        evals = [dict(r) for r in rows]
        for e in evals:
            e["scores"] = json.loads(e["scores_json"])
            e["errors"] = json.loads(e["errors_json"])

        avg_score = round(sum(e["agreement_score"] for e in evals) / len(evals), 1) if evals else 0.0

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps({
            "total_evaluations": len(evals),
            "average_agreement": avg_score,
            "evaluations": evals
        }, ensure_ascii=False).encode("utf-8"))

    def handle_post_evaluation(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        data = json.loads(body)

        username = data.get("username", "junior_assessor").strip() or "junior_assessor"
        case_id = data.get("case_id")
        scores = data.get("scores", {})
        errors = data.get("errors", [])
        preferred = data.get("preferred")
        reasoning = data.get("reasoning", "").strip()
        is_doubt = 1 if data.get("is_doubt") else 0
        doubt_reason = (data.get("doubt_reason") or "").strip()

        # 1. Валидация письменного обоснования
        if not reasoning:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "error",
                "message": "Письменное обоснование обязательно для заполнения."
            }, ensure_ascii=False).encode("utf-8"))
            return

        # Получаем эталон из базы
        conn = get_db()
        try:
            case_row = conn.execute("SELECT * FROM cases WHERE id = ?", (case_id,)).fetchone()
            if not case_row:
                self.send_error(HTTPStatus.NOT_FOUND, "Кейс не найден")
                return

            gold_standard = json.loads(case_row["gold_standard_json"])
            gold_scores = gold_standard.get("scores") or gold_standard.get("scores_a", {})
            gold_errors = gold_standard.get("errors_present", [])
            gold_pref = gold_standard.get("preferred")

            # 2. Валидация заполнения шкал
            criteria = ["instruction_following", "factuality", "completeness", "coherence_literacy"]
            missing_scores = False
            if gold_pref and ("scores_a" in gold_standard or "scores_b" in gold_standard):
                if not preferred:
                    missing_scores = True
                scores_a = scores.get("scores_a", scores) if isinstance(scores, dict) else {}
                scores_b = scores.get("scores_b", scores) if isinstance(scores, dict) else {}
                for c in criteria:
                    if scores_a.get(c) is None or scores_b.get(c) is None:
                        missing_scores = True
                        break
            else:
                for c in criteria:
                    if not isinstance(scores, dict) or scores.get(c) is None:
                        missing_scores = True
                        break

            if missing_scores:
                self.send_response(HTTPStatus.BAD_REQUEST)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "error",
                    "message": "Все обязательные шкалы оценок должны быть выбраны вручную до отправки."
                }, ensure_ascii=False).encode("utf-8"))
                return

            agreement_score, breakdown = calculate_agreement(
                user_scores=scores,
                gold_standard=gold_standard,
                user_errors=errors,
                user_pref=preferred
            )

            # Сохраняем в базу данных
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO evaluations (username, case_id, scores_json, errors_json, preferred, reasoning, agreement_score, is_doubt, doubt_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                username,
                case_id,
                json.dumps(scores, ensure_ascii=False),
                json.dumps(errors, ensure_ascii=False),
                preferred,
                reasoning,
                agreement_score,
                is_doubt,
                doubt_reason
            ))
            conn.commit()
        finally:
            conn.close()

        response_payload = {
            "status": "success",
            "agreement_score": agreement_score,
            "agreement_breakdown": breakdown,
            "gold_standard": gold_standard,
            "is_doubt": bool(is_doubt),
            "doubt_reason": doubt_reason,
            "feedback": {
                "gold_scores": gold_scores,
                "gold_scores_a": gold_standard.get("scores_a"),
                "gold_scores_b": gold_standard.get("scores_b"),
                "gold_errors": gold_errors,
                "gold_pref": gold_pref,
                "explanation": gold_standard.get("explanation", ""),
                "criteria_reasons": gold_standard.get("criteria_reasons", {}),
                "traps_summary": gold_standard.get("traps_summary", "")
            }
        }

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(response_payload, ensure_ascii=False).encode("utf-8"))

    def handle_export_csv(self):
        conn = get_db()
        try:
            rows = conn.execute("""
                SELECT e.id, e.username, e.case_id, c.title, c.category, e.agreement_score,
                       e.scores_json, e.errors_json, e.preferred, e.reasoning,
                       e.is_doubt, e.doubt_reason, e.created_at
                FROM evaluations e
                JOIN cases c ON e.case_id = c.id
                ORDER BY e.created_at DESC
            """).fetchall()
        finally:
            conn.close()

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "ID", "Сотрудник", "ID Кейса", "Название кейса", "Категория",
            "Балл согласованности (%)", "Оценки (JSON)", "Ошибки (JSON)",
            "Выбор SBS", "Обоснование асессора", "Спорный случай", "Причина сомнения", "Дата разметки"
        ])
        for r in rows:
            writer.writerow(list(r))

        csv_bytes = output.getvalue().encode("utf-8-sig")  # utf-8-sig для Excel
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="llm_evaluations_report.csv"')
        self.end_headers()
        self.wfile.write(csv_bytes)

    def handle_export_json(self):
        conn = get_db()
        try:
            rows = conn.execute("""
                SELECT e.id, e.username, e.case_id, c.title, c.category, e.agreement_score,
                       e.scores_json, e.errors_json, e.preferred, e.reasoning,
                       e.is_doubt, e.doubt_reason, e.created_at
                FROM evaluations e
                JOIN cases c ON e.case_id = c.id
                ORDER BY e.created_at DESC
            """).fetchall()
        finally:
            conn.close()

        records = []
        for r in rows:
            rec = dict(r)
            rec["scores"] = json.loads(rec["scores_json"])
            rec["errors"] = json.loads(rec["errors_json"])
            rec["is_doubt"] = bool(rec.get("is_doubt", 0))
            del rec["scores_json"]
            del rec["errors_json"]
            records.append(rec)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="llm_evaluations_report.json"')
        self.end_headers()
        self.wfile.write(json.dumps(records, ensure_ascii=False, indent=2).encode("utf-8"))

    def handle_post_custom_annotation(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        data = json.loads(body)

        username = (data.get("username") or "annotator").strip() or "annotator"
        mode = data.get("mode", "single")
        prompt = (data.get("prompt") or "").strip()
        source_text = (data.get("source_text") or "").strip() or None
        response_a = (data.get("response_a") or "").strip()
        response_b = (data.get("response_b") or "").strip() or None
        scores = data.get("scores", {})
        errors = data.get("errors", [])
        preferred = data.get("preferred")
        reasoning = (data.get("reasoning") or "").strip()
        is_doubt = 1 if data.get("is_doubt") else 0
        doubt_reason = (data.get("doubt_reason") or "").strip()

        # Валидация
        criteria = ["instruction_following", "factuality", "completeness", "coherence_literacy"]
        if not prompt or not response_a or (mode == "sbs" and not response_b):
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "message": "Заполните промпт и ответ(ы) модели."}, ensure_ascii=False).encode("utf-8"))
            return

        if not reasoning:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "message": "Письменное обоснование обязательно."}, ensure_ascii=False).encode("utf-8"))
            return

        if mode == "sbs":
            scores_a = scores.get("scores_a") if isinstance(scores, dict) else None
            scores_b = scores.get("scores_b") if isinstance(scores, dict) else None
            if not scores_a or not scores_b:
                self.send_response(HTTPStatus.BAD_REQUEST)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": "Оценки по 4 критериям должны быть заполнены отдельно для Модели A и Модели B."}, ensure_ascii=False).encode("utf-8"))
                return
            for c in criteria:
                if scores_a.get(c) is None or scores_b.get(c) is None:
                    self.send_response(HTTPStatus.BAD_REQUEST)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": "Все 4 шкалы качества должны быть заполнены вручную для Модели A и для Модели B."}, ensure_ascii=False).encode("utf-8"))
                    return
            if not preferred:
                self.send_response(HTTPStatus.BAD_REQUEST)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": "Выберите предпочтительный ответ (A, B или ничья)."}, ensure_ascii=False).encode("utf-8"))
                return
        else:
            for c in criteria:
                if scores.get(c) is None:
                    self.send_response(HTTPStatus.BAD_REQUEST)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "error", "message": "Все 4 шкалы качества должны быть заполнены вручную."}, ensure_ascii=False).encode("utf-8"))
                    return

        conn = get_db()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO custom_annotations (
                    username, mode, prompt, source_text, response_a, response_b,
                    scores_json, errors_json, preferred, reasoning, is_doubt, doubt_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                username, mode, prompt, source_text, response_a, response_b,
                json.dumps(scores, ensure_ascii=False),
                json.dumps(errors, ensure_ascii=False),
                preferred, reasoning, is_doubt, doubt_reason
            ))
            conn.commit()
            new_id = cursor.lastrowid
        finally:
            conn.close()

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "success", "id": new_id}, ensure_ascii=False).encode("utf-8"))

    def handle_get_custom_annotations(self):
        conn = get_db()
        try:
            rows = conn.execute("SELECT * FROM custom_annotations ORDER BY created_at DESC").fetchall()
        finally:
            conn.close()

        result = []
        for r in rows:
            item = dict(r)
            item["scores"] = json.loads(item["scores_json"])
            item["errors"] = json.loads(item["errors_json"])
            del item["scores_json"]
            del item["errors_json"]
            result.append(item)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))

    def handle_export_jsonl(self):
        """Экспорт в формат JSONL (DPO / SFT) для прямого дообучения моделей (RLHF/DPO)"""
        conn = get_db()
        try:
            rows = conn.execute("SELECT * FROM custom_annotations ORDER BY created_at ASC").fetchall()
        finally:
            conn.close()

        output_lines = []
        for r in rows:
            rec = dict(r)
            scores = json.loads(rec["scores_json"])
            errors = json.loads(rec["errors_json"])
            
            if rec["mode"] == "sbs" and rec["preferred"]:
                # DPO / RLHF формат парного сравнения (chosen vs rejected)
                is_a_chosen = ("model_a" in rec["preferred"])
                chosen = rec["response_a"] if is_a_chosen else rec["response_b"]
                rejected = rec["response_b"] if is_a_chosen else rec["response_a"]
                
                entry = {
                    "prompt": rec["prompt"],
                    "context": rec["source_text"],
                    "chosen": chosen,
                    "rejected": rejected,
                    "preference": rec["preferred"],
                    "annotator_feedback": rec["reasoning"],
                    "is_doubt": bool(rec.get("is_doubt", 0)),
                    "doubt_reason": rec.get("doubt_reason", ""),
                    "annotator": rec["username"],
                    "created_at": rec["created_at"]
                }
                # Обработка оценок: новый раздельный формат или старый сводный
                if isinstance(scores, dict) and "scores_a" in scores and "scores_b" in scores:
                    entry["scores_a"] = scores["scores_a"]
                    entry["scores_b"] = scores["scores_b"]
                    entry["scores_chosen"] = scores["scores_a"] if is_a_chosen else scores["scores_b"]
                    entry["scores_rejected"] = scores["scores_b"] if is_a_chosen else scores["scores_a"]
                else:
                    entry["quality_scores"] = scores
                    entry["scores_legacy"] = scores
                    entry["legacy_notice"] = "Оценки старого формата — модель не указана"
                if errors:
                    entry["detected_errors"] = errors
            else:
                # SFT формат с оценками качества
                entry = {
                    "messages": [
                        {"role": "user", "content": rec["prompt"]},
                        {"role": "assistant", "content": rec["response_a"]}
                    ],
                    "context": rec["source_text"],
                    "quality_scores": scores,
                    "detected_errors": errors,
                    "notes": rec["reasoning"],
                    "is_doubt": bool(rec.get("is_doubt", 0)),
                    "doubt_reason": rec.get("doubt_reason", ""),
                    "annotator": rec["username"],
                    "created_at": rec["created_at"]
                }
            output_lines.append(json.dumps(entry, ensure_ascii=False))

        jsonl_data = "\n".join(output_lines).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-jsonlines; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="annotated_dataset.jsonl"')
        self.end_headers()
        self.wfile.write(jsonl_data)

    def handle_export_legacy_fixture(self):
        """Экспорт отдельной тестовой фикстуры старого DPO-формата без добавления в БД"""
        fixture_entry = {
            "prompt": "Сравни два объяснения: что такое замыкание (closure) в JavaScript?",
            "context": "MDN Web Docs: Замыкание (closure) — это комбинация функции и лексического окружения, в котором эта функция была определена.",
            "chosen": "Замыкание (closure) — это функция, которая имеет доступ к переменным из своей внешней (лексической) области видимости, даже после того, как внешняя функция завершила своё выполнение.\n\n```javascript\nfunction createCounter() {\n  let count = 0;\n  return function() { return ++count; };\n}\nconst counter = createCounter();\nconsole.log(counter()); // 1\n```",
            "rejected": "Замыкание — это встроенная директива close(), используемая в NodeJS для закрытия сокетов и предотвращения утечек памяти в циклах событий.",
            "preference": "model_a_much",
            "quality_scores": {
                "instruction_following": 5,
                "factuality": 4,
                "completeness": 4,
                "coherence_literacy": 5
            },
            "scores_legacy": {
                "instruction_following": 5,
                "factuality": 4,
                "completeness": 4,
                "coherence_literacy": 5
            },
            "legacy_notice": "Оценки старого формата — модель не указана",
            "detected_errors": ["factual_error"],
            "annotator_feedback": "Запись старого формата (единый набор quality_scores): Модель A дала эталонное определение замыкания. Модель B перепутала замыкание с закрытием сокетов.",
            "is_doubt": False,
            "doubt_reason": "",
            "annotator": "legacy_assessor",
            "created_at": "2026-10-20 14:30:00"
        }
        jsonl_data = (json.dumps(fixture_entry, ensure_ascii=False) + "\n").encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-jsonlines; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="legacy_dpo_fixture.jsonl"')
        self.end_headers()
        self.wfile.write(jsonl_data)

    def handle_get_llm_config(self):
        env = load_env()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps({
            "base_url": env.get("LITELLM_BASE_URL", "http://localhost:4000/"),
            "model": env.get("LITELLM_MODEL", "qwen/qwen3-coder-next"),
            "has_key": bool(env.get("LITELLM_API_KEY"))
        }, ensure_ascii=False).encode("utf-8"))

    def handle_generate_llm(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        data = json.loads(body)

        env = load_env()
        base_url = data.get("base_url") or env.get("LITELLM_BASE_URL", "http://localhost:4000/")
        api_key = data.get("api_key") or env.get("LITELLM_API_KEY", "")
        model = data.get("model") or env.get("LITELLM_MODEL", "qwen/qwen3-coder-next")
        prompt = data.get("prompt", "").strip()
        system_prompt = data.get("system_prompt", "Ты полезный AI-ассистент. Отвечай качественно, полно и структурированно.")
        temperature = float(data.get("temperature", 0.7))

        if not base_url.endswith("/"):
            base_url += "/"

        # Поддержка стандартного /v1/chat/completions или /chat/completions
        if "v1" in base_url:
            endpoint = base_url + "chat/completions"
        else:
            endpoint = base_url + "v1/chat/completions"

        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt}
            ],
            "temperature": temperature
        }

        try:
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                choice = result.get("choices", [{}])[0]
                content = choice.get("message", {}).get("content", "")

                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "success",
                    "content": content,
                    "model": model,
                    "usage": result.get("usage", {})
                }, ensure_ascii=False).encode("utf-8"))
        except Exception as e:
            self.send_response(HTTPStatus.BAD_GATEWAY)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "error",
                "message": f"Ошибка обращения к LiteLLM шлюзу: {str(e)}",
                "endpoint": endpoint,
                "model": model
            }, ensure_ascii=False).encode("utf-8"))


def main():
    if not DB_PATH.exists():
        print("База данных train.db не найдена, выполняю автоматическую инициализацию...")
        import init_db
        init_db.init_db()
    else:
        try:
            with sqlite3.connect(DB_PATH) as _conn:
                _cur = _conn.cursor()
                _cur.execute("SELECT count(*) FROM cases")
        except Exception:
            print("Таблицы базы данных не найдены, выполняю инициализацию...")
            import init_db
            init_db.init_db()

    print("=" * 65)
    print("🚀 Тренажер асессора / специалиста по разметке ответов LLM")
    print(f"📡 Сервер запускается по адресу: http://localhost:{PORT}")
    print("💡 Откройте эту ссылку в браузере для тренировки джунов.")
    print("=" * 65)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), TrainerHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")


if __name__ == "__main__":
    main()
