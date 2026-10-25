/* ==========================================================================
   repo-wiki runtime — classic script, no modules, works from file://
   Reads:
     window.REPO_WIKI        (assets/nav.js)         — site meta + nav tree
     window.REPO_WIKI_SEARCH (assets/search-index.js) — client-side search index
   Copied verbatim from the skill's assets/ directory; do not hand-edit
   inside generated wikis.
   ========================================================================== */
(function () {
  "use strict";

  var REPO_WIKI = window.REPO_WIKI || { project: "wiki", nav: [] };
  var SEARCH = window.REPO_WIKI_SEARCH || [];

  /* ---------- helpers ---------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function slugify(text) {
    return String(text).toLowerCase().trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  }

  function currentFile() {
    var parts = location.pathname.split("/");
    var last = decodeURIComponent(parts[parts.length - 1] || "");
    return last === "" ? "index.html" : last;
  }

  /* ---------- theme ----------
     The switch is global: every page follows the last choice. localStorage is
     the primary store, but plenty of contexts a wiki gets read in drop or
     reject it — file:// in Safari, Chrome/Edge with site data blocked, private
     windows, sandboxed preview iframes. There the write used to fail silently
     and only the current page flipped. So we verify the write, and when it did
     not stick we carry the choice in the URL (?theme=dark), stamping it onto
     in-wiki links as they are clicked. */

  var THEME_KEY = "repo-wiki-theme";
  var themeInUrl = false; // true once we know localStorage cannot be trusted

  function validTheme(t) { return t === "light" || t === "dark" ? t : null; }

  function themeFromUrl() {
    var m = /[?&]theme=(light|dark)(?:&|$)/.exec(location.search);
    return m ? m[1] : null;
  }

  function storedTheme() {
    try { return validTheme(localStorage.getItem(THEME_KEY)); } catch (e) { return null; }
  }

  function persistTheme(theme) {
    // true only if the value is really readable back — a silent drop counts as failure
    try {
      localStorage.setItem(THEME_KEY, theme);
      return localStorage.getItem(THEME_KEY) === theme;
    } catch (e) { return false; }
  }

  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function preferredTheme() {
    return themeFromUrl() || storedTheme() || systemTheme();
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var btn = $("#theme-btn");
    if (btn) btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }

  function withTheme(href, theme) {
    var hash = "", q = "";
    var h = href.indexOf("#");
    if (h !== -1) { hash = href.slice(h); href = href.slice(0, h); }
    var qi = href.indexOf("?");
    if (qi !== -1) { q = href.slice(qi + 1); href = href.slice(0, qi); }
    q = q.split("&").filter(function (p) { return p && !/^theme=/.test(p); });
    q.push("theme=" + theme);
    return href + "?" + q.join("&") + hash;
  }

  function isInWikiLink(a) {
    var raw = a.getAttribute("href") || "";
    if (!raw || raw.charAt(0) === "#") return false;
    if (a.target && a.target !== "_self") return false;
    if (a.hasAttribute("download")) return false;
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return false; }
    if (url.protocol !== location.protocol || url.host !== location.host) return false;
    return /(^|\/)[^\/]*\.html?$|\/$/.test(url.pathname);
  }

  function stampUrl(theme) {
    // keep the current address in sync so reload / back / copied link stay put
    try { history.replaceState(history.state, "", withTheme(location.href, theme)); } catch (e) { /* file:// may refuse */ }
  }

  function setTheme(theme) {
    applyTheme(theme);
    if (!persistTheme(theme)) themeInUrl = true;
    if (themeInUrl) stampUrl(theme);
  }

  function currentTheme() {
    return validTheme(document.documentElement.getAttribute("data-theme")) || systemTheme();
  }

  function toggleTheme() {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
    mermaidRenderAll(); // diagrams must match the theme
  }

  // Boot before first paint (the templates' inline <head> script does the same,
  // this covers a page that was authored without it).
  applyTheme(preferredTheme());
  if (themeFromUrl() && !persistTheme(currentTheme())) themeInUrl = true;

  // Fallback path: rewrite in-wiki links on the way out so the next page agrees.
  // Capture phase, so the browser navigates to the updated href — ctrl-click,
  // middle-click and keyboard activation all keep working.
  function stampLinkOnActivate(e) {
    if (!themeInUrl) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || !isInWikiLink(a)) return;
    a.setAttribute("href", withTheme(a.getAttribute("href"), currentTheme()));
  }
  document.addEventListener("click", stampLinkOnActivate, true);
  document.addEventListener("auxclick", stampLinkOnActivate, true);

  // Other tabs of the same wiki follow along when storage does work.
  window.addEventListener("storage", function (e) {
    if (e.key !== THEME_KEY) return;
    var t = validTheme(e.newValue);
    if (t && t !== currentTheme()) { applyTheme(t); mermaidRenderAll(); }
  });

  /* ---------- sidebar nav ---------- */

  function buildSidebar() {
    var host = $("#sidebar-nav");
    if (!host) return;
    var here = currentFile();
    var html = "";
    (REPO_WIKI.nav || []).forEach(function (section, si) {
      html += '<details class="nav-section" open><summary>' + esc(section.section) +
        '<span class="twist">▾</span></summary><ul>';
      (section.items || []).forEach(function (item, ii) {
        var active = item.file === here ? " active" : "";
        var num = (si + 1) + "." + (ii + 1);
        html += '<li><a class="nav-link' + active + '" href="./' + esc(item.file) + '"' +
          (active ? ' aria-current="page"' : "") + '>' +
          '<span class="num">' + num + "</span><span>" + esc(item.title) + "</span></a></li>";
      });
      html += "</ul></details>";
    });
    host.innerHTML = html;
    var active = $(".nav-link.active", host);
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  function activeNavEntry() {
    var here = currentFile();
    var found = null;
    (REPO_WIKI.nav || []).forEach(function (section) {
      (section.items || []).forEach(function (item) {
        if (item.file === here) found = { section: section.section, title: item.title };
      });
    });
    return found;
  }

  function buildCrumbs() {
    var host = $("#crumbs");
    if (!host) return;
    var entry = activeNavEntry();
    if (!entry) { host.innerHTML = ""; return; }
    host.innerHTML = '<span>' + esc(entry.section) + '</span><span class="sep">/</span>' +
      '<span class="here">' + esc(entry.title) + "</span>";
  }

  /* ---------- article enhancements ---------- */

  function enhanceHeadings() {
    $all(".wiki-article h2, .wiki-article h3").forEach(function (h) {
      if (h.closest(".card")) return;
      if (!h.id) h.id = slugify(h.textContent);
      if (!$(".anchor-link", h)) {
        var a = document.createElement("a");
        a.className = "anchor-link";
        a.href = "#" + h.id;
        a.textContent = "#";
        a.setAttribute("aria-label", "Link to this section");
        h.appendChild(a);
      }
    });
  }

  function enhanceTables() {
    $all(".wiki-article table").forEach(function (t) {
      if (t.parentElement && t.parentElement.classList.contains("table-wrap")) return;
      var wrap = document.createElement("div");
      wrap.className = "table-wrap";
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
  }

  function enhanceCodeBlocks() {
    $all(".wiki-article pre").forEach(function (pre) {
      if (pre.classList.contains("mermaid")) return; // diagram source, not code

      var code = pre.querySelector("code");
      var langMatch = code && /language-([\w+-]+)/.exec(code.className || "");
      if (langMatch && !pre.querySelector(".code-lang")) {
        var label = document.createElement("span");
        label.className = "code-lang";
        label.textContent = langMatch[1];
        pre.appendChild(label);
      }
      if (!pre.querySelector(".code-copy")) {
        var btn = document.createElement("button");
        btn.className = "code-copy";
        btn.type = "button";
        btn.textContent = "copy";
        btn.addEventListener("click", function () {
          var text = code ? code.textContent : pre.textContent;
          copyText(text, btn);
        });
        pre.appendChild(btn);
      }
    });
  }

  function copyText(text, btn) {
    function done() {
      btn.textContent = "copied";
      btn.classList.add("done");
      setTimeout(function () { btn.textContent = "copy"; btn.classList.remove("done"); }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else {
      legacyCopy(text);
      done();
    }
  }

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* best effort */ }
    document.body.removeChild(ta);
  }

  /* Source chips: <code class="src" data-path="src/x.py" data-lines="10-42">
     become links to the repo host when REPO_WIKI.repoUrl is set. */

  function blobUrl(path, lines) {
    var repo = (REPO_WIKI.repoUrl || "").replace(/\.git$/, "").replace(/\/+$/, "");
    if (!repo) return null;
    var ref = REPO_WIKI.commit || REPO_WIKI.branch || "main";
    var anchor = "";
    var m = /^(\d+)(?:-(\d+))?$/.exec(lines || "");
    if (repo.indexOf("github.com") !== -1) {
      if (m) anchor = "#L" + m[1] + (m[2] ? "-L" + m[2] : "");
      return repo + "/blob/" + ref + "/" + path + anchor;
    }
    if (repo.indexOf("gitlab") !== -1) {
      if (m) anchor = "#L" + m[1] + (m[2] ? "-" + m[2] : "");
      return repo + "/-/blob/" + ref + "/" + path + anchor;
    }
    if (repo.indexOf("bitbucket.org") !== -1) {
      if (m) anchor = "#lines-" + m[1] + (m[2] ? ":" + m[2] : "");
      return repo + "/src/" + ref + "/" + path + anchor;
    }
    // dev.azure.com and unknown hosts: link to the repo root rather than guess
    return null;
  }

  function enhanceSourceChips() {
    $all("code.src[data-path], a.src[data-path]").forEach(function (el) {
      var path = el.getAttribute("data-path");
      var lines = el.getAttribute("data-lines") || "";
      var label = path + (lines ? '<span class="ln">:' + esc(lines) + "</span>" : "");
      var url = blobUrl(path, lines);
      if (el.tagName === "A") {
        el.innerHTML = label;
        if (url) { el.href = url; el.target = "_blank"; el.rel = "noopener"; }
        return;
      }
      if (url) {
        var a = document.createElement("a");
        a.className = el.className;
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.title = path + (lines ? ":" + lines : "");
        a.innerHTML = label;
        el.parentNode.replaceChild(a, el);
      } else {
        el.title = path + (lines ? ":" + lines : "");
        el.innerHTML = label;
      }
    });
  }

  /* ---------- table of contents (right rail) ---------- */

  var tocLinks = [];
  var tocHeadings = [];

  function buildToc() {
    var host = $("#toc");
    if (!host) return;
    var headings = $all(".wiki-article h2, .wiki-article h3").filter(function (h) {
      return !h.closest(".card"); // card titles are not page sections
    });
    if (headings.length < 2) { host.style.visibility = "hidden"; return; }
    var html = '<div class="toc-label">On this page</div><ul>';
    headings.forEach(function (h) {
      var lvl = h.tagName === "H2" ? 2 : 3;
      var text = h.textContent.replace(/#\s*$/, "").trim();
      html += '<li class="lvl-' + lvl + '"><a href="#' + esc(h.id) + '">' + esc(text) + "</a></li>";
    });
    html += "</ul>";
    host.innerHTML = html;
    tocLinks = $all("a", host);
    tocHeadings = headings;
    window.addEventListener("scroll", onScrollSpy, { passive: true });
    onScrollSpy();
  }

  var spyTick = false;
  function onScrollSpy() {
    if (spyTick) return;
    spyTick = true;
    requestAnimationFrame(function () {
      spyTick = false;
      var fromTop = 90; // topbar + breathing room
      var current = -1;
      for (var i = 0; i < tocHeadings.length; i++) {
        if (tocHeadings[i].getBoundingClientRect().top <= fromTop + 10) current = i;
      }
      if (current === -1) current = 0;
      tocLinks.forEach(function (a, i) { a.classList.toggle("current", i === current); });
    });
  }

  /* ---------- search ---------- */

  var searchOpen = false;
  var hits = [];
  var selected = 0;

  function openSearch() {
    var overlay = $("#search-overlay");
    if (!overlay) return;
    overlay.classList.add("open");
    searchOpen = true;
    var input = $("#search-input");
    input.value = "";
    renderHits("");
    setTimeout(function () { input.focus(); }, 0);
  }

  function closeSearch() {
    var overlay = $("#search-overlay");
    if (overlay) overlay.classList.remove("open");
    searchOpen = false;
  }

  function scoreEntry(entry, tokens) {
    var title = (entry.title || "").toLowerCase();
    var section = (entry.section || "").toLowerCase();
    var summary = (entry.summary || "").toLowerCase();
    var keywords = (entry.keywords || []).join(" ").toLowerCase();
    var total = 0;
    var bestHeading = null;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var s = 0;
      if (title === t) s = 100;
      else if (title.indexOf(t) === 0) s = 60;
      else if (title.indexOf(t) !== -1) s = 40;
      var headingHit = null;
      (entry.headings || []).forEach(function (h) {
        if ((h.t || "").toLowerCase().indexOf(t) !== -1) headingHit = h;
      });
      if (headingHit) { s = Math.max(s, 25); if (!bestHeading) bestHeading = headingHit; }
      if (keywords.indexOf(t) !== -1) s = Math.max(s, 15);
      if (summary.indexOf(t) !== -1) s = Math.max(s, 10);
      if (section.indexOf(t) !== -1) s = Math.max(s, 5);
      if (s === 0) return null; // every token must match somewhere
      total += s;
    }
    return { score: total, heading: bestHeading };
  }

  function renderHits(query) {
    var host = $("#search-results");
    if (!host) return;
    var tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    hits = [];
    if (tokens.length === 0) {
      hits = SEARCH.slice(0, 12).map(function (e) { return { entry: e, heading: null }; });
    } else {
      SEARCH.forEach(function (e) {
        var r = scoreEntry(e, tokens);
        if (r) hits.push({ entry: e, heading: r.heading, score: r.score });
      });
      hits.sort(function (a, b) { return b.score - a.score; });
      hits = hits.slice(0, 20);
    }
    selected = 0;
    if (hits.length === 0) {
      host.innerHTML = '<div class="no-hits">No matches for “' + esc(query) + "”</div>";
      return;
    }
    var html = "";
    var lastGroup = null;
    hits.forEach(function (h, i) {
      var group = h.entry.section || "Pages";
      if (group !== lastGroup) {
        html += '<div class="group-label">' + esc(group) + "</div>";
        lastGroup = group;
      }
      var href = "./" + h.entry.file + (h.heading ? "#" + h.heading.a : "");
      var context = h.heading ? ("§ " + h.heading.t) : (h.entry.summary || "");
      html += '<a class="hit' + (i === 0 ? " selected" : "") + '" data-i="' + i + '" href="' + esc(href) + '">' +
        '<div class="hit-title">' + esc(h.entry.title) + "</div>" +
        '<div class="hit-context">' + esc(context) + "</div></a>";
    });
    host.innerHTML = html;
  }

  function moveSelection(delta) {
    var links = $all("#search-results a.hit");
    if (links.length === 0) return;
    selected = (selected + delta + links.length) % links.length;
    links.forEach(function (a, i) { a.classList.toggle("selected", i === selected); });
    links[selected].scrollIntoView({ block: "nearest" });
  }

  function wireSearch() {
    var overlay = $("#search-overlay");
    var input = $("#search-input");
    var btn = $("#search-btn");
    if (!overlay || !input) return;

    if (btn) btn.addEventListener("click", openSearch);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) closeSearch();
    });
    input.addEventListener("input", function () { renderHits(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
      else if (e.key === "Enter") {
        var links = $all("#search-results a.hit");
        // .click() so the theme-propagation handler sees this navigation too
        if (links[selected]) links[selected].click();
      }
    });

    document.addEventListener("keydown", function (e) {
      var inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        searchOpen ? closeSearch() : openSearch();
      } else if (e.key === "/" && !searchOpen && !inField) {
        e.preventDefault();
        openSearch();
      } else if (e.key === "Escape" && searchOpen) {
        closeSearch();
      }
    });
  }

  /* ---------- mermaid (CDN with local-vendor fallback) ---------- */

  var MERMAID_LOCAL = "./assets/mermaid.min.js";
  var MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
  var mermaidBlocks = [];
  var mermaidFailed = false;

  // A literal <br/> in a diagram label is parsed by the HTML parser into a real
  // <br> element, which textContent then drops — "Foo<br/>12 lines" would reach
  // mermaid as "Foo12 lines". Put the marker back as text before handing it over.
  function mermaidSource(el) {
    var clone = el.cloneNode(true);
    $all("br", clone).forEach(function (br) {
      br.parentNode.replaceChild(document.createTextNode("<br/>"), br);
    });
    return clone.textContent.trim();
  }

  function collectMermaid() {
    mermaidBlocks = $all(".mermaid");
    mermaidBlocks.forEach(function (el) {
      if (!el.dataset.src) el.dataset.src = mermaidSource(el);
    });
  }

  function loadScript(src, onload, onerror) {
    var s = document.createElement("script");
    s.src = src;
    s.onload = onload;
    s.onerror = onerror;
    document.head.appendChild(s);
  }

  function ensureMermaid() {
    if (mermaidBlocks.length === 0) return;
    if (window.mermaid) { mermaidRenderAll(); return; }
    // Prefer a vendored copy (fully offline) and fall back to the CDN.
    loadScript(MERMAID_LOCAL, mermaidRenderAll, function () {
      loadScript(MERMAID_CDN, mermaidRenderAll, mermaidFallback);
    });
  }

  function mermaidRenderAll() {
    if (!window.mermaid || mermaidBlocks.length === 0 || mermaidFailed) return;
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: dark ? "dark" : "neutral",
        securityLevel: "loose",
        fontFamily: "Seravek, 'Avenir Next', 'Segoe UI', system-ui, sans-serif"
      });
    } catch (e) { /* keep going with defaults */ }
    mermaidBlocks.forEach(function (el, i) {
      el.removeAttribute("data-processed");
      el.innerHTML = "";
      el.textContent = el.dataset.src;
      el.id = el.id || ("repo-wiki-mmd-" + i);
    });
    try {
      // mermaid v10/v11 API
      window.mermaid.run({ nodes: mermaidBlocks })
        .then(applyAllDiagramZoom)
        .catch(function () { mermaidFallback(); });
    } catch (e) {
      try {
        window.mermaid.init(undefined, mermaidBlocks);
        applyAllDiagramZoom();
      } catch (e2) { mermaidFallback(); }
    }
  }

  function mermaidFallback() {
    mermaidFailed = true;
    $all(".diagram-bar").forEach(function (b) { b.remove(); }); // no svg, no zoom
    mermaidBlocks.forEach(function (el) {
      if (el.getAttribute("data-processed")) return;
      var src = el.dataset.src || el.textContent;
      var d = document.createElement("details");
      d.className = "mermaid-fallback";
      d.innerHTML = "<summary>Diagram source (Mermaid) — rendering needs network access once, " +
        "or save <code>mermaid.min.js</code> into <code>repo-wiki/assets/</code>.</summary>";
      var pre = document.createElement("pre");
      var code = document.createElement("code");
      code.textContent = src;
      pre.appendChild(code);
      d.appendChild(pre);
      el.replaceWith(d);
    });
  }

  /* ---------- diagram zoom / pan / fullscreen ----------
     Injected at runtime onto every <figure class="diagram"> — generated pages
     need no extra markup. "fit" (default) keeps mermaid's shrink-to-container
     behavior; any zoom pins the SVG to natural-size × k so dense diagrams
     become readable, with drag-to-pan and a fullscreen lightbox. */

  var ZSTEP = 1.25, ZMIN = 0.25, ZMAX = 4;
  var lightbox = null;
  var lbHome = null; // comment node marking where the figure came from

  function diagramSvg(fig) { return fig.querySelector("pre.mermaid svg"); }

  function naturalWidth(svg) {
    try {
      var vb = svg.viewBox.baseVal;
      if (vb && vb.width) return vb.width;
    } catch (e) { /* no viewBox */ }
    var mw = parseFloat(svg.style.maxWidth || "");
    if (mw) return mw;
    var r = svg.getBoundingClientRect();
    return r.width || 600;
  }

  function effScale(fig) {
    var st = fig._dz || { mode: "fit", k: 1 };
    if (st.mode === "fixed") return st.k;
    var svg = diagramSvg(fig);
    if (!svg) return 1;
    var nw = naturalWidth(svg);
    var rw = svg.getBoundingClientRect().width;
    return nw && rw ? rw / nw : 1;
  }

  function applyZoom(fig) {
    var svg = diagramSvg(fig);
    var st = fig._dz || (fig._dz = { mode: "fit", k: 1 });
    var vp = $(".diagram-viewport", fig);
    if (svg) {
      if (st.mode === "fixed") {
        svg.style.maxWidth = "none";
        svg.style.width = Math.round(naturalWidth(svg) * st.k) + "px";
      } else {
        svg.style.maxWidth = "";
        svg.style.width = "";
      }
    }
    if (vp) {
      vp.classList.toggle("zoomed", st.mode === "fixed");
      vp.classList.toggle("pannable",
        vp.scrollWidth > vp.clientWidth + 1 || vp.scrollHeight > vp.clientHeight + 1);
    }
    var lvl = $(".dz-level", fig);
    if (lvl) {
      var s = effScale(fig);
      lvl.textContent = svg && s ? Math.round(s * 100) + "%" : "—";
    }
  }

  function applyAllDiagramZoom() {
    $all("figure.diagram").forEach(applyZoom);
  }

  function zoomBy(fig, factor) {
    var k = Math.min(ZMAX, Math.max(ZMIN, effScale(fig) * factor));
    fig._dz = { mode: "fixed", k: k };
    applyZoom(fig);
  }

  function zoomFit(fig) {
    fig._dz = { mode: "fit", k: 1 };
    applyZoom(fig);
  }

  function wirePan(vp) {
    var panning = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0;
    vp.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (!vp.classList.contains("pannable")) return;
      panning = true; moved = false;
      sx = e.clientX; sy = e.clientY; sl = vp.scrollLeft; st = vp.scrollTop;
      vp.classList.add("grabbing");
      try { vp.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
    });
    vp.addEventListener("pointermove", function (e) {
      if (!panning) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      vp.scrollLeft = sl - dx;
      vp.scrollTop = st - dy;
    });
    ["pointerup", "pointercancel"].forEach(function (t) {
      vp.addEventListener(t, function () {
        panning = false;
        vp.classList.remove("grabbing");
      });
    });
    // a drag must not trigger links inside the diagram
    vp.addEventListener("click", function (e) {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }, true);
  }

  function enhanceDiagrams() {
    $all("figure.diagram").forEach(function (fig) {
      var pre = $("pre.mermaid", fig);
      if (!pre || $(".diagram-bar", fig)) return;

      var vp = document.createElement("div");
      vp.className = "diagram-viewport";
      pre.parentNode.insertBefore(vp, pre);
      vp.appendChild(pre);

      var bar = document.createElement("div");
      bar.className = "diagram-bar";
      bar.innerHTML =
        '<button class="dz-btn" type="button" data-dz="out" aria-label="Zoom out">−</button>' +
        '<span class="dz-level">fit</span>' +
        '<button class="dz-btn" type="button" data-dz="in" aria-label="Zoom in">+</button>' +
        '<button class="dz-btn" type="button" data-dz="fit" aria-label="Fit to width">fit</button>' +
        '<button class="dz-btn" type="button" data-dz="full" aria-label="Open fullscreen">expand</button>';
      fig.insertBefore(bar, fig.firstChild);

      bar.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-dz]");
        if (!btn) return;
        var op = btn.getAttribute("data-dz");
        if (op === "in") zoomBy(fig, ZSTEP);
        else if (op === "out") zoomBy(fig, 1 / ZSTEP);
        else if (op === "fit") zoomFit(fig);
        else if (op === "full") {
          if (fig.closest(".diagram-lightbox")) closeLightbox(); else openLightbox(fig);
        }
      });

      vp.addEventListener("dblclick", function () {
        var st = fig._dz || { mode: "fit" };
        if (st.mode === "fit") { fig._dz = { mode: "fixed", k: 1 }; applyZoom(fig); }
        else zoomFit(fig);
      });
      vp.addEventListener("wheel", function (e) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        zoomBy(fig, e.deltaY < 0 ? ZSTEP : 1 / ZSTEP);
      }, { passive: false });
      wirePan(vp);
    });
  }

  function ensureLightbox() {
    if (lightbox) return lightbox;
    lightbox = document.createElement("div");
    lightbox.className = "diagram-lightbox";
    lightbox.innerHTML =
      '<div class="lightbox-head"><span class="lightbox-title"></span>' +
      '<button class="dz-btn lightbox-close" type="button" aria-label="Close fullscreen">close ✕</button></div>' +
      '<div class="lightbox-body"></div>';
    document.body.appendChild(lightbox);
    $(".lightbox-close", lightbox).addEventListener("click", closeLightbox);
    lightbox.addEventListener("mousedown", function (e) {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && lightbox.classList.contains("open")) closeLightbox();
    });
    return lightbox;
  }

  function openLightbox(fig) {
    var lb = ensureLightbox();
    lbHome = document.createComment("diagram-home");
    fig.parentNode.insertBefore(lbHome, fig);
    $(".lightbox-body", lb).appendChild(fig);
    var cap = $("figcaption", fig);
    $(".lightbox-title", lb).textContent =
      (cap && cap.textContent.trim()) || document.title || "Diagram";
    lb.classList.add("open");
    lb._fig = fig;
    document.body.style.overflow = "hidden";
    applyZoom(fig);
  }

  function closeLightbox() {
    if (!lightbox || !lightbox.classList.contains("open")) return;
    var fig = lightbox._fig;
    if (fig && lbHome && lbHome.parentNode) lbHome.parentNode.replaceChild(fig, lbHome);
    lightbox._fig = null;
    lbHome = null;
    lightbox.classList.remove("open");
    document.body.style.overflow = "";
    if (fig) applyZoom(fig);
  }

  /* ---------- mobile drawer ---------- */

  function wireMobile() {
    var btn = $("#menu-btn");
    var sidebar = $("#sidebar");
    var backdrop = $("#sidebar-backdrop");
    if (!btn || !sidebar) return;
    btn.addEventListener("click", function () {
      var open = sidebar.classList.toggle("open");
      if (backdrop) backdrop.classList.toggle("show", open);
    });
    if (backdrop) backdrop.addEventListener("click", function () {
      sidebar.classList.remove("open");
      backdrop.classList.remove("show");
    });
  }

  /* ---------- footer stamp ---------- */

  function buildStamp() {
    var host = $("#stamp");
    if (!host) return;
    var bits = [];
    if (REPO_WIKI.generatedAt) bits.push("Generated " + esc(REPO_WIKI.generatedAt));
    if (REPO_WIKI.commit) bits.push('commit <code>' + esc(String(REPO_WIKI.commit).slice(0, 8)) + "</code>" +
      (REPO_WIKI.branch ? " on <code>" + esc(REPO_WIKI.branch) + "</code>" : ""));
    bits.push(esc(REPO_WIKI.generator || "repo-wiki"));
    host.innerHTML = bits.map(function (b) { return '<span class="stamp">' + b + "</span>"; }).join("");
  }

  /* ---------- boot ---------- */

  function boot() {
    buildSidebar();
    buildCrumbs();
    enhanceHeadings();
    enhanceTables();
    enhanceCodeBlocks();
    enhanceSourceChips();
    buildToc();
    wireSearch();
    wireMobile();
    buildStamp();
    var themeBtn = $("#theme-btn");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
    enhanceDiagrams();
    collectMermaid();
    ensureMermaid();
    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
