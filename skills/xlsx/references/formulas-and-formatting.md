# Formula and formatting rules

<!-- Copyright OpenAI (openai/skills). Licensed under the Apache License, Version 2.0
     (see ../LICENSE-APACHE.txt). From openai/skills
     skills/.curated/spreadsheet/SKILL.md at
     e6afb0d74cc75d220df2faf3dd6c635c2dc6a108, the last commit before the
     skill was removed (fdf90d6).
     Modified by the b4agent authors, 2026-10-21: kept the formula,
     citation, formatting, color and finance sections; dropped the tooling,
     dependency and output-folder sections (the xlsx skill covers those);
     tied the error rule to xlsx_recalc.py; gave the dynamic-array rule its
     reason. -->

These apply whenever you write formulas or style a workbook. The user's or project's own conventions win over them.

## Formulas

- Use formulas for derived values rather than hardcoding results.
- Don't use dynamic array functions such as `FILTER`, `XLOOKUP`, `SORT` or `SEQUENCE`: older Excel versions and some viewers can't evaluate them, and openpyxl writes them without the `_xlfn.` prefixes and array metadata Excel expects, so they often open as `#NAME?`.
- Keep formulas simple and legible; use helper cells for complex logic.
- Avoid volatile functions like `INDIRECT` and `OFFSET` unless required.
- Prefer cell references over magic numbers (for example, `=H6*(1+$B$3)` instead of `=H6*1.04`).
- Use absolute (`$B$4`) or relative (`B4`) references carefully so copied formulas behave correctly.
- If you need literal text that starts with `=`, prefix it with a single quote.
- Guard against `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A` and `#NAME?` errors. `scripts/xlsx_recalc.py` recalculates and lists every error cell; fix them all before delivering.
- Check for off-by-one mistakes, circular references and incorrect ranges.

## Citations

- Cite sources inside the spreadsheet using plain-text URLs.
- For financial models, cite model inputs in cell comments.
- For tabular data sourced externally, add a source column when each row represents a separate item.

## Existing formatted spreadsheets

- Render and inspect a provided spreadsheet before modifying it when possible (`soffice --headless --convert-to pdf`, then `pdftoppm -png`, then `read` the PNGs).
- Preserve existing formatting and style exactly.
- Match styles for any newly filled cells that were previously blank.
- Never overwrite established formatting unless the user explicitly asks for a redesign.

## New or unstyled spreadsheets

- Use appropriate number and date formats. Dates should render as dates, not plain numbers.
- Percentages should usually default to one decimal place unless the data calls for something else.
- Currencies should use the appropriate currency format.
- Headers should be visually distinct from raw inputs and derived cells.
- Use fill colors, borders, spacing and merged cells sparingly and intentionally.
- Set row heights and column widths so content is readable without excessive whitespace.
- Don't apply borders around every filled cell.
- Group related calculations and make totals simple sums of the cells above them.
- Add whitespace to separate sections.
- Make sure text doesn't spill into adjacent cells.
- Avoid unsupported spreadsheet data-table features such as `=TABLE`.

## Color conventions (when there is no style guidance)

- Blue: user input
- Black: formulas and derived values
- Green: linked or imported values
- Gray: static constants
- Orange: review or caution
- Light red: error or flag
- Purple: control or logic
- Teal: visualization anchors and KPI highlights

## Finance

- Format zeros as `-`.
- Negative numbers should be red and in parentheses.
- Format multiples as `5.2x`.
- Always specify units in headers (for example, `Revenue ($mm)`).
- Cite sources for all raw inputs in cell comments.
- For new financial models with no user-specified style, use blue text for hardcoded inputs, black for formulas, green for internal workbook links, red for external links, and yellow fill for key assumptions that need attention.

### Investment banking layouts

For an IB-style model (LBO, DCF, 3-statement, valuation):

- Totals should sum the range directly above.
- Hide gridlines and use horizontal borders above totals across relevant columns.
- Section headers should be merged cells with dark fill and white text.
- Column labels for numeric data should be right-aligned; row labels should be left-aligned.
- Indent submetrics under their parent line items.
