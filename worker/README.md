# yt-worker

`yt-worker` is a lightweight Express + TypeScript backend service intended to run separately from the Next.js frontend.

It is designed for future long-running media job processing on DigitalOcean, but currently exposes only fake authenticated job endpoints and a health check.

## Features

- Express HTTP API with TypeScript
- Bearer token protection for job endpoints
- CORS restricted by `ALLOWED_ORIGIN`
- Deterministic fake job progress without a database
- No frontend, no ffmpeg, no real media processing yet

## Scripts

Install dependencies:

```bash
npm install
```

Run in development:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Run the compiled server:

```bash
npm run start
```

## Environment Variables

- `PORT`
  Port for the worker server. Defaults to `3001`.
- `WORKER_API_SECRET`
  Shared bearer token required by `POST /jobs` and `GET /jobs/:id`.
- `ALLOWED_ORIGIN`
  Exact allowed browser origin for CORS.

Copy `.env.example` to `.env` or supply these values through your deployment platform.

## Endpoints

- `GET /health`
  Returns a simple readiness response.
- `POST /jobs`
  Requires `Authorization: Bearer <WORKER_API_SECRET>` and returns a fake queued job.
- `GET /jobs/:id`
  Requires the same auth and returns deterministic fake progress based on the timestamp encoded in the job id.

## Current Status

This worker does not download media, run ffmpeg, store jobs in a database, or manage persistent files yet.