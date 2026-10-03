from __future__ import annotations

import html
import re
from pathlib import Path

from reportlab.graphics.shapes import Circle, Drawing, Line, Path as GPath, Rect, String
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.utils import ImageReader
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    Image,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "TECHNICAL_LITEPAPER.md"
OUTPUT = ROOT / "apps" / "web" / "public" / "technical_litepaper.pdf"
LOGO = ROOT / "apps" / "web" / "public" / "brand" / "flurbo-logo-litepaper.png"

IVORY = HexColor("#fbfaf5")
PAPER = HexColor("#fffef9")
FOREST = HexColor("#14271d")
MOSS = HexColor("#496055")
LINE = HexColor("#cfd5cd")
PALE = HexColor("#eef1e6")
LIME = HexColor("#d9f76d")


class NumberedDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=22 * mm,
            rightMargin=22 * mm,
            topMargin=23 * mm,
            bottomMargin=20 * mm,
            title="Flurbo: A Coherent Market for Related Events",
            author="Flurbo Research and Engineering",
            subject="Technical Litepaper, Version 0.3",
        )
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="body",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=draw_page))


def draw_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, A4[0], A4[1], fill=1, stroke=0)
    if doc.page > 1:
        canvas.drawImage(ImageReader(LOGO), 22 * mm, A4[1] - 15.7 * mm, width=27 * mm, height=6.75 * mm, mask="auto", preserveAspectRatio=True)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(MOSS)
        canvas.drawRightString(A4[0] - 22 * mm, A4[1] - 13.8 * mm, "TECHNICAL LITEPAPER  |  VERSION 0.3")
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(22 * mm, A4[1] - 17 * mm, A4[0] - 22 * mm, A4[1] - 17 * mm)
        canvas.line(22 * mm, 14 * mm, A4[0] - 22 * mm, 14 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(MOSS)
        canvas.drawString(22 * mm, 9.5 * mm, "Monad public testnet  |  Test assets only")
        canvas.drawRightString(A4[0] - 22 * mm, 9.5 * mm, str(doc.page - 1))
    canvas.restoreState()


def styles():
    base = getSampleStyleSheet()
    return {
        "h1": ParagraphStyle("h1", parent=base["Heading1"], fontName="Helvetica-Bold", fontSize=24, leading=28, textColor=FOREST, spaceBefore=8, spaceAfter=11, keepWithNext=True),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=16, leading=20, textColor=FOREST, spaceBefore=14, spaceAfter=7, keepWithNext=True),
        "h3": ParagraphStyle("h3", parent=base["Heading3"], fontName="Helvetica-Bold", fontSize=11.5, leading=14, textColor=FOREST, spaceBefore=10, spaceAfter=5, keepWithNext=True),
        "body": ParagraphStyle("body", parent=base["BodyText"], fontName="Helvetica", fontSize=9.1, leading=13.1, textColor=FOREST, alignment=TA_LEFT, spaceAfter=6),
        "table": ParagraphStyle("table", parent=base["BodyText"], fontName="Helvetica", fontSize=7.5, leading=9.4, textColor=FOREST, alignment=TA_LEFT, spaceAfter=0),
        "bullet": ParagraphStyle("bullet", parent=base["BodyText"], fontName="Helvetica", fontSize=9, leading=12.6, textColor=FOREST, leftIndent=13, firstLineIndent=-8, bulletIndent=3, spaceAfter=3),
        "equation": ParagraphStyle("equation", parent=base["BodyText"], fontName="Courier", fontSize=8.4, leading=11.5, textColor=FOREST, alignment=TA_CENTER, leftIndent=8, rightIndent=8, spaceBefore=3, spaceAfter=8, backColor=PALE, borderPadding=(7, 8, 7, 8)),
        "code": ParagraphStyle("code", parent=base["BodyText"], fontName="Courier", fontSize=7.6, leading=10.2, textColor=FOREST, leftIndent=8, rightIndent=8, spaceBefore=3, spaceAfter=8, backColor=PALE, borderPadding=(7, 8, 7, 8)),
        "caption": ParagraphStyle("caption", parent=base["BodyText"], fontName="Helvetica-Oblique", fontSize=7.8, leading=10.5, textColor=MOSS, alignment=TA_CENTER, spaceBefore=4, spaceAfter=8),
        "reference": ParagraphStyle("reference", parent=base["BodyText"], fontName="Helvetica", fontSize=8, leading=11, textColor=FOREST, leftIndent=12, firstLineIndent=-12, spaceAfter=5),
    }


def rich(text: str) -> str:
    text = html.escape(text, quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"\*(.+?)\*", r"<i>\1</i>", text)
    text = re.sub(r"`(.+?)`", r"<font name='Courier'>\1</font>", text)
    return text


