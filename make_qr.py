#!/usr/bin/env python3
"""把登入 token 與題目 ID 產成 QR-Code PNG，輸出到 qr/。

登入 QR 編的是完整網址，所以用手機內建相機掃也能直接登入；
題目 QR 編的是純五碼代碼，由網站內建掃描器讀取。

匯入 main 會順帶跑一次題庫驗證 —— 題庫有錯就不會產出半套貼紙。
"""

import os
from pathlib import Path

import segno

from main import QUESTIONS, TOKENS

OUT_DIR = Path(__file__).parent / "qr"
SCALE = 20
BORDER = 2


def main():
    site = os.getenv("SITE_URL", "https://treasure.ntust.org").rstrip("/")
    OUT_DIR.mkdir(exist_ok=True)

    print(f"\n登入 QR（編碼完整網址，內建相機也掃得動）")
    for number, token in enumerate(TOKENS, 1):
        url = f"{site}/?token={token}"
        segno.make(url, error="m").save(OUT_DIR / f"login_{number}.png", scale=SCALE, border=BORDER)
        print(f"  qr/login_{number}.png   第 {number} 隊   {token}")

    print(f"\n題目 QR（編碼五碼代碼）")
    for qid, question in QUESTIONS.items():
        segno.make(qid, error="m").save(OUT_DIR / f"{qid}.png", scale=SCALE, border=BORDER)
        print(f"  qr/{qid}.png   {question['content'][:28]}")

    print(f"\n✓ {len(TOKENS)} 張登入 + {len(QUESTIONS)} 張題目 → {OUT_DIR.name}/\n")


if __name__ == "__main__":
    main()
