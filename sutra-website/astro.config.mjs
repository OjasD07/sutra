// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { loadEnv } from 'vite';

/**
 * Set SITE_URL in Netlify (or in sutra-website/.env locally) to the primary
 * domain, for example https://sutra.dev. The fallback keeps local builds and
 * deploy previews working without a custom domain.
 */
const env = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '');
const site = env.SITE_URL || 'https://sutra-agent.netlify.app';

export default defineConfig({
  site,
  integrations: [
    sitemap({
      filter: (page) => !page.endsWith('/404/'),
    }),
  ],
  build: {
    inlineStylesheets: 'auto',
  },
  compressHTML: true,
});
