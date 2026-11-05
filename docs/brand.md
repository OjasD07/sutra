# Brand

**Name:** Sutra. Always written this way in English. सूत्र is used as a supporting mark, never in place of the name.
**Tagline:** The thread that connects intelligence to action.
**Short form (CLI):** Intelligence, connected to action.

## Mark

A horizontal headline with a thread hanging from it. The thread turns once and ends in a node.

- The headline refers to the *shirorekha*, the line that joins letters in Devanagari script. It is literally a thread connecting characters.
- The single turn recalls the curve of स.
- The two nodes, where the thread leaves the headline and where it ends, represent the harness: reasoning at the top, action at the bottom.

The mark is built from strokes on a 64-unit grid. It stays legible down to 16 px, and the monochrome version uses `currentColor`.

| File | Use |
| --- | --- |
| `assets/logo.svg` | primary lockup (mark + wordmark + सूत्र) on midnight |
| `assets/symbol.svg` | standalone mark, app icon / favicon |
| `assets/symbol-mono.svg` | single-colour mark (`currentColor`) |
| `assets/wordmark.svg` | geometric SUTRA wordmark, drawn as paths (no font needed) |
| `assets/social-preview.svg` | 1280×640 GitHub social preview |
| `assets/wordmark.txt` | terminal wordmark (UTF-8 and ASCII fallback) |
| `assets/github-banner.svg` | wide README banner |
| `assets/github-social-card.svg` | editable 1280×640 GitHub social card |
| `assets/github-social-card.png` | upload-ready GitHub social preview |
| `assets/github-avatar.png` | 512×512 repository or organization avatar |

The PNGs can be regenerated with `python3 scripts/render-github-assets.py` (requires Pillow). Upload `github-social-card.png` in the repository's **Settings → General → Social preview**. The README uses `github-banner.svg` directly.

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| Midnight | `#101923` | primary background |
| Saffron gold | `#F5B84B` | accent: mark, prompts, highlights. Use sparingly |
| Ivory | `#F4F1E8` | primary foreground on midnight |
| Steel | `#9CAABA` | secondary text |
| Success | `#52B788` | |
| Error | `#E76F6F` | |
| Information | `#6CA8E8` | |

In the terminal, body text uses the terminal's own foreground colour, so it reads well on both dark and light backgrounds. A darker light-background palette is used when `ui.theme` is `light` or when `COLORFGBG` reports a light background. `NO_COLOR` and `--no-color` turn off all colour.

## Type

- Code and documentation: **JetBrains Mono** (SIL Open Font License 1.1).
- Devanagari: **Noto Sans Devanagari** (SIL OFL 1.1). **Mukta** (OFL) is an acceptable fallback.
- The CLI uses the terminal's own font. No fonts are bundled. The SVGs reference these families by name and fall back to system fonts. The Latin wordmark is drawn as paths, so it never depends on a font.

## Voice

Concise, technical, calm, transparent, direct. Say what happened and what didn't. No hype, no jokes in product copy, no corporate filler.
