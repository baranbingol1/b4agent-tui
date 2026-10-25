---
name: office-read
description: Read the text of an office or document file to answer questions about it, summarize it or quote it - .docx, .xlsx, .pptx, .pdf, .epub, .odt, .rtf, .doc, .xls, .ppt, .msg, .html. Use when the task only needs the content; to create or change a file, use the docx, xlsx, pptx or pdf skill.
license: MIT
metadata:
  author: b4agent
---

# Reading office files

The `read` tool shows text and images, not office formats. To read one, convert it to text first. Pick the first route that works:

1. **The format's own reader**, when the docx, xlsx, pptx or pdf skill is available. These need only small Python packages, which each skill's `scripts/check_deps.py <format>` checks and installs:

   | file | command (run from that skill's directory) |
   |---|---|
   | `.docx` | `python scripts/docx_read.py f.docx --text` (`--structure` for headings and tables) |
   | `.xlsx` | `python scripts/xlsx_read.py f.xlsx --sheets`, then `--json --sheet NAME` |
   | `.pptx` | `python scripts/pptx_read.py f.pptx --outline` (`--notes` for speaker notes) |
   | `.pdf` | `python scripts/pdf_read.py f.pdf --text` (`--tables`, `--meta`) |

2. **markitdown**, for everything else or for one Markdown dump of any of these (Microsoft, MIT). It's optional; install it only when route 1 doesn't fit, and tell the user:

   ```bash
   command -v markitdown || uv tool install 'markitdown[all]'   # or: pipx install 'markitdown[all]'
   markitdown file.pptx -o /tmp/file.md
   ```

   It handles docx, xlsx, xls, pptx, pdf, epub, html, msg, zip archives and more. Its plugins and the `[all]` extras can call outside services only when configured to (image captions with an LLM key, Azure Document Intelligence); don't configure them without the user's say-so.

3. **LibreOffice** for legacy binaries (`.doc`, `.xls`, `.ppt`, `.odt`, `.rtf`) when markitdown isn't there: `soffice --headless --convert-to docx --outdir /tmp/conv file.doc` (or `xlsx`, `pptx`, `pdf`), then use route 1.

Then `read` the output. For a big result, read only the parts you need.

Pitfalls:

- Spreadsheets: converters show cached values, not formulas. Files saved by openpyxl have no cached values, so formula cells come back empty; `xlsx_read.py --formulas` shows the formulas.
- Scanned PDFs have no text layer: empty text is not "no content". Render the pages (`pdf_page_image.py`) and `read` the images, or see the pdf skill's `references/ocr-extraction.md`.
- Layout (columns, text boxes, slide positions) is flattened. When layout is the question, render to PNG with the format's skill and look.
