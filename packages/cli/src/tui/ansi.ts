export const ESC = "\x1b"
export const CSI = `${ESC}[`

export const cursor = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  home: `${CSI}H`,
  to: (row: number, col: number) => `${CSI}${row};${col}H`,
  up: (n = 1) => `${CSI}${n}A`,
  savePos: `${ESC}7`,
  restorePos: `${ESC}8`,
}

export const screen = {
  clear: `${CSI}2J${CSI}H`,
  clearLine: `${CSI}2K`,
  alternateOn: `${CSI}?1049h`,
  alternateOff: `${CSI}?1049l`,
}

export const style = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  fg: (n: number) => `${CSI}38;5;${n}m`,
  bg: (n: number) => `${CSI}48;5;${n}m`,
  fgRgb: (r: number, g: number, b: number) => `${CSI}38;2;${r};${g};${b}m`,
  bgRgb: (r: number, g: number, b: number) => `${CSI}48;2;${r};${g};${b}m`,
}

export const colors = {
  black: 0, white: 15, gray: 245, darkGray: 238, lightGray: 250,
  blue: 33, cyan: 51, green: 82, yellow: 226, orange: 208,
  red: 196, magenta: 201, purple: 99, mutedYellow: 185,
}

// ---------------------------------------------------------------------------
// Accenture brand theme -- #A100FF purple, near-black bg, clean white text
// Pre-built ANSI strings so components just write T.purple + text + T.reset
// ---------------------------------------------------------------------------
export const T = {
  // foreground
  purple:      `${CSI}38;2;161;0;255m`,    // #A100FF -- Accenture signature
  purpleDim:   `${CSI}38;2;110;0;175m`,    // darker variant for decorations
  purpleMuted: `${CSI}38;2;90;0;140m`,     // very muted, borders/dividers
  white:       `${CSI}38;2;240;240;240m`,  // primary text
  muted:       `${CSI}38;2;140;140;140m`,  // secondary text
  dim:         `${CSI}38;2;70;70;70m`,     // dimmed text / hints
  green:       `${CSI}38;2;0;230;120m`,    // success / running
  red:         `${CSI}38;2;255;60;60m`,    // error
  orange:      `${CSI}38;2;255;160;0m`,    // inline code
  teal:        `${CSI}38;2;0;200;210m`,    // user label
  // backgrounds
  panelBg:     `${CSI}48;2;10;10;10m`,     // status bar / panels
  codeBg:      `${CSI}48;2;20;20;20m`,     // code block bg
  codeHeaderBg:`${CSI}48;2;35;0;55m`,      // code language header (purple tint)
  cursorBg:    `${CSI}48;2;161;0;255m`,    // input cursor
  // resets
  reset: `${CSI}0m`,
  bold:  `${CSI}1m`,
  italic:`${CSI}3m`,
  faint: `${CSI}2m`,
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mGKHABCDJf]/g, "").replace(/\x1b[78]/g, "")
}

// Regex to detect zero-width characters (control, format, marks, surrogates)
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v
// Regex to detect RGI emoji sequences (handles ZWJ, skin tones, VS16, etc.)
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v
// Grapheme segmenter for accurate character counting
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function visibleWidth(s: string): number {
  const clean = stripAnsi(s)
  if (!clean) return 0
  let w = 0
  for (const { segment } of graphemeSegmenter.segment(clean)) {
    const cp = segment.codePointAt(0) ?? 0
    // Zero-width characters
    if (zeroWidthRegex.test(segment)) continue
    // RGI emoji (single or sequence) — always width 2
    if (rgiEmojiRegex.test(segment)) { w += 2; continue }
    // CJK wide characters
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) ||  // CJK Radicals / Kangxi
      (cp >= 0x3040 && cp <= 0xa4cf) ||  // CJK, Hiragana, Katakana, etc.
      (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe1f) ||  // Vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) ||  // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) ||  // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||  // Fullwidth Signs
      (cp >= 0x1f300 && cp <= 0x1f9ff) || // Misc symbols & pictographs
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Unified Ideographs Extension B+
      (cp >= 0x30000 && cp <= 0x3fffd)    // CJK Unified Ideographs Extension G+
    ) {
      w += 2; continue
    }
    w += 1
  }
  return w
}

