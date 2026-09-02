#!/usr/bin/env python3
"""把登入 token 與題目 ID 產成 QR-Code，輸出到 qr/。

登入 QR 分兩疊：leader_N 給隊輔（掃題目、看票數、送出），member_N 給隊員
（只投票）。兩者編的都是完整網址，用手機內建相機掃也能直接登入。
題目 QR 編的是純五碼代碼，只有隊輔掃得動。

一律用 segno.make_qr()。segno.make() 遇到五碼這種短資料會挑 Micro QR
(M2-M，只有一個定位點)，而 jsQR 根本不支援 Micro QR，貼出去會掃不動。

匯入 main 會順帶跑一次題庫驗證 —— 題庫有錯就不會產出半套貼紙。
"""

import argparse
import os
from pathlib import Path

import segno
from fpdf import FPDF

from main import LEADER_TOKENS, MEMBER_TOKENS, QUESTIONS

OUT_DIR = Path(__file__).parent / "qr"
PDF_PATH = OUT_DIR / "qrcodes.pdf"

PNG_SCALE = 20
QUIET_ZONE = 4  # 標準 QR 的靜區寬度（模組數）

# A4 直式，每頁 2 欄 x 4 列，單位 mm
PAGE_W, PAGE_H = 210.0, 297.0
MARGIN = 12.0
COLS, ROWS = 2, 4
CELL_W = (PAGE_W - 2 * MARGIN) / COLS
CELL_H = (PAGE_H - 2 * MARGIN) / ROWS
QR_MM = 46.0
LABEL_H = 8.0
LABEL_PT = 15


def build_items():
    """回傳 (標籤, QR 內容, 檔名, 備註) 的清單。

    標籤是印在紙上的字，刻意只用 ASCII，這樣 PDF 不必嵌中文字型。
    備註只出現在終端機，用來對照哪張貼紙是哪一題。
    """
    site = os.getenv("SITE_URL", "https://treasure.ntust.org").rstrip("/")
    # 備註只印 token 前 4 碼：夠對照哪張是哪隊，又不會把整把 token 留在
    # 終端機捲動紀錄或 `make_qr.py > build.log` 裡。完整值在 .env
    items = []
    for label, prefix, tokens in (
        ("LEADER", "leader", LEADER_TOKENS),
        ("TEAM", "member", MEMBER_TOKENS),
    ):
        items += [
            (f"{label} {number}", f"{site}/?token={token}", f"{prefix}_{number}", f"{token[:4]}…")
            for number, token in enumerate(tokens, 1)
        ]
    items += [(qid, qid, qid, q["content"][:30]) for qid, q in QUESTIONS.items()]
    return items


def write_pngs(items):
    OUT_DIR.mkdir(exist_ok=True)

    # 從 questions.yaml 刪掉的題目會留下孤兒 PNG，不清掉就有機會被印出來貼上牆
    keep = {f"{name}.png" for _, _, name, _ in items}
    for stale in sorted(OUT_DIR.glob("*.png")):
        if stale.name not in keep:
            stale.unlink()
            print(f"  刪除舊檔 qr/{stale.name}")

    for label, payload, name, note in items:
        segno.make_qr(payload, error="m").save(
            OUT_DIR / f"{name}.png", scale=PNG_SCALE, border=QUIET_ZONE
        )
        print(f"  qr/{name}.png   {label:<8} {note}")
    print(f"\n完成：{len(items)} 張 PNG → {OUT_DIR.name}/\n")


def draw_qr(pdf, code, x, y, size):
    """把 QR 畫成向量矩形，列印時不會有點陣邊緣。同列連續的暗模組合併成一條。"""
    matrix = [list(row) for row in code.matrix_iter(scale=1, border=QUIET_ZONE)]
    module = size / len(matrix)
    pdf.set_fill_color(0, 0, 0)
    for row_index, row in enumerate(matrix):
        col = 0
        while col < len(row):
            if not row[col]:
                col += 1
                continue
            start = col
            while col < len(row) and row[col]:
                col += 1
            pdf.rect(
                x + start * module,
                y + row_index * module,
                (col - start) * module,
                module,
                style="F",
            )


def write_pdf(items):
    OUT_DIR.mkdir(exist_ok=True)
    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(False)
    pdf.set_font("Helvetica", "B", LABEL_PT)

    per_page = COLS * ROWS
    for index, (label, payload, _, note) in enumerate(items):
        slot = index % per_page
        if slot == 0:
            pdf.add_page()
        cell_x = MARGIN + (slot % COLS) * CELL_W
        cell_y = MARGIN + (slot // COLS) * CELL_H

        # 裁切輔助線，剪貼紙時對得準
        pdf.set_draw_color(190, 190, 190)
        pdf.set_line_width(0.1)
        pdf.set_dash_pattern(dash=1, gap=1.5)
        pdf.rect(cell_x + 1, cell_y + 1, CELL_W - 2, CELL_H - 2)
        pdf.set_dash_pattern()

        top = cell_y + (CELL_H - QR_MM - LABEL_H) / 2
        draw_qr(pdf, segno.make_qr(payload, error="m"), cell_x + (CELL_W - QR_MM) / 2, top, QR_MM)

        pdf.set_xy(cell_x, top + QR_MM + 1)
        pdf.cell(CELL_W, LABEL_H, label, align="C")
        print(f"  第 {pdf.page_no()} 頁   {label:<8} {note}")

    pdf.output(str(PDF_PATH))
    pages = -(-len(items) // per_page)
    print(f"\n完成：{len(items)} 個 QR / {pages} 頁 → {PDF_PATH.relative_to(PDF_PATH.parent.parent)}\n")


def main():
    parser = argparse.ArgumentParser(description="產生登入與題目 QR-Code")
    parser.add_argument(
        "--pdf",
        action="store_true",
        help="輸出 A4 多頁 PDF（每頁 2x4 共 8 個，含裁切線），不產 PNG",
    )
    args = parser.parse_args()

    items = build_items()
    print(
        f"\n{len(LEADER_TOKENS)} 張隊輔 + {len(MEMBER_TOKENS)} 張隊員登入 QR（完整網址）"
        f" + {len(QUESTIONS)} 張題目 QR（五碼）"
    )
    print("隊輔那疊千萬別跟隊員的混在一起 —— 拿到隊輔 QR 的人可以代替全隊送出答案\n")
    if args.pdf:
        write_pdf(items)
    else:
        write_pngs(items)


if __name__ == "__main__":
    main()
