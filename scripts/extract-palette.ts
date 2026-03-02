#!/usr/bin/env bun
/**
 * extract-palette.ts
 *
 * Extracts a unified color palette from the Ignition brand reference images
 * and generates CSS custom properties, Tailwind theme tokens, TypeScript
 * constants, a Shiki syntax theme, and dashboard CSS variables.
 *
 * Integrates WCAG contrast validation from extract-color-theme.py to ensure
 * all syntax and text colors meet accessibility minimums.
 *
 * Source images (images/):
 *   - Retro futuristic cityscape (teal sky, vermillion towers, cream facades)
 *   - Australian landscape (golden grass, sage mountain, teal lake)
 *   - Mountain valley (amber hills, stream teal, rust accents)
 *   - Terminal operator (teal CRT screens, rust walls, ivory equipment)
 *   - Retro computer (teal casing, red furniture, cream surfaces)
 *
 * Usage:
 *   bun run scripts/extract-palette.ts           # Generate all theme files
 *   bun run scripts/extract-palette.ts --preview  # Print palette to terminal
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Color math (ported from extract-color-theme.py)
// ---------------------------------------------------------------------------

type RGB = [number, number, number]

function hexToRgb(hex: string): RGB {
  const clean = hex.replace("#", "")
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ]
}

function rgbToHex([r, g, b]: RGB): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return [h * 360, s, l]
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
  s = clamp01(s)
  l = clamp01(l)
  const hn = (((h % 360) + 360) % 360) / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  ]
}

/** WCAG 2.1 relative luminance */
function relativeLuminance([r, g, b]: RGB): number {
  const channel = (c: number) => {
    const n = c / 255
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two colors (1–21) */
function contrastRatio(a: RGB, b: RGB): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const high = Math.max(l1, l2)
  const low = Math.min(l1, l2)
  return (high + 0.05) / (low + 0.05)
}

/** Nudge a color's lightness until it meets the target contrast ratio */
function ensureContrast(fg: RGB, bg: RGB, target: number): RGB {
  if (contrastRatio(fg, bg) >= target) return fg
  let [h, s, l] = rgbToHsl(fg)
  const bgL = rgbToHsl(bg)[2]
  const lighter = bgL < 0.5
  for (let i = 0; i < 40; i++) {
    l += lighter ? 0.02 : -0.02
    const candidate = hslToRgb(h, s, l)
    if (contrastRatio(candidate, bg) >= target) return candidate
  }
  return hslToRgb(h, s, l)
}

function mix(a: RGB, b: RGB, t: number): RGB {
  const r = 1 - t
  return [
    Math.round(a[0] * r + b[0] * t),
    Math.round(a[1] * r + b[1] * t),
    Math.round(a[2] * r + b[2] * t),
  ]
}

// ---------------------------------------------------------------------------
// Extracted palette — hand-sampled from reference images
// ---------------------------------------------------------------------------

interface ColorSwatch {
  hex: string
  name: string
  role: string
  source: string
}

const swatches: ColorSwatch[] = [
  // Sky / Atmosphere
  { hex: "#6BA89A", name: "sky-teal", role: "primary-bg", source: "upper sky across all images" },
  { hex: "#8CBFB0", name: "sky-sage", role: "primary-bg-alt", source: "mid-sky, horizon haze" },
  { hex: "#A8D4C6", name: "sky-pale", role: "surface-light", source: "brightest sky near horizon" },
  // Warm Earth
  { hex: "#C8A050", name: "amber", role: "accent-warm", source: "golden grass, hillside" },
  { hex: "#D4B868", name: "wheat", role: "accent-gold", source: "light wheat grass, highlights" },
  { hex: "#B88A3A", name: "ochre", role: "accent-deep", source: "deep grass, shadow side" },
  // Vermillion / Rust
  { hex: "#C44D2B", name: "vermillion", role: "brand", source: "building accents, red structures" },
  { hex: "#D4603A", name: "sienna", role: "brand-light", source: "lighter red accents, warm glow" },
  { hex: "#A43820", name: "rust", role: "brand-dark", source: "deep rust shadows, dark accents" },
  // Cream / Neutrals
  { hex: "#F0E4D0", name: "ivory", role: "fg-lightest", source: "clouds, brightest surfaces" },
  { hex: "#E8DCCA", name: "cream", role: "fg-light", source: "building facades, clouds" },
  { hex: "#D0C4AE", name: "sand", role: "fg-muted", source: "weathered surfaces, muted areas" },
  // Sage / Mountain Green
  { hex: "#8AAA90", name: "sage", role: "secondary", source: "mountains, distant hills" },
  {
    hex: "#7A9A80",
    name: "sage-mid",
    role: "secondary-mid",
    source: "mountain mid-tones, foliage",
  },
  {
    hex: "#6A8A70",
    name: "sage-deep",
    role: "secondary-deep",
    source: "closer vegetation, shadows",
  },
  // Dark / Shadow
  { hex: "#1E2A28", name: "void", role: "bg-darkest", source: "deepest shadows" },
  { hex: "#2A3A38", name: "deep-teal", role: "bg-dark", source: "dark background, night teal" },
  { hex: "#3A4A40", name: "dark-olive", role: "bg-mid", source: "tree canopy, dark vegetation" },
  { hex: "#4A5A48", name: "olive", role: "bg-elevated", source: "mid-dark vegetation, panels" },
  // Water / Cool
  { hex: "#5AAFA0", name: "teal", role: "interactive", source: "CRT screens, water surface" },
  {
    hex: "#4A9A8A",
    name: "teal-deep",
    role: "interactive-alt",
    source: "deeper water, screen glow",
  },
]

// ---------------------------------------------------------------------------
// Contrast-validated semantic tokens
// ---------------------------------------------------------------------------

// Backgrounds for validation
const canvasBg: RGB = hexToRgb("#1E2A28")
const syntaxBg: RGB = hexToRgb("#1E2A28")
const lightBg: RGB = hexToRgb("#F8F2E8")

// Validate all foreground syntax colors against the dark syntax background.
// WCAG AA for normal text = 4.5:1, AA for large text = 3:1.
// We use 3.0 minimum (large text / UI elements) since code blocks use ≥14px mono.
const SYNTAX_MIN_CONTRAST = 3.0
const TEXT_MIN_CONTRAST = 4.5

function validated(hex: string, bg: RGB, min: number): string {
  const rgb = hexToRgb(hex)
  const adjusted = ensureContrast(rgb, bg, min)
  return rgbToHex(adjusted)
}

// Build syntax colors with contrast enforcement
const syntaxColors = {
  keyword: validated("#C44D2B", syntaxBg, SYNTAX_MIN_CONTRAST),
  string: validated("#D4B868", syntaxBg, SYNTAX_MIN_CONTRAST),
  function: validated("#5AAFA0", syntaxBg, SYNTAX_MIN_CONTRAST),
  comment: validated("#6A8A70", syntaxBg, SYNTAX_MIN_CONTRAST),
  type: validated("#C8A050", syntaxBg, SYNTAX_MIN_CONTRAST),
  variable: validated("#E8DCCA", syntaxBg, TEXT_MIN_CONTRAST),
  literal: validated("#D4603A", syntaxBg, SYNTAX_MIN_CONTRAST),
  operator: validated("#8AAA90", syntaxBg, SYNTAX_MIN_CONTRAST),
  property: validated("#8CBFB0", syntaxBg, SYNTAX_MIN_CONTRAST),
  tag: validated("#D4603A", syntaxBg, SYNTAX_MIN_CONTRAST),
  attribute: validated("#D0C4AE", syntaxBg, SYNTAX_MIN_CONTRAST),
  regexp: validated("#6BA89A", syntaxBg, SYNTAX_MIN_CONTRAST),
  punctuation: validated("#7A9A80", syntaxBg, SYNTAX_MIN_CONTRAST),
  constant: validated("#D4B868", syntaxBg, SYNTAX_MIN_CONTRAST),
  number: validated("#D4603A", syntaxBg, SYNTAX_MIN_CONTRAST),
}

// Derive additional editor chrome colors
const selectionBg = rgbToHex(mix(syntaxBg, hexToRgb("#5AAFA0"), 0.2))
const lineHighlightBg = rgbToHex(mix(syntaxBg, hexToRgb("#5AAFA0"), 0.08))
const findMatchBg = rgbToHex(mix(syntaxBg, hexToRgb("#C44D2B"), 0.26))
const wordHighlightBg = rgbToHex(mix(syntaxBg, hexToRgb("#5AAFA0"), 0.14))

interface SemanticTokens {
  [category: string]: { [token: string]: string }
}

const semantic: SemanticTokens = {
  surface: {
    bg: "#1E2A28",
    "bg-elevated": "#2A3A38",
    "bg-card": "#2A3A38",
    "bg-card-hover": "#3A4A40",
    "bg-overlay": "rgba(30, 42, 40, 0.85)",
    "bg-input": "#1E2A28",
    border: "#3A4A40",
    "border-subtle": "rgba(138, 170, 144, 0.15)",
  },
  text: {
    primary: validated("#F0E4D0", canvasBg, 7.0),
    secondary: validated("#D0C4AE", canvasBg, TEXT_MIN_CONTRAST),
    muted: validated("#8AAA90", canvasBg, 3.0),
    dim: validated("#6A8A70", canvasBg, 3.0),
    inverse: "#1E2A28",
  },
  brand: {
    DEFAULT: "#C44D2B",
    light: "#D4603A",
    dark: "#A43820",
    foreground: "#F0E4D0",
    glow: "rgba(196, 77, 43, 0.20)",
  },
  accent: {
    warm: "#C8A050",
    gold: "#D4B868",
    teal: "#5AAFA0",
    sage: "#8AAA90",
    sky: "#8CBFB0",
  },
  status: {
    ok: validated("#5AAF78", canvasBg, SYNTAX_MIN_CONTRAST),
    changed: validated("#D4B868", canvasBg, SYNTAX_MIN_CONTRAST),
    failed: validated("#C44D2B", canvasBg, SYNTAX_MIN_CONTRAST),
    running: validated("#5AAFA0", canvasBg, SYNTAX_MIN_CONTRAST),
    pending: validated("#6A8A70", canvasBg, SYNTAX_MIN_CONTRAST),
  },
  syntax: {
    ...syntaxColors,
    background: "#1E2A28",
    foreground: validated("#E8DCCA", syntaxBg, 7.0),
    selection: selectionBg,
    cursor: "#C44D2B",
    "line-highlight": lineHighlightBg,
  },
}

const lightOverrides: SemanticTokens = {
  surface: {
    bg: "#F0E4D0",
    "bg-elevated": "#FFFFFF",
    "bg-card": "#FFFFFF",
    "bg-card-hover": "#E8DCCA",
    "bg-overlay": "rgba(240, 228, 208, 0.90)",
    "bg-input": "#FFFFFF",
    border: "#D0C4AE",
    "border-subtle": "rgba(106, 138, 112, 0.20)",
  },
  text: {
    primary: validated("#1E2A28", lightBg, 7.0),
    secondary: validated("#3A4A40", lightBg, TEXT_MIN_CONTRAST),
    muted: validated("#6A8A70", lightBg, 3.0),
    dim: validated("#8AAA90", lightBg, 3.0),
    inverse: "#F0E4D0",
  },
  syntax: {
    background: "#F8F2E8",
    foreground: validated("#2A3A38", lightBg, 7.0),
    keyword: validated("#A43820", lightBg, TEXT_MIN_CONTRAST),
    string: validated("#6A7A30", lightBg, TEXT_MIN_CONTRAST),
    function: validated("#2A7A6E", lightBg, TEXT_MIN_CONTRAST),
    comment: validated("#7A9A80", lightBg, 3.0),
    type: validated("#9A7A30", lightBg, TEXT_MIN_CONTRAST),
    variable: validated("#2A3A38", lightBg, TEXT_MIN_CONTRAST),
    literal: validated("#B84A2A", lightBg, TEXT_MIN_CONTRAST),
    operator: validated("#5A7A60", lightBg, TEXT_MIN_CONTRAST),
    property: validated("#4A7A6A", lightBg, TEXT_MIN_CONTRAST),
    tag: validated("#A43820", lightBg, TEXT_MIN_CONTRAST),
    attribute: validated("#6A6A50", lightBg, TEXT_MIN_CONTRAST),
    regexp: validated("#4A8A7A", lightBg, TEXT_MIN_CONTRAST),
    punctuation: validated("#5A7A60", lightBg, TEXT_MIN_CONTRAST),
    constant: validated("#9A7A30", lightBg, TEXT_MIN_CONTRAST),
    number: validated("#B84A2A", lightBg, TEXT_MIN_CONTRAST),
    selection: rgbToHex(mix(lightBg, hexToRgb("#5AAFA0"), 0.15)),
    "line-highlight": rgbToHex(mix(lightBg, hexToRgb("#5AAFA0"), 0.06)),
  },
}

// ---------------------------------------------------------------------------
// Shiki theme generator (VS Code TextMate format)
// ---------------------------------------------------------------------------

interface ShikiTokenColor {
  name?: string
  scope: string | string[]
  settings: { foreground?: string; fontStyle?: string }
}

interface ShikiTheme {
  $schema?: string
  name: string
  displayName?: string
  type: "dark" | "light"
  semanticHighlighting?: boolean
  colors: Record<string, string>
  tokenColors: ShikiTokenColor[]
}

function buildShikiTheme(
  name: string,
  type: "dark" | "light",
  s: SemanticTokens["syntax"],
  statusOk: string,
  statusFailed: string,
  accentTeal: string,
  textDim: string,
  borderColor: string,
): ShikiTheme {
  return {
    $schema: "vscode://schemas/color-theme",
    name,
    displayName: name === "ignition-dark" ? "Ignition Dark" : "Ignition Light",
    type,
    semanticHighlighting: true,
    colors: {
      // Editor chrome
      "editor.background": s.background,
      "editor.foreground": s.foreground,
      "editor.selectionBackground": s.selection,
      "editor.lineHighlightBackground": s["line-highlight"],
      "editorCursor.foreground": s.cursor ?? accentTeal,
      "editorLineNumber.foreground": s.comment,
      "editorLineNumber.activeForeground": s.punctuation,
      "editorWhitespace.foreground": borderColor,
      "editorIndentGuide.background": borderColor,
      "editorIndentGuide.activeBackground": textDim,
      // Bracket matching
      "editorBracketMatch.background": s.selection,
      "editorBracketMatch.border": accentTeal,
      // Find / highlight
      "editor.findMatchBackground": findMatchBg,
      "editor.findMatchHighlightBackground": wordHighlightBg,
      "editor.wordHighlightBackground": wordHighlightBg,
      // Diff
      "diffEditor.insertedTextBackground": `${statusOk}20`,
      "diffEditor.removedTextBackground": `${statusFailed}20`,
      // Terminal ANSI
      "terminal.ansiBlack": s.background,
      "terminal.ansiRed": statusFailed,
      "terminal.ansiGreen": statusOk,
      "terminal.ansiYellow": s.string,
      "terminal.ansiBlue": accentTeal,
      "terminal.ansiMagenta": s.keyword,
      "terminal.ansiCyan": s.function,
      "terminal.ansiWhite": s.foreground,
      "terminal.ansiBrightBlack": s.comment,
      "terminal.ansiBrightRed": s.literal,
      "terminal.ansiBrightGreen": s.string,
      "terminal.ansiBrightYellow": s.constant,
      "terminal.ansiBrightBlue": s.property,
      "terminal.ansiBrightMagenta": s.tag,
      "terminal.ansiBrightCyan": s.type,
      "terminal.ansiBrightWhite": "#F0E4D0",
    },
    tokenColors: [
      {
        name: "Comment",
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: s.comment, fontStyle: "italic" },
      },
      {
        name: "Keyword",
        scope: ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"],
        settings: { foreground: s.keyword },
      },
      {
        name: "String",
        scope: ["string", "string.quoted", "string.template"],
        settings: { foreground: s.string },
      },
      {
        name: "Number",
        scope: ["constant.numeric"],
        settings: { foreground: s.number },
      },
      {
        name: "Constant",
        scope: ["constant", "constant.language", "constant.character", "support.constant"],
        settings: { foreground: s.constant },
      },
      {
        name: "Function declaration",
        scope: ["entity.name.function", "support.function", "meta.function-call"],
        settings: { foreground: s.function },
      },
      {
        name: "Type",
        scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
        settings: { foreground: s.type },
      },
      {
        name: "Variable",
        scope: ["variable", "variable.other", "variable.language"],
        settings: { foreground: s.variable },
      },
      {
        name: "Literal / Boolean",
        scope: ["constant.language.boolean"],
        settings: { foreground: s.literal },
      },
      {
        name: "Operator",
        scope: ["keyword.operator", "keyword.operator.assignment"],
        settings: { foreground: s.operator },
      },
      {
        name: "Property",
        scope: [
          "variable.other.property",
          "variable.other.object.property",
          "meta.object-literal.key",
          "support.type.property-name",
        ],
        settings: { foreground: s.property },
      },
      {
        name: "Tag (HTML/JSX)",
        scope: ["entity.name.tag", "punctuation.definition.tag", "support.class.component"],
        settings: { foreground: s.tag },
      },
      {
        name: "Attribute",
        scope: ["entity.other.attribute-name"],
        settings: { foreground: s.attribute },
      },
      {
        name: "Regex",
        scope: ["string.regexp"],
        settings: { foreground: s.regexp },
      },
      {
        name: "Punctuation",
        scope: ["punctuation", "punctuation.separator", "punctuation.terminator", "meta.brace"],
        settings: { foreground: s.punctuation },
      },
      {
        name: "Escape character",
        scope: ["constant.character.escape"],
        settings: { foreground: s.regexp },
      },
      // Language-specific refinements
      {
        name: "TypeScript/JS import",
        scope: ["keyword.control.import", "keyword.control.export", "keyword.control.from"],
        settings: { foreground: s.keyword },
      },
      {
        name: "TypeScript generic",
        scope: ["punctuation.definition.typeparameters"],
        settings: { foreground: s.type },
      },
      {
        name: "Decorator",
        scope: ["meta.decorator", "punctuation.decorator"],
        settings: { foreground: s.tag },
      },
      {
        name: "JSON key",
        scope: ["support.type.property-name.json"],
        settings: { foreground: s.property },
      },
      {
        name: "Markdown heading",
        scope: ["markup.heading", "entity.name.section"],
        settings: { foreground: s.keyword, fontStyle: "bold" },
      },
      {
        name: "Markdown bold",
        scope: ["markup.bold"],
        settings: { fontStyle: "bold" },
      },
      {
        name: "Markdown italic",
        scope: ["markup.italic"],
        settings: { fontStyle: "italic" },
      },
      {
        name: "Markdown link",
        scope: ["markup.underline.link", "string.other.link"],
        settings: { foreground: s.function },
      },
      {
        name: "Markdown code",
        scope: ["markup.inline.raw", "markup.fenced_code.block"],
        settings: { foreground: s.string },
      },
      {
        name: "Diff inserted",
        scope: ["markup.inserted"],
        settings: { foreground: statusOk },
      },
      {
        name: "Diff deleted",
        scope: ["markup.deleted"],
        settings: { foreground: statusFailed },
      },
      {
        name: "Diff changed",
        scope: ["markup.changed"],
        settings: { foreground: s.constant },
      },
      // Shell / Bash
      {
        name: "Shell variable",
        scope: ["variable.other.normal.shell", "punctuation.definition.variable.shell"],
        settings: { foreground: s.property },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Generator functions
// ---------------------------------------------------------------------------

function generateCSS(): string {
  const lines: string[] = [
    "/**",
    " * Ignition Design Tokens",
    " * Extracted from brand reference images (retro-futuristic palette)",
    " * All syntax/text colors validated against WCAG contrast minimums.",
    " *",
    " * Generated by: bun run scripts/extract-palette.ts",
    " * Do not edit manually — re-run the script to regenerate.",
    " */",
    "",
  ]

  lines.push("/* === Raw Palette Swatches === */")
  lines.push(":root {")
  for (const s of swatches) {
    lines.push(`  --palette-${s.name}: ${s.hex};`)
  }
  lines.push("}")
  lines.push("")

  lines.push("/* === Dark Mode (default) === */")
  lines.push(":root {")
  for (const [category, tokens] of Object.entries(semantic)) {
    lines.push(`  /* ${category} */`)
    for (const [name, value] of Object.entries(tokens)) {
      const prop = name === "DEFAULT" ? `--${category}` : `--${category}-${name}`
      lines.push(`  ${prop}: ${value};`)
    }
    lines.push("")
  }
  lines.push("}")
  lines.push("")

  lines.push("/* === Light Mode === */")
  lines.push("[data-theme='light'], .light {")
  for (const [category, tokens] of Object.entries(lightOverrides)) {
    for (const [name, value] of Object.entries(tokens)) {
      const prop = name === "DEFAULT" ? `--${category}` : `--${category}-${name}`
      lines.push(`  ${prop}: ${value};`)
    }
  }
  lines.push("}")
  lines.push("")

  lines.push("@media (prefers-color-scheme: light) {")
  lines.push("  :root:not([data-theme='dark']) {")
  for (const [category, tokens] of Object.entries(lightOverrides)) {
    for (const [name, value] of Object.entries(tokens)) {
      const prop = name === "DEFAULT" ? `--${category}` : `--${category}-${name}`
      lines.push(`    ${prop}: ${value};`)
    }
  }
  lines.push("  }")
  lines.push("}")

  return lines.join("\n")
}

function generateTailwindTokens(): string {
  const lines: string[] = [
    "/**",
    " * Ignition Tailwind Theme Tokens",
    " * For use in @theme blocks (Tailwind CSS v4)",
    " *",
    " * Generated by: bun run scripts/extract-palette.ts",
    " */",
    "",
    "@theme {",
  ]

  for (const s of swatches) {
    lines.push(`  --color-palette-${s.name}: ${s.hex};`)
  }
  lines.push("")

  lines.push("  /* Brand */")
  lines.push(`  --color-brand: ${semantic.brand.DEFAULT};`)
  lines.push(`  --color-brand-light: ${semantic.brand.light};`)
  lines.push(`  --color-brand-dark: ${semantic.brand.dark};`)
  lines.push(`  --color-brand-foreground: ${semantic.brand.foreground};`)
  lines.push("")

  lines.push("  /* Accent */")
  for (const [name, value] of Object.entries(semantic.accent)) {
    lines.push(`  --color-accent-${name}: ${value};`)
  }
  lines.push("")

  lines.push("  /* Status */")
  for (const [name, value] of Object.entries(semantic.status)) {
    lines.push(`  --color-status-${name}: ${value};`)
  }
  lines.push("")

  lines.push("  /* Surface (reference CSS vars) */")
  lines.push("  --color-surface-dark: var(--surface-bg);")
  lines.push("  --color-surface-cream: var(--text-primary);")
  lines.push("")

  lines.push("  /* Terminal / Code */")
  lines.push(`  --color-terminal-bg: ${semantic.syntax.background};`)
  lines.push(`  --color-terminal-fg: ${semantic.syntax.foreground};`)
  lines.push(`  --color-terminal-green: ${semantic.status.ok};`)
  lines.push(`  --color-terminal-yellow: ${semantic.accent.gold};`)
  lines.push(`  --color-terminal-blue: ${semantic.accent.teal};`)
  lines.push(`  --color-terminal-dim: ${semantic.text.dim};`)
  lines.push(`  --color-terminal-tilde: ${semantic.syntax.type};`)

  lines.push("}")
  return lines.join("\n")
}

function generateTypeScript(): string {
  const lines: string[] = [
    "/**",
    " * Ignition Palette — TypeScript Constants",
    " * Extracted from brand reference images (retro-futuristic palette)",
    " * Syntax colors are WCAG contrast-validated.",
    " *",
    " * Generated by: bun run scripts/extract-palette.ts",
    " * Do not edit manually.",
    " */",
    "",
    "export const palette = {",
  ]

  for (const s of swatches) {
    const camel = s.name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    lines.push(`  /** ${s.role} — ${s.source} */`)
    lines.push(`  ${camel}: "${s.hex}",`)
  }
  lines.push("} as const;")
  lines.push("")

  lines.push("export const tokens = {")
  for (const [category, toks] of Object.entries(semantic)) {
    lines.push(`  ${category}: {`)
    for (const [name, value] of Object.entries(toks)) {
      const key =
        name === "DEFAULT"
          ? "DEFAULT"
          : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      lines.push(`    ${JSON.stringify(key)}: "${value}",`)
    }
    lines.push("  },")
  }
  lines.push("} as const;")
  lines.push("")

  lines.push("export type PaletteColor = keyof typeof palette;")
  lines.push("export type TokenCategory = keyof typeof tokens;")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function printPreview(): void {
  const reset = "\x1b[0m"
  const bold = "\x1b[1m"
  const dim = "\x1b[2m"

  function block(hex: string): string {
    const [r, g, b] = hexToRgb(hex)
    return `\x1b[48;2;${r};${g};${b}m    ${reset}`
  }

  function contrastBadge(hex: string, bg: RGB): string {
    const ratio = contrastRatio(hexToRgb(hex), bg)
    const label = ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA " : ratio >= 3 ? "AA+" : "---"
    return `${dim}${ratio.toFixed(1)}:1 ${label}${reset}`
  }

  console.log(`\n${bold}IGNITION PALETTE${reset}\n`)

  const groups: Record<string, ColorSwatch[]> = {}
  for (const s of swatches) {
    const group = s.name.split("-")[0]
    ;(groups[group] ??= []).push(s)
  }
  for (const [group, items] of Object.entries(groups)) {
    console.log(`  ${bold}${group}${reset}`)
    for (const s of items) {
      console.log(`  ${block(s.hex)} ${s.hex}  ${s.name.padEnd(14)} ${s.role}`)
    }
    console.log()
  }

  console.log(`${bold}Syntax Colors (on ${semantic.syntax.background})${reset}`)
  for (const [name, hex] of Object.entries(syntaxColors)) {
    console.log(`  ${block(hex)} ${hex}  ${name.padEnd(14)} ${contrastBadge(hex, syntaxBg)}`)
  }
  console.log()

  console.log(`${bold}Status Colors${reset}`)
  for (const [name, hex] of Object.entries(semantic.status)) {
    if (hex.startsWith("#")) {
      console.log(`  ${block(hex)} ${hex}  ${name.padEnd(14)} ${contrastBadge(hex, canvasBg)}`)
    }
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const root = join(import.meta.dir, "..")
const themeDir = join(root, "src", "theme")
const docsThemeDir = join(root, "docs", "theme")

if (process.argv.includes("--preview")) {
  printPreview()
  process.exit(0)
}

mkdirSync(themeDir, { recursive: true })
mkdirSync(docsThemeDir, { recursive: true })

// Build both Shiki themes
const darkTheme = buildShikiTheme(
  "ignition-dark",
  "dark",
  semantic.syntax,
  semantic.status.ok,
  semantic.status.failed,
  semantic.accent.teal,
  semantic.text.dim,
  semantic.surface.border,
)

const lightSyntax = { ...semantic.syntax, ...lightOverrides.syntax }
const lightTheme = buildShikiTheme(
  "ignition-light",
  "light",
  lightSyntax,
  validated("#2A7A40", lightBg, TEXT_MIN_CONTRAST),
  validated("#A43820", lightBg, TEXT_MIN_CONTRAST),
  validated("#2A7A6E", lightBg, TEXT_MIN_CONTRAST),
  validated("#8AAA90", lightBg, 3.0),
  "#D0C4AE",
)

// Generate all outputs
const cssContent = generateCSS()
const tailwindContent = generateTailwindTokens()
const tsContent = generateTypeScript()

writeFileSync(join(themeDir, "palette.css"), cssContent + "\n")
writeFileSync(join(themeDir, "tailwind-tokens.css"), tailwindContent + "\n")
writeFileSync(join(themeDir, "palette.ts"), tsContent + "\n")
writeFileSync(join(docsThemeDir, "ignition-dark.json"), JSON.stringify(darkTheme, null, 2) + "\n")
writeFileSync(join(docsThemeDir, "ignition-light.json"), JSON.stringify(lightTheme, null, 2) + "\n")

console.log("Generated:")
console.log(`  src/theme/palette.css                       — CSS custom properties (dark + light)`)
console.log(`  src/theme/tailwind-tokens.css               — Tailwind v4 @theme tokens`)
console.log(`  src/theme/palette.ts                        — TypeScript constants`)
console.log(`  docs/theme/ignition-dark.json               — Shiki syntax theme (dark)`)
console.log(`  docs/theme/ignition-light.json              — Shiki syntax theme (light)`)
console.log()

printPreview()
