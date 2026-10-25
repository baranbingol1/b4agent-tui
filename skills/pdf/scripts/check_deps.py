#!/usr/bin/env python3
# Part of b4agent's office skills (docx, xlsx, pdf, pptx). MIT License.
# The same file ships in each skill's scripts/ so every skill stays self-contained.
"""Check (and optionally install) what an office skill needs.

Usage:
  check_deps.py FORMAT [--render] [--ocr] [--install]

FORMAT is docx, xlsx, pdf, pptx or all. Prints JSON:

  python            the interpreter to run this skill's scripts with
  missing           pip packages still missing for the requested features
  missing_tools     system tools still missing (never installed by this script)
  tool_hint         how to install those tools
  installed         what --install just installed

--render  also check what page/slide rendering needs (LibreOffice, poppler,
          pdf2image for docx, pypdfium2 for pdf).
--ocr     also check the opt-in PDF OCR path (pymupdf is AGPL-3.0, marker-pdf
          is GPL-3.0 and pulls ~5 GB of models). Ask the user before using it.
--install install only the missing pip packages. Never touches the system
          Python: it installs into the active virtualenv, or else into a
          dedicated one ($B4AGENT_OFFICE_VENV, default
          ~/.cache/b4agent/office-venv), creating it on first use.

Exit code 0 when nothing required is missing, 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# pip name -> import name
REQUIRED = {
    "docx": {"python-docx": "docx"},
    "xlsx": {"openpyxl": "openpyxl"},
    "pdf": {"pypdf": "pypdf", "reportlab": "reportlab", "pdfplumber": "pdfplumber"},
    "pptx": {"python-pptx": "pptx"},
}
RENDER_PY = {"docx": {"pdf2image": "pdf2image"}, "pdf": {"pypdfium2": "pypdfium2"}}
RENDER_TOOLS = {
    "docx": [["soffice", "libreoffice"], ["pdftoppm"]],
    "xlsx": [["soffice", "libreoffice"], ["pdftoppm"]],
    "pdf": [["pdftoppm"]],
    "pptx": [["soffice", "libreoffice"], ["pdftoppm", "pdftocairo"]],
}
OCR_PY = {"pymupdf": "pymupdf", "pymupdf4llm": "pymupdf4llm"}
TOOL_HINT = ("LibreOffice and poppler: `sudo apt-get install -y libreoffice poppler-utils` "
             "(Debian/Ubuntu), `sudo dnf install libreoffice poppler-utils` (Fedora), "
             "`brew install --cask libreoffice && brew install poppler` (macOS).")


def office_venv() -> Path:
    if os.environ.get("B4AGENT_OFFICE_VENV"):
        return Path(os.environ["B4AGENT_OFFICE_VENV"]).expanduser()
    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return cache / "b4agent" / "office-venv"


def venv_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def missing_in(python: str, wanted: dict[str, str]) -> list[str]:
    """pip names whose import name isn't importable by `python`."""
    if not wanted:
        return []
    probe = ("import importlib.util, json, sys; "
             "print(json.dumps([m for m in sys.argv[1:] if importlib.util.find_spec(m) is None]))")
    try:
        out = subprocess.run([python, "-I", "-c", probe, *wanted.values()], capture_output=True,
                             text=True, encoding="utf-8", timeout=60, check=True).stdout
        gone = set(json.loads(out))
    except (OSError, subprocess.SubprocessError, ValueError):
        return list(wanted)
    return [pip for pip, mod in wanted.items() if mod in gone]


def in_venv() -> bool:
    return sys.prefix != sys.base_prefix or bool(os.environ.get("VIRTUAL_ENV"))


def install(python: str, packages: list[str]) -> None:
    uv = shutil.which("uv")
    cmd = ([uv, "pip", "install", "--python", python, *packages] if uv
           else [python, "-m", "pip", "install", *packages])
    subprocess.run(cmd, check=True, stdout=sys.stderr)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("format", choices=["docx", "xlsx", "pdf", "pptx", "all"])
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--ocr", action="store_true")
    ap.add_argument("--install", action="store_true")
    args = ap.parse_args(argv)

    formats = list(REQUIRED) if args.format == "all" else [args.format]
    wanted: dict[str, str] = {}
    tools: list[list[str]] = []
    for f in formats:
        wanted.update(REQUIRED[f])
        if args.render:
            wanted.update(RENDER_PY.get(f, {}))
            tools += [t for t in RENDER_TOOLS[f] if t not in tools]
    if args.ocr:
        wanted.update(OCR_PY)

    # The interpreter that already has the most of what's needed.
    candidates = [sys.executable]
    vpy = venv_python(office_venv())
    if vpy.exists():
        candidates.append(str(vpy))
    scored = [(len(missing_in(c, wanted)), i, c) for i, c in enumerate(candidates)]
    python = min(scored)[2]
    missing = missing_in(python, wanted)

    installed: list[str] = []
    if args.install and missing:
        target = python
        if target == sys.executable and not in_venv():
            # Never pip-install into the system interpreter.
            if not vpy.exists():
                vpy.parent.parent.mkdir(parents=True, exist_ok=True)
                uv = shutil.which("uv")
                subprocess.run([uv, "venv", "-q", str(office_venv())] if uv
                               else [sys.executable, "-m", "venv", str(office_venv())],
                               check=True, stdout=sys.stderr)
            target = str(vpy)
            missing = missing_in(target, wanted)
        if missing:
            install(target, missing)
            installed = missing
        python = target
        missing = missing_in(python, wanted)

    missing_tools = ["/".join(alts) for alts in tools if not any(shutil.which(a) for a in alts)]
    print(json.dumps({
        "python": python,
        "missing": missing,
        "missing_tools": missing_tools,
        **({"tool_hint": TOOL_HINT} if missing_tools else {}),
        **({"installed": installed} if installed else {}),
    }, indent=2))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
