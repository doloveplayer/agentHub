# Font Configuration Reference

## reportlab Chinese Font Compatibility

reportlab's TTFont only supports TrueType-outline fonts. Many modern CJK fonts use
PostScript (CFF) outlines and will fail with:
```
TTFError: postscript outlines are not supported
```

## Compatible Fonts (tested)

| Font | Path | Type | Quality |
|------|------|------|---------|
| DroidSansFallbackFull | `/usr/share/fonts/truetype/droid/` | Sans-serif, regular | Best for body text |
| AR PL UMing | `/usr/share/fonts/truetype/arphic/uming.ttc` | Serif, 0-indexed | Good for bold/headings |
| AR PL UKai | `/usr/share/fonts/truetype/arphic/ukai.ttc` | Kai-style | Decorative |
| DejaVu Sans Mono | `/usr/share/fonts/truetype/dejavu/` | Monospace | Code blocks |

## Incompatible Fonts (will crash)

| Font | Issue |
|------|-------|
| Noto Sans/Serif CJK (.ttc) | PostScript CFF outlines |
| Source Han Sans/Serif | PostScript CFF outlines |
| WenQuanYi Micro Hei | PostScript outlines |

## Installing Compatible Fonts

```bash
# Ubuntu/Debian
sudo apt install fonts-droid-fallback fonts-arphic-uming

# CentOS/RHEL
sudo yum install fonts-droid-fallback
```

## Adding Custom Fonts

Register before creating ParagraphStyle objects:
```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont('MyFont', '/path/to/font.ttf'))
# For .ttc collections, specify subfontIndex:
pdfmetrics.registerFont(TTFont('MyFont', '/path/to/font.ttc', subfontIndex=0))
```

## Language Detection Heuristic

The bundled script detects language by scanning for CJK Unicode ranges:
- `一-鿿` (CJK Unified Ideographs)
- `㐀-䶿` (CJK Extension A)

If >15% of sampled characters are CJK → `zh`, if any CJK present → `mixed`, otherwise `en`.
