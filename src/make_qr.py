#!/usr/bin/env python3
"""Turns login tokens and question ids into QR codes under qr/.

Login QR codes come in two stacks: leader_N for leaders (scan questions, see the
tally, submit) and member_N for members (vote only). Both encode a full URL, so
the phone's built-in camera app logs you straight in. Question QR codes encode
the bare five-letter code and only leaders can scan them.

Always segno.make_qr(). Given payloads as short as five characters segno.make()
picks a Micro QR (M2-M, a single finder pattern), and jsQR has no Micro QR
support at all, so the printed code would be unscannable.

Importing main also runs question validation, so a broken bank never yields half
a set of stickers.
"""

import argparse
import os
from pathlib import Path

import segno
from fpdf import FPDF

from main import LEADER_TOKENS, MEMBER_TOKENS, QUESTIONS

OUT_DIR = Path(__file__).parent.parent / "qr"
PDF_PATH = OUT_DIR / "qrcodes.pdf"

PNG_SCALE = 20
QUIET_ZONE = 4  # Standard QR quiet zone width, in modules

# A4 portrait, 2 columns x 4 rows per page, in mm
PAGE_W, PAGE_H = 210.0, 297.0
MARGIN = 12.0
COLS, ROWS = 2, 4
CELL_W = (PAGE_W - 2 * MARGIN) / COLS
CELL_H = (PAGE_H - 2 * MARGIN) / ROWS
QR_MM = 46.0
LABEL_H = 8.0
LABEL_PT = 15


def build_items():
    """Returns a list of (label, QR payload, filename, note).

    The label is what gets printed, deliberately ASCII-only so the PDF needs no
    embedded CJK font. The note only shows up in the terminal, to match a sticker
    to its question.
    """
    site = os.getenv("SITE_URL", "https://treasure.ntust.org").rstrip("/")
    # The note prints only the first 4 characters of a token: enough to tell the
    # stacks apart, without leaving whole tokens in terminal scrollback or in a
    # `make_qr.py > build.log`. The full values stay in .env
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

    # A question deleted from questions.yaml leaves an orphan PNG behind, and an
    # uncleaned one can still get printed and taped to a wall
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
    """Draws the QR as vector rectangles, so printing has no bitmap edges. Runs of
    dark modules in a row are merged into one rectangle.
    """
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

        # Cut guides, so the stickers line up when trimmed
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