class SystemFigure(Flowable):
    def __init__(self, width):
        super().__init__(); self.width = width; self.height = 92

    def draw(self):
        c = self.canv
        labels = [("EVENTS", "Reviewed binary questions"), ("JOINT STATE", "One coherent distribution"), ("CLAIMS", "Boolean truth tables"), ("SETTLEMENT", "One terminal assignment")]
        w = (self.width - 42) / 4
        for i, (title, subtitle) in enumerate(labels):
            x = i * (w + 14)
            c.setFillColor(PALE); c.setStrokeColor(LINE); c.roundRect(x, 16, w, 58, 5, fill=1, stroke=1)
            c.setFillColor(FOREST); c.setFont("Helvetica-Bold", 7.2); c.drawCentredString(x + w / 2, 51, title)
            c.setFillColor(MOSS); c.setFont("Helvetica", 6.5)
            words = subtitle.split(); first = " ".join(words[:2]); second = " ".join(words[2:])
            c.drawCentredString(x + w / 2, 37, first); c.drawCentredString(x + w / 2, 28, second)
            if i < 3:
                c.setStrokeColor(FOREST); c.line(x + w + 3, 45, x + w + 11, 45)
                c.line(x + w + 8, 48, x + w + 11, 45); c.line(x + w + 8, 42, x + w + 11, 45)
        c.setFillColor(LIME); c.circle(self.width / 2, 83, 3, fill=1, stroke=0)


class ClaimsFigure(Flowable):
    def __init__(self, width):
        super().__init__(); self.width = width; self.height = 120

    def draw(self):
        c = self.canv; left = 42; top = 100; cell = 25
        states = [("00", "Neither"), ("10", "A only"), ("01", "B only"), ("11", "Both")]
        claims = [("AND", [0,0,0,1]), ("OR", [0,1,1,1]), ("EXACTLY ONE", [0,1,1,0])]
        c.setFont("Helvetica-Bold", 7); c.setFillColor(MOSS)
        for j, (state, _) in enumerate(states): c.drawCentredString(left + 116 + j * cell, top, state)
        for i, (name, payouts) in enumerate(claims):
            y = top - 27 - i * 27
            c.setFont("Helvetica-Bold", 7.5); c.setFillColor(FOREST); c.drawRightString(left + 88, y + 7, name)
            for j, payout in enumerate(payouts):
                x = left + 104 + j * cell
                c.setFillColor(LIME if payout else PALE); c.setStrokeColor(LINE); c.rect(x, y, 19, 19, fill=1, stroke=1)
                c.setFillColor(FOREST); c.setFont("Helvetica-Bold", 7); c.drawCentredString(x + 9.5, y + 6, str(payout))
        c.setFillColor(MOSS); c.setFont("Helvetica", 7.2)
        c.drawString(left + 224, top - 21, "Each row is one payoff vector.")
        c.drawString(left + 224, top - 34, "Prices are projections of one")
        c.drawString(left + 224, top - 47, "shared state distribution.")


class FactoredFigure(Flowable):
    def __init__(self, width):
        super().__init__(); self.width = width; self.height = 120

    def draw(self):
        c = self.canv; cx = self.width / 2; y = 62
        xs = [cx - 150, cx - 50, cx + 50, cx + 150]
        for i in range(3):
            c.setStrokeColor(MOSS); c.setLineWidth(2); c.line(xs[i] + 14, y, xs[i+1] - 14, y)
            c.setFillColor(PALE); c.setStrokeColor(LINE); c.roundRect((xs[i]+xs[i+1])/2 - 24, y+10, 48, 22, 5, fill=1, stroke=1)
            c.setFillColor(MOSS); c.setFont("Helvetica", 6.5); c.drawCentredString((xs[i]+xs[i+1])/2, y+18, f"factor {i+1}")
        for i, x in enumerate(xs):
            c.setFillColor(FOREST); c.circle(x, y, 13, fill=1, stroke=0)
            c.setFillColor(IVORY); c.setFont("Helvetica-Bold", 8); c.drawCentredString(x, y-3, chr(65+i))
        c.setFillColor(MOSS); c.setFont("Helvetica", 7.2)
        c.drawCentredString(cx, 20, "Sparse local factors, one global partition function, bounded intermediate tables")


