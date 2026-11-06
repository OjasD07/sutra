export const SITE_URL = (
  (import.meta.env.SITE_URL as string | undefined) ||
  'https://sutra-agent.netlify.app'
).replace(/\/$/, '');

export const SITE = {
  name: 'Sutra',
  title: 'Sutra — an open-source AI coding agent for the terminal',
  shortTitle: 'Sutra',
  tagline: 'The thread that connects intelligence to action.',
  description:
    'Sutra is an open-source AI coding agent for your terminal. It reads your code, makes the change, runs your tests, and tells you exactly what it did.',
  url: SITE_URL,
  repo: 'https://github.com/cneuralnetwork/sutra',
  repoLabel: 'cneuralnetwork/sutra',
  issues: 'https://github.com/cneuralnetwork/sutra/issues',
  docs: 'https://github.com/cneuralnetwork/sutra/tree/main/docs',
  readme: 'https://github.com/cneuralnetwork/sutra#readme',
  contributing:
    'https://github.com/cneuralnetwork/sutra/blob/main/CONTRIBUTING.md',
  license: 'https://github.com/cneuralnetwork/sutra/blob/main/LICENSE',
  licenseName: 'Apache 2.0',
  version: '0.1',
  ogImage: '/og.png',
  ogImageAlt:
    'Sutra — the thread that connects intelligence to action. An open-source AI coding agent for the terminal.',
} as const;

export const NAV_LINKS = [
  { href: '/#why-sutra', label: 'Why Sutra' },
  { href: '/#see-it-work', label: 'See it work' },
  { href: '/#benchmarks', label: 'Benchmarks' },
  { href: '/#quick-start', label: 'Install' },
] as const;

export const PROVIDERS = {
  cloud: [
    'DeepSeek',
    'OpenRouter',
    'OpenAI',
    'Anthropic',
    'Google Gemini',
    'xAI',
    'Mistral',
    'Groq',
    'Cerebras',
    'Together AI',
    'Fireworks AI',
    'DeepInfra',
    'Moonshot',
    'Z.AI',
    'Qwen',
    'SambaNova',
    'Hugging Face',
    'Vercel AI Gateway',
  ],
  local: ['Ollama', 'LM Studio', 'llama.cpp', 'vLLM', 'Jan'],
  other: 'Any OpenAI-compatible server',
} as const;

export function absoluteUrl(pathname = '/'): string {
  return new URL(pathname, `${SITE.url}/`).href;
}
