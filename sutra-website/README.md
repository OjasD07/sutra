# Sutra website

The landing page for [Sutra](https://github.com/cneuralnetwork/sutra), the
open-source AI coding agent for the terminal.

It is a small, static Astro site. Everything lives in this folder and the site
does not change the CLI, its build or its package.

The page explains what Sutra is, shows an example session and the project's
measured benchmark results, and sends visitors to the repository to download it.
The full documentation stays in the repository's [`docs/`](../docs) folder.

## Run locally

```bash
cd sutra-website
npm install
npm run dev
```

You need Node.js 22.23.4 or newer (the minimum for Astro 7). The site runs at
`http://localhost:4321`.

```bash
npm run build    # static output in dist/
npm run preview  # preview the production build
npm run check    # Astro and TypeScript checks
```

## Deploy to Netlify

1. Create a new Netlify site from the repository.
2. Set **Base directory** to `sutra-website`.
3. Leave the build command and publish directory as configured in
   [`netlify.toml`](netlify.toml): `npm run build` and `dist`.
4. Set `SITE_URL` in **Site configuration → Environment variables** to the
   production origin, for example `https://sutra.dev` (no trailing slash).
5. Deploy.

`SITE_URL` is used for canonical URLs, Open Graph tags and the sitemap. Without
it, the site falls back to `https://sutra-agent.netlify.app`.

The included redirects also make `/github`, `/download` and `/docs` useful short
links.

## Analytics

The site supports [Plausible](https://plausible.io), a privacy-friendly
analytics service with no cookies or cross-site tracking. It is off by default.

Set these Netlify environment variables to turn it on:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_PLAUSIBLE_DOMAIN` | The domain configured in Plausible, for example `sutra.dev`. Analytics loads only when this is set. |
| `PUBLIC_PLAUSIBLE_SCRIPT_URL` | Optional. The script URL for a self-hosted Plausible instance. Defaults to `https://plausible.io/js/script.js`. |

The following conversion events are sent when analytics is enabled:

- `download-header`
- `download-mobile`
- `download-hero`
- `download-quickstart`
- `download-cta`
- `readme-cta`
- `github-header`

Netlify Analytics can also be enabled in the Netlify dashboard. It is
server-side and needs no site code.

## SEO

The site includes:

- Per-page titles, descriptions, canonical URLs and robots directives.
- Open Graph and Twitter Card metadata, using `assets/github-social-card.png`.
- `SoftwareApplication`, `WebSite` and `FAQPage` structured data on the landing
  page.
- A generated sitemap via `@astrojs/sitemap`.
- `robots.txt` with the sitemap location.
- A web app manifest and SVG/PNG icons.
- Semantic headings, a skip link, reduced-motion support and a 404 page.

## Theme

The palette follows [`docs/brand.md`](../docs/brand.md) and the README banner:

| Token | Hex | Use |
| --- | --- | --- |
| Midnight | `#101923` | primary background |
| Saffron gold | `#F5B84B` | accent, mark, highlights |
| Ivory | `#F4F1E8` | foreground on midnight |
| Steel | `#9CAABA` | secondary text |
| Success | `#52B788` | pass states |
| Information | `#6CA8E8` | links and notes |
| Error | `#E76F6F` | failures |

The site defaults to the system theme and has a dark/light toggle. Typography is
Inter for text, JetBrains Mono for code, and Noto Sans Devanagari for सूत्र.

Brand assets in `public/brand/` are copied from the repository's
[`assets/`](../assets) folder. If the brand changes, update the copies here too.

## Structure

```
src/
  components/   header, footer, session card, terminal example, icons, SEO
  layouts/      base document
  lib/          site metadata and links
  pages/        landing page, privacy, 404, robots.txt
  scripts/      theme toggle, navigation, copy buttons, reveal, events
  styles/       the full theme and responsive layout
public/         icons, social card, manifest
netlify.toml    build, redirects and security headers
```

## License

The website is part of Sutra and is released under the Apache License 2.0.
