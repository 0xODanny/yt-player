import { Router } from "express";

const healthRouter = Router();

healthRouter.get("/", (_request, response) => {
  response.json({ ok: true, service: "yt-worker" });
});

export { healthRouter };