declare global {
  interface Window {
    plausible?: (
      event: string,
      options?: { props?: Record<string, string | number | boolean> },
    ) => void;
  }
}

export {};

const root = document.documentElement;
const themeToggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
const themeQuery = window.matchMedia('(prefers-color-scheme: light)');

function storedTheme(): 'dark' | 'light' | null {
  try {
    const value = localStorage.getItem('sutra-theme');
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function syncThemeButton(): void {
  if (!themeToggle) return;
  const isDark = root.dataset.theme !== 'light';
  themeToggle.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
}

function setTheme(theme: 'dark' | 'light', persist: boolean): void {
  root.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem('sutra-theme', theme);
    } catch {
      // A blocked storage API should not break the page.
    }
  }
  syncThemeButton();
}

syncThemeButton();

themeToggle?.addEventListener('click', () => {
  setTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true);
});

themeQuery.addEventListener('change', (event) => {
  if (storedTheme()) return;
  setTheme(event.matches ? 'light' : 'dark', false);
});

/* Header state and mobile navigation. */

const header = document.querySelector<HTMLElement>('[data-site-header]');
const navToggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');

function setNavOpen(open: boolean): void {
  if (!header || !navToggle) return;
  header.classList.toggle('nav-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}

navToggle?.addEventListener('click', () => {
  setNavOpen(!header?.classList.contains('nav-open'));
});

document.querySelectorAll<HTMLAnchorElement>('[data-nav-link]').forEach((link) => {
  link.addEventListener('click', () => setNavOpen(false));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setNavOpen(false);
});

document.addEventListener('click', (event) => {
  if (!header?.classList.contains('nav-open')) return;
  if (event.target instanceof Node && header.contains(event.target)) return;
  setNavOpen(false);
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 900) setNavOpen(false);
});

function syncHeader(): void {
  header?.classList.toggle('is-scrolled', window.scrollY > 8);
}

syncHeader();
window.addEventListener('scroll', syncHeader, { passive: true });

/* Copy-to-clipboard buttons. */

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  const original = label?.textContent ?? 'Copy';

  button.addEventListener('click', async () => {
    const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    if (!code) return;

    const ok = await copyText(code);
    if (label) label.textContent = ok ? 'Copied' : 'Failed';
    button.classList.toggle('is-copied', ok);

    window.setTimeout(() => {
      if (label) label.textContent = original;
      button.classList.remove('is-copied');
    }, 1600);
  });
});

/* Reveal elements as they enter the viewport. */

const revealItems = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (reducedMotion || !('IntersectionObserver' in window)) {
  revealItems.forEach((item) => item.classList.add('is-visible'));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );

  revealItems.forEach((item) => observer.observe(item));
}

/* Privacy-friendly conversion events. */

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest<HTMLElement>('[data-analytics]');
  if (!target) return;

  const eventName = target.dataset.analytics;
  if (!eventName) return;

  window.plausible?.(eventName, {
    props: { page: window.location.pathname },
  });
});
