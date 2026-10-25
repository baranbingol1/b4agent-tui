#!/usr/bin/env python3
"""Validate a generated repo-wiki folder. Stdlib only.

Usage:  python validate.py <path-to-repo-wiki>

Exit 0 = pass (warnings allowed), exit 1 = errors found.
Checks structure, placeholder leftovers, nav/search/meta consistency,
internal links, citation paths, and per-page content requirements.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ERRORS: list[str] = []
WARNINGS: list[str] = []


def err(msg: str) -> None:
    ERRORS.append(msg)


def warn(msg: str) -> None:
    WARNINGS.append(msg)


def extract_files(js_text: str) -> list[str]:
    """Pull file: "x.html" entries out of nav.js / search-index.js.

    Accepts both the documented bare-key JS form (file: "x.html") and JSON-style
    quoted keys ("file": "x.html"). Matching only one form let a generator that
    emitted the other slip through with every nav/search check passing vacuously.
    """
    return re.findall(r'["\']?file["\']?\s*:\s*"([^"]+)"', js_text)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1
    wiki = Path(sys.argv[1]).resolve()
    repo = wiki.parent

    if not wiki.is_dir():
        print(f"FAIL: {wiki} is not a directory")
        return 1

    # --- required files -------------------------------------------------
    required = [
        "index.html",
        "meta.json",
        "assets/style.css",
        "assets/wiki.js",
        "assets/nav.js",
        "assets/search-index.js",
    ]
    for rel in required:
        if not (wiki / rel).is_file():
            err(f"missing required file: {rel}")

    pages = sorted(p.name for p in wiki.glob("*.html"))
    if not pages:
        err("no .html pages found")

    # --- foreign files (a generated wiki holds ONLY pages + meta + assets) ---
    if (wiki / "SKILL.md").is_file() and (wiki / "references").is_dir():
        err(
            "skill source detected inside the wiki folder (SKILL.md + references/) — "
            "the skill was installed at the output path; move it to the runtime's "
            "skills directory (e.g. .claude/skills/repo-wiki/)"
        )
    expected_assets = {
        "style.css", "wiki.js", "nav.js", "search-index.js", "mermaid.min.js",
    }
    media_files: set[str] = set()   # paths relative to the wiki root
    for item in sorted(wiki.iterdir()):
        if item.name.startswith("."):
            continue
        if item.is_file() and (item.suffix == ".html" or item.name == "meta.json"):
            continue
        if item.is_dir() and item.name == "assets":
            for a in sorted(item.iterdir()):
                # assets/media/ holds the optional screenshot pass output
                if a.is_dir() and a.name == "media":
                    for m in sorted(a.rglob("*")):
                        if m.is_file():
                            media_files.add(m.relative_to(wiki).as_posix())
                    continue
                if a.name not in expected_assets:
                    warn(f"unexpected file in assets/: {a.name}")
            continue
        warn(f"unexpected entry in wiki folder: {item.name}{'/' if item.is_dir() else ''}")

    # --- meta.json -------------------------------------------------------
    meta_pages: dict[str, dict] = {}
    meta_images: list[dict] = []
    meta_path = wiki / "meta.json"
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if meta.get("repoWiki") not in (1, 2):
                warn("meta.json: repoWiki schema marker is not 1 or 2")
            for key in ("generatedAt", "repo", "pages"):
                if key not in meta:
                    err(f"meta.json: missing key '{key}'")
            for p in meta.get("pages", []):
                f = p.get("file", "?")
                meta_pages[f] = p
                for key in ("title", "section", "sources", "hash"):
                    if key not in p:
                        err(f"meta.json: page '{f}' missing '{key}'")
                if not p.get("sources"):
                    warn(f"meta.json: page '{f}' has empty sources — update mode cannot map changes to it")
                contributors = p.get("contributors")
                if contributors is not None:
                    if not isinstance(contributors, list):
                        err(f"meta.json: page '{f}' contributors must be a list of names")
                    else:
                        for who in contributors:
                            if isinstance(who, str) and ("@" in who or who.endswith("[bot]")):
                                warn(f"meta.json: page '{f}' contributor '{who}' looks like an "
                                     "email or a bot — names only, bots filtered")
            meta_images = meta.get("images") or []
            if not isinstance(meta_images, list):
                err("meta.json: 'images' must be a list")
                meta_images = []
            if meta_images and meta.get("repoWiki") == 1:
                warn("meta.json: 'images' present but repoWiki is 1 — bump the marker to 2")
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            err(f"meta.json unparseable: {e}")

    # --- media manifest (optional; a wiki with no screenshots is fine) -----
    manifest_paths: set[str] = set()
    for img in meta_images:
        if not isinstance(img, dict):
            err("meta.json: each 'images' entry must be an object")
            continue
        rel = img.get("path")
        if not rel:
            err("meta.json: an 'images' entry is missing 'path'")
            continue
        manifest_paths.add(rel)
        if not (wiki / rel).is_file():
            err(f"meta.json: images entry points at a missing file: {rel}")
        for key in ("capturedAt", "pages", "sizeBytes"):
            if key not in img:
                warn(f"meta.json: images entry '{rel}' missing '{key}'")
        for target in img.get("pages") or []:
            if target not in pages:
                err(f"meta.json: images entry '{rel}' lists unknown page '{target}'")
    for rel in sorted(media_files - manifest_paths):
        warn(f"media file not listed in meta.json images: {rel}")

    # --- nav.js / search-index.js ----------------------------------------
    nav_files: list[str] = []
    nav_path = wiki / "assets" / "nav.js"
    if nav_path.is_file():
        nav_text = nav_path.read_text(encoding="utf-8")
        if "window.REPO_WIKI" not in nav_text:
            err("nav.js does not define window.REPO_WIKI")
        nav_files = extract_files(nav_text)
        if not nav_files:
            # without this the per-page nav checks below pass vacuously
            err("nav.js: no page entries parsed — every nav check below is meaningless")
        elif nav_files[0] != "index.html":
            warn("nav.js: index.html is not the first nav item")

    search_files: list[str] = []
    search_path = wiki / "assets" / "search-index.js"
    if search_path.is_file():
        search_text = search_path.read_text(encoding="utf-8")
        if "window.REPO_WIKI_SEARCH" not in search_text:
            err("search-index.js does not define window.REPO_WIKI_SEARCH")
        search_files = extract_files(search_text)
        if not search_files:
            err("search-index.js: no page entries parsed — search is empty or malformed")

    for f in nav_files:
        if not (wiki / f).is_file():
            err(f"nav.js references missing page: {f}")
    for name in pages:
        if nav_files and name not in nav_files:
            err(f"page not in nav.js: {name}")
        if search_files and name not in search_files:
            warn(f"page not in search-index.js: {name}")
        if meta_pages and name not in meta_pages:
            err(f"page not in meta.json: {name}")
    for f in meta_pages:
        if f not in pages:
            err(f"meta.json lists missing page file: {f}")

    # --- per-page content checks ------------------------------------------
    href_re = re.compile(r'href="\./([^"#]+)')
    datapath_re = re.compile(r'data-path="([^"]+)"')
    mermaid_re = re.compile(r'<pre class="mermaid">(.*?)</pre>', re.S)
    img_re = re.compile(r'<img\b[^>]*?\bsrc="([^"]+)"[^>]*>', re.S)
    byline_re = re.compile(r'<(\w+)[^>]*class="byline"[^>]*>(.*?)</\1>', re.S)

    missing_cited: set[str] = set()
    for name in pages:
        text = (wiki / name).read_text(encoding="utf-8", errors="replace")

        if "{{" in text:
            err(f"{name}: unreplaced template placeholder '{{{{' found")
        if "<h1>" not in text and "<h1 " not in text:
            err(f"{name}: no <h1>")
        if 'class="tldr"' not in text:
            warn(f"{name}: no TLDR box")
        if 'class="src"' not in text:
            warn(f"{name}: no source citation chips")
        if 'class="page-lede"' not in text:
            warn(f"{name}: no page lede")

        for target in href_re.findall(text):
            if target.startswith("assets/"):
                continue
            if not (wiki / target).is_file():
                err(f"{name}: broken internal link ./{target}")

        for src in set(datapath_re.findall(text)):
            p = repo / src
            if src.endswith("/"):
                if not p.is_dir():
                    missing_cited.add(src)
            elif not p.is_file():
                missing_cited.add(src)

        for block in mermaid_re.findall(text):
            if not block.strip():
                err(f"{name}: empty mermaid block")

        # images are optional, but a broken one is a visible hole in the page
        for tag in img_re.finditer(text):
            src = tag.group(1)
            if src.startswith(("data:", "http://", "https://", "//")):
                continue
            rel = src[2:] if src.startswith("./") else src.lstrip("/")
            if not (wiki / rel).is_file():
                warn(f"{name}: broken image src {src}")
            elif 'alt="' not in tag.group(0):
                warn(f"{name}: image {src} has no alt text")

        for _, body in byline_re.findall(text):
            plain = re.sub(r"<[^>]+>", " ", body)
            if "@" in plain:
                warn(f"{name}: byline contains '@' — use plain names, not handles or emails")
            # a standalone number in a byline means a count crept in; digits inside a
            # handle (baranbingol1) are part of the name and fine
            if re.search(r"(?<![^\W\d_])\d", plain):
                warn(f"{name}: byline contains a standalone number — names only, no per-person counts")

    for src in sorted(missing_cited):
        warn(f"cited path not found in repo (moved since generation?): {src}")

    # --- report -----------------------------------------------------------
    print(f"repo-wiki validation — {wiki}")
    print(f"  pages: {len(pages)}  nav entries: {len(nav_files)}  "
          f"search entries: {len(search_files)}  meta entries: {len(meta_pages)}  "
          f"media: {len(media_files)}")
    for w in WARNINGS:
        print(f"  WARN  {w}")
    for e in ERRORS:
        print(f"  ERROR {e}")
    if ERRORS:
        print(f"FAIL: {len(ERRORS)} error(s), {len(WARNINGS)} warning(s)")
        return 1
    print(f"PASS: 0 errors, {len(WARNINGS)} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
