import type { NextFunction, Request, Response } from "express";

export function requireWorkerAuth(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const secret = process.env.WORKER_API_SECRET?.trim();
  const authorization = request.header("authorization");

  if (!secret) {
    response.status(500).json({ error: "WORKER_API_SECRET is not configured." });
    return;
  }

  if (authorization !== `Bearer ${secret}`) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}