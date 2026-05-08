import "dotenv/config";

import cors from "cors";
import express from "express";

import { healthRouter } from "./routes/health";
import { jobsRouter } from "./routes/jobs";

const app = express();
const port = Number(process.env.PORT || 3001);

const corsOptions: cors.CorsOptions = {
  origin: process.env.ALLOWED_ORIGIN?.trim() || "http://localhost:3002",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

app.use(express.json());
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use("/health", healthRouter);
app.use("/jobs", jobsRouter);

app.listen(port, () => {
  console.log(`yt-worker listening on port ${port}`);
});