def parse_table(lines, style):
    rows = []
    header_style = ParagraphStyle("tableheader", parent=style["table"], textColor=IVORY, fontName="Helvetica-Bold")
    for line in lines:
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if all(set(c) <= {"-", ":"} for c in cells):
            continue
        rows.append([Paragraph(rich(c), header_style if not rows else style["table"]) for c in cells])
    widths = [None] * len(rows[0])
    table = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), FOREST),
        ("TEXTCOLOR", (0,0), (-1,0), IVORY),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("GRID", (0,0), (-1,-1), 0.35, LINE),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [PAPER, PALE]),
        ("LEFTPADDING", (0,0), (-1,-1), 5),
        ("RIGHTPADDING", (0,0), (-1,-1), 5),
        ("TOPPADDING", (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]))
    return table


def cover(story, style):
    story.append(Spacer(1, 34 * mm))
    story.append(Image(str(LOGO), width=108 * mm, height=27 * mm, mask="auto"))
    story.append(Spacer(1, 12 * mm))
    story.append(Paragraph("A Coherent Market<br/>for Related Events", ParagraphStyle("covertitle", fontName="Helvetica-Bold", fontSize=35, leading=38, textColor=FOREST, spaceAfter=12)))
    story.append(Paragraph("Technical Litepaper  |  Version 0.3", ParagraphStyle("coversub", fontName="Helvetica", fontSize=12, leading=15, textColor=MOSS, spaceAfter=5)))
    story.append(Paragraph("1 October 2026", ParagraphStyle("coverdate", fontName="Helvetica", fontSize=9, leading=12, textColor=MOSS, spaceAfter=36)))
    story.append(Table([[Paragraph("MONAD PUBLIC TESTNET", style["body"]), Paragraph("TEST ASSETS ONLY", style["body"]) ]], colWidths=[72*mm,72*mm], style=TableStyle([
        ("LINEABOVE",(0,0),(-1,0),0.6,LINE),("LINEBELOW",(0,0),(-1,0),0.6,LINE),
        ("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7),
        ("ALIGN",(1,0),(1,0),"RIGHT"),
    ])))
    story.append(PageBreak())


def build_story(text: str):
    st = styles(); story = []; cover(story, st)
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == "## Abstract")
    i = start
    paragraph = []

    def flush():
        nonlocal paragraph
        if paragraph:
            value = " ".join(x.strip() for x in paragraph)
            current = st["reference"] if value.startswith("[") and re.match(r"^\[\d+\]", value) else st["body"]
            story.append(Paragraph(rich(value), current)); paragraph = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            flush(); i += 1; continue
        if stripped == "<!-- PAGEBREAK -->":
            flush(); story.append(PageBreak()); i += 1; continue
        if stripped.startswith("[[FIGURE:"):
            flush(); key = stripped[9:-2]
            figure = {"system": SystemFigure, "claims": ClaimsFigure, "factored": FactoredFigure}[key](156 * mm)
            captions = {
                "system": "Figure 1. Flurbo maps reviewed events into one joint state space, prices Boolean claims from one inventory, and settles them with one terminal assignment.",
                "claims": "Figure 2. Boolean claims are payoff vectors over the same local states.",
                "factored": "Figure 3. A bounded-width factor graph represents local interactions while preserving one global cost function.",
            }
            story.append(KeepTogether([figure, Paragraph(captions[key], st["caption"])])); i += 1; continue
        if stripped.startswith("```"):
            flush(); kind = stripped[3:].strip(); block = []; i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i]); i += 1
            story.append(KeepTogether([Paragraph("<br/>".join(html.escape(x) for x in block), st["equation"] if kind == "equation" else st["code"])])); i += 1; continue
        if stripped.startswith("|"):
            flush(); block = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                block.append(lines[i]); i += 1
            story.append(parse_table(block, st)); story.append(Spacer(1, 7)); continue
        if stripped.startswith("## "):
            flush(); story.append(Paragraph(rich(stripped[3:]), st["h1"])); i += 1; continue
        if stripped.startswith("### "):
            flush(); story.append(Paragraph(rich(stripped[4:]), st["h2"])); i += 1; continue
        if stripped.startswith("#### "):
            flush(); story.append(Paragraph(rich(stripped[5:]), st["h3"])); i += 1; continue
        if re.match(r"^[-*] ", stripped):
            flush(); story.append(Paragraph(rich(stripped[2:]), st["bullet"], bulletText="-")); i += 1; continue
        if re.match(r"^\d+\. ", stripped):
            flush(); number, content = stripped.split(". ", 1)
            story.append(Paragraph(rich(content), st["bullet"], bulletText=number + ".")); i += 1; continue
        paragraph.append(stripped); i += 1
    flush(); return story


def main():
    text = SOURCE.read_text(encoding="utf-8")
    if "\u2014" in text or "\u2013" in text:
        raise ValueError("The litepaper source must use ASCII hyphens only.")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = NumberedDocTemplate(str(OUTPUT))
    doc.build(build_story(text))
    print(OUTPUT)


if __name__ == "__main__":
    main()
