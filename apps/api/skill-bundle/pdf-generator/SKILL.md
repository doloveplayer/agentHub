---
name: pdf-generator
description: >
  General-purpose PDF document generation using reportlab. Use this skill whenever
  the user asks to create, generate, or convert content into a PDF file. Also use
  when the user mentions "生成PDF", "创建PDF", "导出PDF", "制作文档", converting
  markdown/notes/reports to PDF, or wants a printable document. Trigger even if the
  user only implies they want a PDF output format — ask first, then build.
compatibility: python>=3.8, reportlab
allowed-tools: Bash, Read, Write, Edit
---

# PDF Generator Skill

## Workflow (MUST follow this order)

### Phase 1 — Gather requirements

Before writing any code, ask the user these questions (use AskUserQuestion when
multiple clear options exist, otherwise ask inline):

1. **Content source** — Is there an existing markdown/text file to convert, or
   should we compose the content from scratch based on the user's description?
2. **Style preset** — academic (formal, serif/mixed fonts, numbered sections) /
   business (clean, professional, blue accents) / modern (sans-serif, large
   headings, color blocks) / minimal (black & white, few decorations).
3. **Language** — Chinese (需要中文字体) / English / mixed.
4. **Page size** — A4 (default) / Letter.
5. **Special elements** — Tables, code blocks, diagrams, images, headers/footers?

If the user's request already implies answers (e.g., "create an academic paper
PDF" → academic style, A4), skip the obvious questions and only ask what's unclear.

### Phase 2 — Prepare content

- If the user provides a markdown file: read it and assess structure.
- If the user describes content: write the markdown first (use Write tool), then
  review with user for accuracy before converting to PDF.
- For complex documents (multi-section reports, papers): create the markdown in
  the working directory so the user can review and edit it later.

### Phase 3 — Generate PDF

Use the bundled `scripts/generate_pdf.py`. It can be used in two ways:

**As a CLI tool:**
```bash
python /home/c2216-3090/.claude/skills/pdf-generator/scripts/generate_pdf.py \
  --input <markdown-file> --output <output.pdf> \
  --style academic --page-size a4 --language zh
```

**As a Python library (preferred for customization):**
Write a small wrapper script that imports `PDFBuilder` from the bundled module,
customizes styles as needed, and calls `.build()`. See the reference section
below for the API.

### Phase 4 — Verify

After generation, read the first 2-3 pages of the PDF to verify:
- Chinese characters render correctly (no black boxes / tofu)
- Headers and body text are properly sized and spaced
- Tables and code blocks are formatted correctly
- Page breaks are reasonable

If anything looks wrong, adjust the ParagraphStyle parameters and regenerate.

## Style Preset Reference

| Preset | Title Font | Body Font | Colors | Best For |
|--------|-----------|-----------|--------|----------|
| `academic` | Bold serif, 22pt | Regular, 10pt, justified | Dark blue titles | Papers, theses, research reports |
| `business` | Bold sans, 18pt | Regular, 10pt | Blue accent, grey borders | Proposals, reports, documentation |
| `modern` | Bold sans, 24pt | Regular, 11pt | Vibrant blue, light bg blocks | Presentations, portfolios, brochures |
| `minimal` | Bold, 16pt | Regular, 9.5pt | Black only, thin rules | Memos, simple notes, drafts |

## PDFBuilder API (bundled script)

```python
from generate_pdf import PDFBuilder

builder = PDFBuilder(
    output_path="output.pdf",
    style="academic",       # or business/modern/minimal
    page_size="a4",         # or "letter"
    language="zh",          # "zh", "en", "mixed"
    title="Document Title", # optional, shown in PDF metadata
    author="",              # optional
)

# Add content from markdown file
builder.add_markdown_file("input.md")

# Or add content programmatically
builder.add_title("Section Title")
builder.add_paragraph("Body text here...")
builder.add_table(headers=["Col1", "Col2"], rows=[["a", "b"], ["c", "d"]])

# Build the PDF
builder.build()
```

## Font Handling

The script auto-detects available CJK fonts on the system. Priority order:

1. DroidSansFallbackFull.ttf (best TrueType Chinese support with reportlab)
2. AR PL UMing/UKai (serif/kai style, good fallback)
3. Noto Sans/Serif CJK (may require conversion from OTF to TTF)

For English-only documents, the standard reportlab fonts (Helvetica, Times) are
used automatically — no extra configuration needed.

If fonts are missing, the script prints clear error messages listing which
font packages to install.

## Important Constraints

- **reportlab does NOT support PostScript-outline OpenType fonts (.otf / .ttc with CFF).**
  The bundled script handles this by preferring TrueType-outline fonts.
- **Never use Unicode subscript/superscript characters** (₀₁₂, ⁰¹²) — use
  `<super>` and `<sub>` XML tags in Paragraphs instead.
- **Chinese font registration must happen before any text is drawn.** The
  bundled script handles this in `PDFBuilder.__init__`.
- **Tables with Chinese text need explicit colWidths** — the auto-width
  calculation often fails with CJK characters. The script estimates widths
  based on character count.

## Example: Quick Markdown → PDF

```bash
# Minimal invocation
python /home/c2216-3090/.claude/skills/pdf-generator/scripts/generate_pdf.py \
  -i report.md -o report.pdf
```

The script will auto-detect language from content and apply reasonable defaults.
