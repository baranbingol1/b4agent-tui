# Scanned PDFs and OCR (opt-in)

<!-- From Hermes Agent's pdf skill (MIT, Copyright (c) 2026 Nous Research).
     Changed by b4agent: made opt-in, added the license and consent rules,
     removed Hermes-only tools (web_extract, execute_code). -->

Use this only when `pdf_read.py --meta` reports `likely_scanned_pages`, or text extraction comes back empty or garbled on pages that visibly hold text. The default `pdf` skill path (pypdf, pdfplumber) has no OCR.

## First try: render and look

For a handful of pages, no install is needed: render the pages and read the images yourself.

```bash
python scripts/pdf_page_image.py scan.pdf --pages 1-3 --dpi 150 --out-dir /tmp/scan-pages
```

Open each PNG with `read`. This is often enough to answer a question about a scanned page or to transcribe a short one.

## Heavier extractors need the user's consent

Both extractors below are opt-in. Ask before installing either one, and say why:

| | pymupdf (+ pymupdf4llm) | marker-pdf |
|---|---|---|
| License | **AGPL-3.0** | **GPL-3.0** code, model weights under their own terms |
| Size | ~25 MB | ~3-5 GB (PyTorch plus ~2.5 GB of models in `~/.cache/huggingface/`) |
| OCR of scanned pages | no | yes, 90+ languages |
| Tables, equations, reading order | basic tables | yes |
| Speed | instant | ~1-14 s per page on CPU |

Neither is installed by default: b4agent and these scripts stay MIT/Apache-only unless the user opts in. Using them locally is fine; tell the user before they ship code that imports them, because the AGPL/GPL terms then apply to that code.

pymupdf helps with text-layer PDFs where pdfplumber struggles (odd encodings, Markdown output). It does **not** OCR. marker-pdf is the one for scanned documents.

## pymupdf

```bash
python scripts/check_deps.py pdf --ocr --install   # after the user agrees; installs pymupdf + pymupdf4llm
python scripts/extract_pymupdf.py document.pdf              # plain text
python scripts/extract_pymupdf.py document.pdf --markdown   # Markdown
python scripts/extract_pymupdf.py document.pdf --tables
python scripts/extract_pymupdf.py document.pdf --images out/
python scripts/extract_pymupdf.py document.pdf --metadata
python scripts/extract_pymupdf.py document.pdf --pages 0-4  # 0-based, unlike the other scripts
```

## marker-pdf

```bash
python scripts/extract_marker.py --check     # free disk space; needs ~5 GB
<python> -m pip install marker-pdf           # after the user agrees; use the interpreter check_deps.py reports
python scripts/extract_marker.py scanned.pdf                # Markdown, OCR included
python scripts/extract_marker.py document.pdf --json
python scripts/extract_marker.py document.pdf --output_dir out/
```

`--use_llm` sends page content to an LLM provider for better accuracy and needs that provider's API key; don't use it without the user's say-so.

If the disk is too small for marker, say so with the numbers, and offer the render-and-read route above.

## Notes

- Never report empty extraction from a scanned page as "no content", and never fabricate text for it.
- For `.docx` or `.pptx`, use the `docx` or `pptx` skill; their text is structured and needs no OCR.
