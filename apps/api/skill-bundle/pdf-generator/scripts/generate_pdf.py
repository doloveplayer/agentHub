#!/usr/bin/env python3
"""
General-purpose PDF generator with style presets and CJK font support.

Usage as CLI:
    python generate_pdf.py --input doc.md --output doc.pdf --style academic

Usage as library:
    from generate_pdf import PDFBuilder
    builder = PDFBuilder("out.pdf", style="business", language="zh")
    builder.add_markdown_file("input.md")
    builder.build()
"""

import re
import os
import sys
import argparse
from pathlib import Path
from typing import Optional

from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor, black, white, grey
from reportlab.lib.units import mm, cm
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable, KeepTogether, ListFlowable, ListItem
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ══════════════════════════════════════════════════════════════
#  Font auto-detection
# ══════════════════════════════════════════════════════════════

FONT_SEARCH_PATHS = [
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/arphic/ukai.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]

# Font files that use TrueType outlines (reportlab-compatible) by substring match
TRUETYPE_FONT_SUBSTRINGS = ["truetype", "DroidSans", "DejaVu", "arphic"]

_font_cache = {}  # {key: registered_name}


def _find_fonts():
    """Scan system for available TrueType fonts. Returns dict of font roles."""
    found = {"cjk": None, "cjk_bold": None, "mono": None, "serif": None}

    for path in FONT_SEARCH_PATHS:
        if not os.path.exists(path):
            continue
        basename = os.path.basename(path).lower()

        if "droid" in basename and found["cjk"] is None:
            found["cjk"] = path
        elif "uming" in basename and found["cjk_bold"] is None:
            found["cjk_bold"] = path
        elif "ukai" in basename:
            pass  # alternative CJK
        elif "dejavusansmono" in basename and found["mono"] is None:
            found["mono"] = path
        elif "dejavusans" in basename:
            pass

    # Try Noto CJK as last resort (may fail with PostScript outlines)
    if found["cjk"] is None:
        noto = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
        if os.path.exists(noto):
            found["cjk"] = noto  # will try, may fail

    return found


def _try_register(name, path, subfont_index=None):
    """Try to register a font, return True on success."""
    if path is None:
        return False
    try:
        kwargs = {"subfontIndex": subfont_index} if subfont_index is not None else {}
        pdfmetrics.registerFont(TTFont(name, path, **kwargs))
        return True
    except Exception:
        return False