export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (visibleWidth(s) <= max) return s
  const ew = visibleWidth(ellipsis)
  let w = 0; let out = ""
  for (const c of stripAnsi(s)) {
    const cw = 1
    if (w + cw > max - ew) break
    out += c; w += cw
  }
  return out + ellipsis
}

export function padEnd(s: string, width: number): string {
  const w = visibleWidth(s)
  return w >= width ? s : s + " ".repeat(width - w)
}

export function wordWrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const para of text.split("\n")) {
    if (!para) { lines.push(""); continue }
    let current = ""; let cw = 0
    for (const word of para.split(" ")) {
      const ww = visibleWidth(word)
      if (cw + (cw > 0 ? 1 : 0) + ww > width) {
        if (current) lines.push(current)
        current = word; cw = ww
      } else {
        if (cw > 0) { current += " "; cw++ }
        current += word; cw += ww
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Markdown → ANSI renderer (Accenture theme)
// ---------------------------------------------------------------------------
export function renderMarkdown(text: string, width: number): string[] {
  const out: string[] = []
  const rawLines = text.split("\n")
  let i = 0

  while (i < rawLines.length) {
    const raw = rawLines[i]!

    // --- fenced code block ---
    if (raw.trimStart().startsWith("```")) {
      const lang = raw.replace(/^`+/, "").trim()
      i++
      const codeLines: string[] = []
      while (i < rawLines.length && !rawLines[i]!.trimStart().startsWith("```")) {
        codeLines.push(rawLines[i]!)
        i++
      }
      i++
      const langLabel = lang ? ` ${lang} ` : " code "
      const headerPad = " ".repeat(Math.max(0, width - 2 - visibleWidth(langLabel)))
      out.push(`${T.codeHeaderBg}${T.purple}${T.bold}${langLabel}${T.reset}${T.codeHeaderBg}${headerPad}${T.reset}`)
      for (const cl of codeLines) {
        const padded = cl + " ".repeat(Math.max(0, width - 2 - visibleWidth(cl)))
        out.push(`${T.codeBg}${T.white} ${padded} ${T.reset}`)
      }
      out.push(`${T.codeHeaderBg}${" ".repeat(width)}${T.reset}`)
      out.push("")
      continue
    }

    // --- heading ---
    const hMatch = raw.match(/^(#{1,6})\s+(.+)$/)
    if (hMatch) {
      const level = hMatch[1]!.length
      const content = inlineMarkdown(hMatch[2]!)
      if (level === 1) {
        out.push(`${T.bold}${T.purple}${content}${T.reset}`)
        out.push(`${T.purpleDim}${"─".repeat(Math.min(visibleWidth(stripAnsi(content)), width - 2))}${T.reset}`)
      } else if (level === 2) {
        out.push(`${T.bold}${T.purpleMuted}▸ ${T.reset}${T.bold}${T.white}${content}${T.reset}`)
      } else {
        out.push(`${T.bold}${T.muted}${content}${T.reset}`)
      }
      i++; continue
    }

    // --- horizontal rule ---
    if (/^[-*_]{3,}\s*$/.test(raw)) {
      out.push(`${T.purpleMuted}${"─".repeat(width - 2)}${T.reset}`)
      i++; continue
    }

    // --- blockquote ---
    if (raw.startsWith(">")) {
      const content = raw.replace(/^>\s?/, "")
      for (const l of wordWrap(inlineMarkdown(content), width - 4)) {
        out.push(`${T.purpleDim}▌${T.reset} ${T.muted}${l}${T.reset}`)
      }
      i++; continue
    }

    // --- bullet list ---
    const bulletMatch = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/)
    if (bulletMatch) {
      const indent = bulletMatch[1]!.length
      const isOrdered = /^\d+\./.test(bulletMatch[2]!)
      const marker = isOrdered ? bulletMatch[2]! : "◆"
      const content = inlineMarkdown(bulletMatch[3]!)
      const prefix = " ".repeat(indent) + `${T.purple}${marker}${T.reset} `
      const prefixW = indent + visibleWidth(marker) + 1
      const wrapped = wordWrap(content, width - prefixW - 2)
      for (let li = 0; li < wrapped.length; li++) {
        out.push(li === 0 ? `${prefix}${wrapped[li]}` : `${" ".repeat(prefixW + 1)}${wrapped[li]}`)
      }
      i++; continue
    }

    // --- table ---
    if (raw.trimStart().startsWith("|") && raw.trimEnd().endsWith("|")) {
      // Collect all consecutive table lines
      const tableLines: string[] = []
      while (i < rawLines.length && rawLines[i]!.trimStart().startsWith("|") && rawLines[i]!.trimEnd().endsWith("|")) {
        tableLines.push(rawLines[i]!)
        i++
      }
      out.push(...renderTable(tableLines, width))
      out.push("")
      continue
    }

    // --- empty line ---
    if (!raw.trim()) { out.push(""); i++; continue }

    // --- paragraph ---
    for (const l of wordWrap(inlineMarkdown(raw), width - 2)) {
      out.push(`${T.white}${l}${T.reset}`)
    }
    i++
  }

  return out
}

function parseTableRow(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim())
}

function renderTable(lines: string[], width: number): string[] {
  if (lines.length === 0) return []

  // Parse rows, skip separator row (--- lines)
  const rows: string[][] = []
  let headerRow: string[] | undefined
  for (const line of lines) {
    const cells = parseTableRow(line)
    if (cells.every((c) => /^[-: ]+$/.test(c))) {
      // This is the separator row — mark end of header
      continue
    }
    if (!headerRow) { headerRow = cells; rows.push(cells) }
    else rows.push(cells)
  }
  if (rows.length === 0) return []

  const colCount = rows[0]!.length
  // Compute max visible width per column
  const colWidths: number[] = Array(colCount).fill(0)
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = inlineMarkdown(row[c] ?? "")
      colWidths[c] = Math.max(colWidths[c]!, visibleWidth(stripAnsi(cell)) + 2)
    }
  }

  // Clamp total to available width
  const totalCols = width - 2
  const totalNatural = colWidths.reduce((a, b) => a + b, 0) + colCount + 1
  if (totalNatural > totalCols) {
    const scale = totalCols / totalNatural
    for (let c = 0; c < colCount; c++) colWidths[c] = Math.max(4, Math.floor(colWidths[c]! * scale))
  }

  const out: string[] = []
  const divider = `${T.purpleMuted}├${ colWidths.map((w) => "─".repeat(w)).join("┼") }┤${T.reset}`
  const topBorder = `${T.purpleMuted}┌${ colWidths.map((w) => "─".repeat(w)).join("┬") }┐${T.reset}`
  const botBorder = `${T.purpleMuted}└${ colWidths.map((w) => "─".repeat(w)).join("┴") }┘${T.reset}`

  out.push(topBorder)
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!
    let line = `${T.purpleMuted}│${T.reset}`
    for (let c = 0; c < colCount; c++) {
      const raw = row[c] ?? ""
      const rendered = inlineMarkdown(raw)
      const vw = visibleWidth(stripAnsi(rendered))
      const pad = Math.max(0, (colWidths[c]! - 2) - vw)
      const cellStyle = r === 0 ? `${T.bold}${T.white}` : T.white
      line += ` ${cellStyle}${rendered}${T.reset}${" ".repeat(pad)} ${T.purpleMuted}│${T.reset}`
    }
    out.push(line)
    if (r === 0 && rows.length > 1) out.push(divider)
  }
  out.push(botBorder)
  return out
}

// Inline markdown: **bold**, *italic*, `code`, ~~strike~~
function inlineMarkdown(s: string): string {
  return s
    .replace(/\*\*\*(.+?)\*\*\*/g, `${T.bold}${T.italic}${T.purple}$1${T.reset}`)
    .replace(/\*\*(.+?)\*\*/g, `${T.bold}${T.white}$1${T.reset}`)
    .replace(/__(.+?)__/g, `${T.bold}${T.white}$1${T.reset}`)
    .replace(/\*(.+?)\*/g, `${T.italic}$1${T.reset}`)
    .replace(/_(.+?)_/g, `${T.italic}$1${T.reset}`)
    .replace(/~~(.+?)~~/g, `${T.faint}$1${T.reset}`)
    .replace(/`([^`]+)`/g, `${T.orange}${T.codeBg} $1 ${T.reset}`)
}
