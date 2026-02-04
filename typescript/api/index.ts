/**
 * SEO Auditor API Service
 *
 * Express API for triggering and monitoring SEO audits via Render Workflows.
 * Uses the official @renderinc/sdk for workflow operations.
 */

import cors from "cors";
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  getAuditStatusHandler,
  getStatusHandler,
  startAuditHandler,
} from "./handlers.js";

const app = express();
// Security headers - configured for API use (allow cross-origin requests)
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false, // Not needed for JSON API
  })
);

// CORS configuration - restrict to frontend origin in production
const FRONTEND_URL = process.env.FRONTEND_URL || "";
const corsOptions: cors.CorsOptions = {
  origin: FRONTEND_URL
    ? [FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"] // Allow frontend + dev servers
    : true, // Allow all in development
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.use(express.json());

// Rate limiting for audit endpoint
const auditRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // 3 requests per minute per IP
  message: { error: "Too many audit requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// General rate limiting
const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalRateLimiter);

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "healthy", service: "seo-audit-api" });
});

// Start a new audit via SDK
app.post("/audit", auditRateLimiter, startAuditHandler);

// Get audit status
app.get("/audit/:taskRunId", getAuditStatusHandler);

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "healthy" });
});

// Status endpoint - check workflow configuration
app.get("/status", getStatusHandler);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`SEO Audit API listening on port ${PORT}`);
});