def register_fonts(language="zh"):
    """Register fonts needed for the given language. Returns (body_font, bold_font, mono_font)."""
    fonts = _find_fonts()

    body_name = "Helvetica"
    bold_name = "Helvetica-Bold"
    mono_name = "Courier"

    if language in ("zh", "mixed"):
        # Try registering CJK fonts
        if _try_register("CJKBody", fonts["cjk"]):
            body_name = "CJKBody"
        if _try_register("CJKBold", fonts["cjk_bold"], subfont_index=0):
            bold_name = "CJKBold"
        elif _try_register("CJKBold", fonts["cjk"]):
            # Use same font for bold if no bold variant available
            bold_name = "CJKBody" if body_name == "CJKBody" else bold_name

    # Monospace font
    if fonts["mono"] and _try_register("MonoFont", fonts["mono"]):
        mono_name = "MonoFont"
    elif os.path.exists("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
        if _try_register("MonoFont", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
            mono_name = "MonoFont"

    return body_name, bold_name, mono_name


# ══════════════════════════════════════════════════════════════
#  Style Presets
# ══════════════════════════════════════════════════════════════

PAGE_SIZES = {"a4": A4, "letter": letter}

# Each preset defines colors and sizing; actual ParagraphStyle objects
# are built in PDFBuilder.__init__ after fonts are registered.

STYLE_PRESETS = {
    "academic": {
        "title_size": 22, "h1_size": 16, "h2_size": 13, "h3_size": 11,
        "body_size": 10, "code_size": 8, "table_size": 8,
        "title_color": "#1a365d", "h1_color": "#2c5282",
        "h2_color": "#2b6cb0", "accent": "#3182ce",
        "body_align": TA_JUSTIFY, "first_indent": 20,
        "table_header_bg": "#2c5282", "table_alt_bg": "#ebf4ff",
        "border_color": "#e2e8f0", "quote_bg": "#f0f5ff",
    },
    "business": {
        "title_size": 18, "h1_size": 14, "h2_size": 12, "h3_size": 10,
        "body_size": 10, "code_size": 8, "table_size": 8,
        "title_color": "#1a365d", "h1_color": "#2c5282",
        "h2_color": "#4a5568", "accent": "#3182ce",
        "body_align": TA_LEFT, "first_indent": 0,
        "table_header_bg": "#2c5282", "table_alt_bg": "#ebf4ff",
        "border_color": "#cbd5e0", "quote_bg": "#f7fafc",
    },
    "modern": {
        "title_size": 24, "h1_size": 18, "h2_size": 14, "h3_size": 11,
        "body_size": 11, "code_size": 9, "table_size": 9,
        "title_color": "#1a202c", "h1_color": "#2b6cb0",
        "h2_color": "#3182ce", "accent": "#4299e1",
        "body_align": TA_LEFT, "first_indent": 0,
        "table_header_bg": "#2b6cb0", "table_alt_bg": "#ebf8ff",
        "border_color": "#bee3f8", "quote_bg": "#ebf8ff",
    },
    "minimal": {
        "title_size": 16, "h1_size": 13, "h2_size": 11, "h3_size": 10,
        "body_size": 9.5, "code_size": 8, "table_size": 8,
        "title_color": "#000000", "h1_color": "#000000",
        "h2_color": "#333333", "accent": "#666666",
        "body_align": TA_LEFT, "first_indent": 0,
        "table_header_bg": "#333333", "table_alt_bg": "#f5f5f5",
        "border_color": "#cccccc", "quote_bg": "#f9f9f9",
    },
}


# ══════════════════════════════════════════════════════════════
#  Box-drawing character transliteration
#  Converts Unicode box-drawing chars (U+2500-U+257F) and
#  geometric shapes (U+25B2-U+25C5) to ASCII equivalents.
#  Required because reportlab-compatible TTF fonts that are
#  BOTH monospace AND CJK-capable do not exist on most systems.
#  Without this, ASCII art diagrams with CJK text lose all
#  alignment when rendered in code blocks.
# ══════════════════════════════════════════════════════════════

_BOX_DRAWING_MAP = str.maketrans({
    # Box drawing (U+2500-U+257F)
    ord('─'): '-',
    ord('│'): '|',
    ord('┌'): '+',
    ord('┐'): '+',
    ord('└'): '+',
    ord('┘'): '+',
    ord('├'): '+',
    ord('┤'): '+',
    ord('┬'): '+',
    ord('┴'): '+',
    ord('┼'): '+',
    ord('═'): '=',
    ord('║'): '|',
    ord('╔'): '+',
    ord('╗'): '+',
    ord('╚'): '+',
    ord('╝'): '+',
    ord('╠'): '+',
    ord('╣'): '+',
    ord('╦'): '+',
    ord('╩'): '+',
    ord('╬'): '+',
    # Block elements
    ord('▀'): '_',
    ord('▄'): '_',
    ord('█'): '#',
    ord('▌'): '|',
    ord('▐'): '|',
    # Geometric shapes (U+25B2-U+25C5)
    ord('▲'): '^',
    ord('▶'): '>',
    ord('▼'): 'v',
    ord('◀'): '<',
    ord('◄'): '<',
    ord('►'): '>',
    # Arrows
    ord('←'): '<-',
    ord('→'): '->',
    ord('↑'): '^',
    ord('↓'): 'v',
    ord('⇐'): '<=',
    ord('⇒'): '=>',
})

# CJK characters that look like box-drawing but aren't in the U+2500 block
_CJK_PSEUDO_BOX = str.maketrans({
    ord('￣'): '_',
})


def transliterate_box_drawing(text: str) -> str:
    """Convert Unicode box-drawing chars to ASCII for monospace rendering."""
    text = text.translate(_BOX_DRAWING_MAP)
    text = text.translate(_CJK_PSEUDO_BOX)
    return text


# ══════════════════════════════════════════════════════════════
#  PDFBuilder
# ══════════════════════════════════════════════════════════════

class PDFBuilder:
    """Build a styled PDF from markdown content."""

    def __init__(
        self,
        output_path: str,
        style: str = "academic",
        page_size: str = "a4",
        language: str = "mixed",
        title: str = "",
        author: str = "",
        margins: tuple = (20 * mm, 20 * mm, 18 * mm, 18 * mm),  # L, R, T, B
    ):
        if style not in STYLE_PRESETS:
            raise ValueError(f"Unknown style '{style}'. Choose from: {list(STYLE_PRESETS)}")

        self.output_path = output_path
        self.style_name = style
        self.preset = STYLE_PRESETS[style].copy()
        self.language = language
        self.doc_title = title
        self.doc_author = author
        self.margins = margins

        page_w, page_h = PAGE_SIZES.get(page_size, A4)
        self.page_size = (page_w, page_h)

        # Register fonts
        self.body_font, self.bold_font, self.mono_font = register_fonts(language)

        # Build paragraph styles
        self.styles = self._build_styles()

        # Flowable story
        self.story = []

        # Page number tracking
        self._page_num = 0

    def _build_styles(self):
        """Create all ParagraphStyle objects from the preset + fonts."""
        p = self.preset
        s = {}

        s["title"] = ParagraphStyle(
            "PDFTitle", fontName=self.bold_font,
            fontSize=p["title_size"], leading=p["title_size"] * 1.4,
            textColor=HexColor(p["title_color"]), alignment=TA_CENTER,
            spaceAfter=6 * mm,
        )
        s["h1"] = ParagraphStyle(
            "PDFH1", fontName=self.bold_font,
            fontSize=p["h1_size"], leading=p["h1_size"] * 1.5,
            textColor=HexColor(p["h1_color"]),
            spaceBefore=10 * mm, spaceAfter=4 * mm,
        )
        s["h2"] = ParagraphStyle(
            "PDFH2", fontName=self.bold_font,
            fontSize=p["h2_size"], leading=p["h2_size"] * 1.5,
            textColor=HexColor(p["h2_color"]),
            spaceBefore=8 * mm, spaceAfter=3 * mm,
        )
        s["h3"] = ParagraphStyle(
            "PDFH3", fontName=self.bold_font,
            fontSize=p["h3_size"], leading=p["h3_size"] * 1.5,
            textColor=HexColor(p["h2_color"]),
            spaceBefore=5 * mm, spaceAfter=2 * mm,
        )
        s["body"] = ParagraphStyle(
            "PDFBody", fontName=self.body_font,
            fontSize=p["body_size"], leading=p["body_size"] * 1.8,
            textColor=black, alignment=p["body_align"],
            spaceAfter=2 * mm, firstLineIndent=p["first_indent"],
        )
        s["code"] = ParagraphStyle(
            "PDFCode", fontName=self.mono_font,
            fontSize=p["code_size"], leading=p["code_size"] * 1.6,
            textColor=HexColor("#2d3748"),
            backColor=HexColor("#f7fafc"),
            leftIndent=10, rightIndent=10,
            spaceBefore=2 * mm, spaceAfter=2 * mm,
            borderPadding=6, borderWidth=0.5,
            borderColor=HexColor(p["border_color"]),
        )
        s["bullet"] = ParagraphStyle(
            "PDFBullet", parent=s["body"],
            leftIndent=12, bulletIndent=4,
            spaceBefore=1 * mm, spaceAfter=1 * mm,
            firstLineIndent=0,
        )
        s["quote"] = ParagraphStyle(
            "PDFQuote", fontName=self.body_font,
            fontSize=p["body_size"], leading=p["body_size"] * 1.7,
            textColor=HexColor("#2d3748"),
            leftIndent=15, rightIndent=15,
            spaceBefore=3 * mm, spaceAfter=3 * mm,
            borderWidth=3, borderColor=HexColor(p["accent"]),
            borderPadding=8, backColor=HexColor(p["quote_bg"]),
        )
        s["table_cell"] = ParagraphStyle(
            "PDFTableCell", fontName=self.body_font,
            fontSize=p["table_size"], leading=p["table_size"] * 1.6,
            textColor=black,
        )
        s["table_header"] = ParagraphStyle(
            "PDFTableHeader", fontName=self.bold_font,
            fontSize=p["table_size"], leading=p["table_size"] * 1.6,
            textColor=white,
        )
        s["caption"] = ParagraphStyle(
            "PDFCaption", fontName=self.body_font,
            fontSize=9, leading=14, textColor=grey, alignment=TA_CENTER,
            spaceBefore=2 * mm, spaceAfter=4 * mm,
        )
        return s

    # ── Page callbacks ──────────────────────────────────────

    def _on_page(self, canvas, doc):
        canvas.saveState()
        canvas.setFont(self.body_font, 8)
        canvas.setFillColor(grey)
        # Bottom left: document title or filename
        footer_text = self.doc_title or os.path.basename(self.output_path)
        canvas.drawString(self.margins[0], 12 * mm, footer_text[:60])
        # Bottom right: page number
        canvas.drawRightString(
            self.page_size[0] - self.margins[1], 12 * mm,
            f"Page {canvas.getPageNumber()}"
        )
        canvas.restoreState()

    # ── Content methods ─────────────────────────────────────

    def add_markdown_file(self, filepath: str):
        """Parse a markdown file and add all content to the story."""
        with open(filepath, "r", encoding="utf-8") as f:
            text = f.read()
        self._parse_markdown(text)

    def add_markdown_text(self, text: str):
        """Parse a markdown string and add all content to the story."""
        self._parse_markdown(text)

    def add_title(self, text: str):
        self.story.append(Paragraph(text, self.styles["title"]))
        self.story.append(Spacer(1, 2 * mm))

    def add_heading(self, text: str, level: int = 1):
        style_key = {1: "h1", 2: "h2", 3: "h3"}.get(level, "h1")
        self.story.append(Paragraph(text, self.styles[style_key]))

    def add_paragraph(self, text: str):
        self.story.append(Paragraph(text, self.styles["body"]))

    def add_bullet(self, text: str, indent_level: int = 0):
        s = ParagraphStyle(
            "BulletTmp", parent=self.styles["bullet"],
            leftIndent=12 + indent_level * 8,
            bulletIndent=4 + indent_level * 8,
        )
        self.story.append(Paragraph(f"• {text}", s))

    def add_code_block(self, code: str):
        code = transliterate_box_drawing(code)
        escaped = code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        self.story.append(Paragraph(f"<pre>{escaped}</pre>", self.styles["code"]))

    def add_table(self, headers: list[str], rows: list[list[str]], col_widths=None):
        """Add a styled table. col_widths auto-calculated if not provided."""
        header_cells = [Paragraph(h, self.styles["table_header"]) for h in headers]
        data = [header_cells]
        for row in rows:
            data.append([Paragraph(str(c), self.styles["table_cell"]) for c in row])

        if col_widths is None:
            avail = self.page_size[0] - self.margins[0] - self.margins[1]
            col_widths = [avail / len(headers)] * len(headers)

        t = Table(data, colWidths=col_widths, repeatRows=1)
        style_cmds = [
            ("BACKGROUND", (0, 0), (-1, 0), HexColor(self.preset["table_header_bg"])),
            ("TEXTCOLOR", (0, 0), (-1, 0), white),
            ("ALIGN", (0, 0), (-1, 0), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("GRID", (0, 0), (-1, -1), 0.5, HexColor(self.preset["border_color"])),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [white, HexColor(self.preset["table_alt_bg"])]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]
        t.setStyle(TableStyle(style_cmds))
        self.story.append(Spacer(1, 2 * mm))
        self.story.append(t)
        self.story.append(Spacer(1, 3 * mm))

    def add_horizontal_rule(self):
        hr = HRFlowable(
            width="100%", thickness=0.5,
            color=HexColor(self.preset["border_color"]),
            spaceBefore=3 * mm, spaceAfter=3 * mm,
        )
        self.story.append(hr)

    def add_page_break(self):
        self.story.append(PageBreak())

    def add_spacer(self, height_mm: float = 5):
        self.story.append(Spacer(1, height_mm * mm))

    def add_quote(self, text: str):
        self.story.append(Paragraph(text, self.styles["quote"]))

    # ── Markdown parser ─────────────────────────────────────

    def _parse_markdown(self, text: str):
        """Parse markdown text and add elements to the story."""
        lines = text.split("\n")
        i = 0
        in_code_block = False
        code_lines = []
        in_table = False
        table_header = []
        table_rows = []
        in_quote = False
        quote_lines = []

        def flush_code():
            nonlocal code_lines
            if code_lines:
                self.add_code_block("\n".join(code_lines))
                code_lines = []

        def flush_table():
            nonlocal table_rows, table_header, in_table
            if table_rows:
                self.add_table(table_header, table_rows)
                table_rows = []
                table_header = []
                in_table = False

        def flush_quote():
            nonlocal quote_lines, in_quote
            if quote_lines:
                self.add_quote("<br/>".join(quote_lines))
                quote_lines = []
                in_quote = False

        while i < len(lines):
            line = lines[i]

            # Code block
            if line.startswith("```"):
                if in_code_block:
                    flush_code()
                    in_code_block = False
                else:
                    flush_quote()
                    flush_table()
                    in_code_block = True
                i += 1
                continue

            if in_code_block:
                code_lines.append(line)
                i += 1
                continue

            # Table
            if line.startswith("|") and line.strip().endswith("|"):
                flush_code(); flush_quote()
                cells = [c.strip() for c in line.split("|")[1:-1]]
                if not in_table:
                    if i + 1 < len(lines) and re.match(r'^\|[\s\-:|]+\|$', lines[i + 1]):
                        table_header = cells
                        in_table = True
                        i += 2
                        continue
                else:
                    table_rows.append(cells)
                    if i + 1 >= len(lines) or not lines[i + 1].startswith("|"):
                        flush_table()
                    i += 1
                    continue
                # fall through to render as regular text if not a valid table
                self.story.append(Paragraph(line, self.styles["body"]))
                i += 1
                continue
            elif in_table:
                flush_table()

            # Quote continuation
            if line.startswith("> "):
                flush_code(); flush_table()
                quote_lines.append(line[2:])
                in_quote = True
                i += 1
                continue
            elif in_quote and line.strip():
                quote_lines.append(line)
                i += 1
                continue
            elif in_quote:
                flush_quote()

            # Headers
            if line.startswith("# ") and not line.startswith("## "):
                flush_code(); flush_table(); flush_quote()
                self.add_title(line[2:])
            elif line.startswith("## ") and not line.startswith("### "):
                flush_code(); flush_table(); flush_quote()
                self.add_heading(line[3:], level=1)
            elif line.startswith("### ") and not line.startswith("#### "):
                flush_code(); flush_table(); flush_quote()
                self.add_heading(line[4:], level=2)
            elif line.startswith("#### "):
                flush_code(); flush_table(); flush_quote()
                self.add_heading(line[5:], level=3)

            # HR
            elif line.strip() == "---":
                flush_code(); flush_table(); flush_quote()
                self.add_horizontal_rule()

            # Bullet lists
            elif line.startswith("- ") or line.startswith("  - ") or line.startswith("    - "):
                flush_code(); flush_table(); flush_quote()
                indent_level = (len(line) - len(line.lstrip())) // 2
                text_content = line.lstrip("- ").strip()
                text_content = self._inline_format(text_content)
                s = ParagraphStyle(
                    "BulletTmp", parent=self.styles["bullet"],
                    leftIndent=12 + indent_level * 8,
                    bulletIndent=4 + indent_level * 8,
                )
                self.story.append(Paragraph(f"• {text_content}", s))

            # Numbered lists
            elif re.match(r'^\d+\.\s', line):
                flush_code(); flush_table(); flush_quote()
                text_content = re.sub(r'^\d+\.\s', '', line)
                text_content = self._inline_format(text_content)
                self.story.append(Paragraph(f"• {text_content}", self.styles["bullet"]))

            # Empty line
            elif not line.strip():
                flush_code(); flush_table(); flush_quote()
                self.story.append(Spacer(1, 1 * mm))

            # Regular paragraph
            else:
                flush_code(); flush_table(); flush_quote()
                text_content = self._inline_format(line)
                self.story.append(Paragraph(text_content, self.styles["body"]))

            i += 1

        flush_code()
        flush_table()
        flush_quote()

    def _inline_format(self, text: str) -> str:
        """Apply inline markdown formatting: **bold**, `code`."""
        text = transliterate_box_drawing(text)
        text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
        text = re.sub(r'`([^`]+)`', r'<font face="{}" size="{}">{}</font>'.format(
            self.mono_font, self.preset["code_size"], r'\1'), text)
        text = text.replace('→', ' → ')
        return text

    # ── Build ───────────────────────────────────────────────

    def build(self):
        """Generate the PDF file."""
        doc = SimpleDocTemplate(
            self.output_path,
            pagesize=self.page_size,
            leftMargin=self.margins[0],
            rightMargin=self.margins[1],
            topMargin=self.margins[2],
            bottomMargin=self.margins[3],
            title=self.doc_title or os.path.basename(self.output_path),
            author=self.doc_author,
        )
        doc.build(self.story, onFirstPage=self._on_page, onLaterPages=self._on_page)

        size_kb = os.path.getsize(self.output_path) / 1024
        print(f"PDF generated: {self.output_path} ({size_kb:.1f} KB) [{self.style_name} style, {self.language}]")


# ══════════════════════════════════════════════════════════════
#  CLI
# ══════════════════════════════════════════════════════════════

def detect_language(filepath: str) -> str:
    """Heuristic: scan first 500 chars for CJK characters."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            sample = f.read(500)
        cjk_count = sum(1 for c in sample if '一' <= c <= '鿿' or '㐀' <= c <= '䶿')
        if cjk_count > len(sample) * 0.15:
            return "zh"
        elif cjk_count > 0:
            return "mixed"
        return "en"
    except Exception:
        return "mixed"


def main():
    parser = argparse.ArgumentParser(
        description="Generate styled PDF from markdown",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s -i report.md -o report.pdf
  %(prog)s -i doc.md -o doc.pdf --style business --page-size letter
  %(prog)s -i thesis.md -o thesis.pdf --style academic --language zh
        """,
    )
    parser.add_argument("-i", "--input", required=True, help="Input markdown file")
    parser.add_argument("-o", "--output", default=None,
                        help="Output PDF path (default: <input>.pdf)")
    parser.add_argument("--style", choices=list(STYLE_PRESETS), default="academic",
                        help="Style preset (default: academic)")
    parser.add_argument("--page-size", choices=["a4", "letter"], default="a4",
                        help="Page size (default: a4)")
    parser.add_argument("--language", choices=["zh", "en", "mixed"], default=None,
                        help="Language (auto-detected if not specified)")
    parser.add_argument("--title", default="", help="Document title for PDF metadata")

    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: input file not found: {args.input}")
        sys.exit(1)

    output = args.output or os.path.splitext(args.input)[0] + ".pdf"
    language = args.language or detect_language(args.input)

    builder = PDFBuilder(
        output_path=output,
        style=args.style,
        page_size=args.page_size,
        language=language,
        title=args.title or os.path.basename(args.input),
    )
    builder.add_markdown_file(args.input)
    builder.build()


if __name__ == "__main__":
    main()
