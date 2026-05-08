# YT Local Tool

YT Local Tool is a lightweight Next.js App Router PWA shell for submitting and tracking mock media jobs.

The current app is intended as a local-first frontend scaffold that can later talk to a private worker API. It includes a fake local job queue, status polling, PWA metadata, and placeholder download handling.

Real media processing is not implemented yet.

## Purpose

- Provide a simple local utility interface for entering a media URL and selecting output options.
- Support a future external worker API while keeping a local fake API fallback for development.
- Stay lightweight and easy to deploy on Vercel as a frontend shell.

## Local Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Start the production server locally:

```bash
npm run start
```

## Environment Variables

Copy values from `.env.local.example` into `.env.local` as needed.

- `NEXT_PUBLIC_WORKER_API_URL`
  Optional external worker base URL. When blank, the app uses the local fake Next.js API routes.
- `NEXT_PUBLIC_WORKER_API_KEY`
  Optional bearer token used only for external worker API requests.
- `DOWNLOADS_DIR`
  Local placeholder setting for future download/output handling.

`.env.local` is intentionally gitignored and should not be committed.

## Vercel Deployment Notes

- This app can be deployed to Vercel as a standard Next.js project.
- Set `NEXT_PUBLIC_WORKER_API_URL` and `NEXT_PUBLIC_WORKER_API_KEY` in the Vercel project settings only if you want the deployed frontend to call an external worker.
- If those values are not set, the app falls back to the included fake local API routes.
- The health check endpoint is available at `/api/health`.
- No service worker is configured yet.
- No real media downloading, conversion, or worker processing is implemented yet.

## Current Status

- Fake local job creation is implemented.
- Fake local polling is implemented.
- Placeholder download links are implemented for UI flow only.
- Real backend processing is not implemented yet.