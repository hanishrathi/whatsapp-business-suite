# AcquiHire Tech — Brand Guidelines (WhatsApp Suite)

These are the **official, locked** brand fonts and colors. Always use these. Never
introduce a different typeface or pull fonts from a third-party CDN.

## Fonts (self-hosted — NO third-party CDN)
All fonts live in `/fonts/*.woff2` and are declared in `css/fonts.css`.
Every HTML page must link `css/fonts.css` (and nothing from fonts.googleapis.com).

| Role | Font | CSS variable | Weights |
|------|------|--------------|---------|
| Display / headings | **Syne** | `--font-heading` | 400, 600, 700, 800 |
| Body / UI text | **DM Sans** | `--font` | 300, 400, 500, 600, 700 (+ italic 400) |
| Monospace / codes | **JetBrains Mono** | `--font-mono` | 400, 500 |

These match the public site **acquihiretech.com** exactly.

```css
--font:         "DM Sans", -apple-system, "system-ui", "Segoe UI", sans-serif;
--font-heading: "Syne", sans-serif;
--font-mono:    "JetBrains Mono", monospace;
```

## Brand colors
| Token | Hex | Use |
|-------|-----|-----|
| WhatsApp green | `#25D366` | primary actions, brand |
| Green (dark) | `#128C7E` | hovers, accents |
| Text | `#1d1d1f` | headings/body |
| Text secondary | `#86868b` | muted labels |
| Background | `#f5f5f7` | app background |
| Card | `#ffffff` | surfaces |
| Border | `#e8e8ed` | dividers |

Accent palette (account color-coding): `#25D366` green, `#34B7F1` blue,
`#9B59B6` purple, `#FF9500` orange, `#FF6B6B` red, `#1ABC9C` teal.

## Rules
1. **No third-party font CDNs.** Fonts are self-hosted in `/fonts/`. The CSP blocks
   external font/style sources (`font-src 'self'`).
2. **To add a weight:** download the woff2, add an `@font-face` to `css/fonts.css`,
   reference the local file — never a Google URL.
3. Headings use Syne; everything else uses DM Sans; codes/OTP use JetBrains Mono.
