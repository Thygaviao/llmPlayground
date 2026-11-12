#!/usr/bin/env python3
"""
Скрипт инициализации базы данных SQLite для тренажера разметки LLM.
Создает таблицы cases, users, evaluations и загружает золотой обучающий датасет.
"""

import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "train.db"
DATA_PATH = Path(__file__).parent / "data" / "cases.json"


def init_db():
    print(f"Инициализация базы данных: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=15000;")
        conn.execute("PRAGMA synchronous=NORMAL;")
    except Exception:
        pass
    cursor = conn.cursor()

    # Таблица обучающих кейсов
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        prompt TEXT NOT NULL,
        source_text TEXT,
        model_response TEXT,
        model_response_b TEXT,
        gold_standard_json TEXT NOT NULL
    );
    """)

    # Таблица пользователей/стажеров
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'junior_evaluator',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Таблица результатов разметки обучающих кейсов
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        case_id TEXT NOT NULL,
        scores_json TEXT NOT NULL,
        errors_json TEXT NOT NULL,
        preferred TEXT,
        reasoning TEXT,
        agreement_score REAL NOT NULL,
        is_doubt INTEGER DEFAULT 0,
        doubt_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (case_id) REFERENCES cases(id)
    );
    """)

    # Таблица свободной разметки (Playground)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS custom_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        mode TEXT NOT NULL,
        prompt TEXT NOT NULL,
        source_text TEXT,
        response_a TEXT NOT NULL,
        response_b TEXT,
        scores_json TEXT NOT NULL,
        errors_json TEXT NOT NULL,
        preferred TEXT,
        reasoning TEXT,
        is_doubt INTEGER DEFAULT 0,
        doubt_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Загрузка обучающих кейсов из JSON
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        cases_data = json.load(f)

    for item in cases_data:
        gold_json = json.dumps(item["gold_standard"], ensure_ascii=False)
        model_b = item.get("model_response_b")
        model_a = item.get("model_response") or item.get("model_response_a")

        cursor.execute("""
        INSERT OR REPLACE INTO cases (
            id, type, title, category, difficulty, prompt, source_text, model_response, model_response_b, gold_standard_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            item["id"],
            item["type"],
            item["title"],
            item["category"],
            item["difficulty"],
            item["prompt"],
            item.get("source_text"),
            model_a,
            model_b,
            gold_json
        ))

    conn.commit()
    count = cursor.execute("SELECT count(*) FROM cases").fetchone()[0]
    conn.close()
    print(f"База данных успешно инициализирована. Загружено кейсов: {count}")


if __name__ == "__main__":
    init_db()
