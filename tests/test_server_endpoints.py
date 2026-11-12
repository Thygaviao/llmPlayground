import io
import json
import sqlite3
import sys
import os
sys.path.insert(0, os.path.abspath("."))
from http import HTTPStatus
from urllib.parse import urlparse
import server

print("=================================================================")
print("СЕРВЕРНЫЕ ТЕСТЫ API И ЭКСПОРТОВ (SERVER.PY)")
print("=================================================================\n")

# Mock request handler for testing
class DummyWFile(io.BytesIO):
    pass

class DummyRFile(io.BytesIO):
    pass

def create_handler(path, method="GET", body=b""):
    handler = server.TrainerHandler.__new__(server.TrainerHandler)
    handler.path = path
    handler.command = method
    handler.headers = {"Content-Length": str(len(body))}
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler._response_headers = []
    handler._response_status = None

    def send_response(code, message=None):
        handler._response_status = code
    def send_header(keyword, value):
        handler._response_headers.append((keyword, value))
    def end_headers():
        pass
    def send_error(code, message=None):
        handler._response_status = code

    handler.send_response = send_response
    handler.send_header = send_header
    handler.end_headers = end_headers
    handler.send_error = send_error

    return handler

# 1. Test /api/cases
print("--- 1. Тест GET /api/cases ---")
h = create_handler("/api/cases")
h.handle_get_cases()
assert h._response_status == HTTPStatus.OK
cases_data = json.loads(h.wfile.getvalue().decode("utf-8"))
assert len(cases_data) == 12, f"Ожидалось 12 кейсов, получено {len(cases_data)}"
print(f"✓ Успешно: получено {len(cases_data)} LLM кейсов")

# 2. Test /api/cv-cases
print("\n--- 2. Тест GET /api/cv-cases ---")
h = create_handler("/api/cv-cases")
h.handle_get_cv_cases()
assert h._response_status == HTTPStatus.OK
cv_data = json.loads(h.wfile.getvalue().decode("utf-8"))
assert len(cv_data) == 3, f"Ожидалось 3 CV кейса, получено {len(cv_data)}"
print(f"✓ Успешно: получено {len(cv_data)} CV кейсов ({', '.join(c['id'] for c in cv_data)})")

# 3. Test /api/nlp-cases
print("\n--- 3. Тест GET /api/nlp-cases ---")
h = create_handler("/api/nlp-cases")
h.handle_get_nlp_cases()
assert h._response_status == HTTPStatus.OK
nlp_data = json.loads(h.wfile.getvalue().decode("utf-8"))
assert len(nlp_data) == 3, f"Ожидалось 3 NLP кейса, получено {len(nlp_data)}"
print(f"✓ Успешно: получено {len(nlp_data)} NLP кейсов ({', '.join(c['id'] for c in nlp_data)})")

# 4. Test /api/custom-annotations (only record 1 should be present!)
print("\n--- 4. Тест GET /api/custom-annotations (проверка после удаления #6 и #7) ---")
h = create_handler("/api/custom-annotations")
h.handle_get_custom_annotations()
assert h._response_status == HTTPStatus.OK
annotations = json.loads(h.wfile.getvalue().decode("utf-8"))
print(f"Текущие записи в БД: {[a['id'] for a in annotations]}")
assert not any(a['id'] in [6, 7] for a in annotations), "Записи #6 и #7 НЕ должны быть в БД!"
assert any(a['id'] == 1 for a in annotations), "Запись #1 должна оставаться в БД"
print("✓ Успешно: тестовые записи #6 и #7 отсутствуют в БД, запись #1 сохранена")

# 5. Test /api/export-csv
print("\n--- 5. Тест GET /api/export-csv ---")
h = create_handler("/api/export-csv")
h.handle_export_csv()
assert h._response_status == HTTPStatus.OK
csv_bytes = h.wfile.getvalue()
csv_text = csv_bytes.decode("utf-8-sig")
lines = csv_text.strip().split("\r\n") if "\r\n" in csv_text else csv_text.strip().split("\n")
print(f"Строк в CSV экспорте: {len(lines)}")
assert len(lines) >= 2, "CSV должен содержать заголовок и как минимум одну запись"
assert "Сотрудник" in lines[0] or "username" in lines[0]
print("✓ Успешно: CSV сформирован корректно")

# 6. Test /api/export-json
print("\n--- 6. Тест GET /api/export-json ---")
h = create_handler("/api/export-json")
h.handle_export_json()
assert h._response_status == HTTPStatus.OK
json_data = json.loads(h.wfile.getvalue().decode("utf-8"))
print(f"Записей в JSON экспорте: {len(json_data)}")
print("✓ Успешно: JSON экспорт валиден")

# 7. Test /api/export-jsonl
print("\n--- 7. Тест GET /api/export-jsonl ---")
h = create_handler("/api/export-jsonl")
h.handle_export_jsonl()
assert h._response_status == HTTPStatus.OK
jsonl_text = h.wfile.getvalue().decode("utf-8")
jsonl_lines = [line for line in jsonl_text.strip().split("\n") if line]
print(f"Строк в JSONL экспорте: {len(jsonl_lines)}")
for line in jsonl_lines:
    parsed = json.loads(line)
    if "chosen" in parsed:
        print(f"  DPO line: chosen={parsed['chosen'][:25]}... scores_a={parsed.get('scores_a')} legacy={parsed.get('legacy_notice')}")
    else:
        print(f"  SFT line: {parsed['messages'][0]['content'][:30]}...")
print("✓ Успешно: JSONL экспорт валиден")

# 8. Test /api/export-legacy-fixture
print("\n--- 8. Тест GET /api/export-legacy-fixture ---")
h = create_handler("/api/export-legacy-fixture")
h.handle_export_legacy_fixture()
assert h._response_status == HTTPStatus.OK
fixture_jsonl = json.loads(h.wfile.getvalue().decode("utf-8").strip())
assert fixture_jsonl["quality_scores"] == {
    "instruction_following": 5,
    "factuality": 4,
    "completeness": 4,
    "coherence_literacy": 5
}
assert fixture_jsonl["legacy_notice"] == "Оценки старого формата — модель не указана"
print("✓ Успешно: фикстура старого формата выгружается с quality_scores 5/4/4/5 и legacy_notice")

print("\n=================================================================")
print(">>> ВСЕ СЕРВЕРНЫЕ ТЕСТЫ API И ЭКСПОРТОВ УСПЕШНО ПРОЙДЕНЫ! <<<")
print("=================================================================")
