# Codex Claude Bridge website

The public landing page for Codex Claude Bridge. It explains the persistent
session relay, its concurrency guarantees, and the shortest path to a local
install.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The development server prints its local URL. The site is built with Next.js,
vinext, and the OpenAI Sites deployment scaffold.

## Checks

```bash
npm test
npm run lint
```

`npm test` creates a production bundle and verifies the server-rendered page.
The tests cover the product title, command examples, install command, GitHub
destination, and removal of starter preview artifacts.

## Main files

- `app/page.tsx`: page content and relay composition
- `app/globals.css`: responsive design system and motion rules
- `app/components/CopyCommand.tsx`: copyable install command
- `public/og.png`: social preview image
