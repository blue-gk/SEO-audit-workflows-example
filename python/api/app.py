"""
SEO Auditor API Service

Flask API for triggering and monitoring SEO audits via Render Workflows.
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify
from flask_cors import CORS
from flask_talisman import Talisman
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# Load .env from parent directory
env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

# Add parent directory to path for shared module
sys.path.insert(0, str(Path(__file__).parent.parent))

from handlers import get_audit_status, start_audit, status

app = Flask(__name__)

# CORS configuration - restrict to frontend origin in production
FRONTEND_URL = os.environ.get("FRONTEND_URL", "")
cors_origins = (
    [FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"]
    if FRONTEND_URL
    else "*"  # Allow all in development
)
CORS(app, origins=cors_origins, methods=["GET", "POST"], allow_headers=["Content-Type", "Authorization"])
# Security headers (disabled HTTPS enforcement for local dev, enable force_https in production)
Talisman(app, force_https=False, content_security_policy=None)
# Rate limiting
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["100 per minute"],
    storage_uri="memory://",
)

@app.route("/")
def index():
    """API root - health check."""
    return jsonify({"status": "healthy", "service": "seo-audit-api"})


@app.route("/audit", methods=["POST"])
@limiter.limit("10 per minute")
def audit():
    return start_audit()


@app.route("/audit/<task_run_id>", methods=["GET"])
def audit_status(task_run_id: str):
    return get_audit_status(task_run_id)


@app.route("/health")
def health():
    """Health check endpoint."""
    return jsonify({"status": "healthy"})


@app.route("/status")
def status_route():
    return status()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=True)
