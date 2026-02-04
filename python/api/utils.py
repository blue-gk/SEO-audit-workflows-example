"""
Utility functions for Render SDK operations.
Handles client creation, error mapping, and task data fetching.
"""
import asyncio
import logging
import os
from typing import Any, Dict, Tuple

import httpx
from cachetools import TTLCache
from render_sdk import Render
from render_sdk.client.errors import ClientError, RenderError

from config import RENDER_API_BASE_URL

logger = logging.getLogger(__name__)

_render = None

# Cache task definition ID -> name to avoid repeated API calls
_task_name_cache: TTLCache = TTLCache(maxsize=1000, ttl=3600)  # 1 hour TTL


def get_render_client() -> Render:
    """Get Render client for running tasks (local or production)."""
    global _render
    if _render is None:
        use_local_dev = os.environ.get("RENDER_USE_LOCAL_DEV", "").lower() == "true"

        if use_local_dev:
            _render = Render(
                token="local-dev",
                base_url="http://localhost:8120",
            )
        else:
            _render = Render()
    return _render


def run_async(coro):
    """Run async coroutine in sync Flask context (creates new event loop)."""
    return asyncio.run(coro)


def to_sdk_error_response(error: Exception) -> Tuple[int, str]:
    """Map Render SDK errors to HTTP status codes and messages."""
    if isinstance(error, ClientError):
        return 400, f"Client error: {str(error)}"
    if isinstance(error, RenderError):
        return 500, f"Render API error: {str(error)}"
    return 500, str(error)


async def get_task_name(client: httpx.AsyncClient, task_def_id: str, api_key: str) -> str:
    """Resolve task definition ID to human-readable name (cached)."""
    if task_def_id in _task_name_cache:
        return _task_name_cache[task_def_id]

    try:
        response = await client.get(
            f"{RENDER_API_BASE_URL}/tasks/{task_def_id}",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        task_name = data.get("name") or task_def_id
        if not data.get("name") and "/" in data.get("slug", ""):
            task_name = data.get("slug", "").split("/")[-1]
        _task_name_cache[task_def_id] = task_name
        logger.info(f"Cached task name: {task_def_id} -> {task_name}")
        return task_name
    except Exception as e:
        logger.warning(f"Could not fetch task definition for {task_def_id}: {e}")
        return task_def_id


async def fetch_spawned_tasks(task_run_id: str) -> list:
    """Fetch all child tasks spawned by a root task run."""
    api_key = os.environ.get("RENDER_API_KEY")
    if not api_key:
        logger.warning("RENDER_API_KEY not set, cannot fetch spawned tasks")
        return []

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{RENDER_API_BASE_URL}/task-runs",
                params={
                    "rootTaskRunId": task_run_id,
                    "limit": 100,
                },
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=10,
            )
            response.raise_for_status()
            data = response.json()

            logger.info(f"Render API returned {len(data)} task runs for root {task_run_id}")

            # Pre-fetch task names for all unique task definitions
            unique_task_ids = set(
                st.get("taskId") for st in data
                if st.get("id") != task_run_id and st.get("taskId")
            )

            for tid in unique_task_ids:
                if tid not in _task_name_cache:
                    await get_task_name(client, tid, api_key)

            related_tasks = []
            for st in data:
                if st.get("id") == task_run_id:
                    continue

                task_def_id = st.get("taskId", "")
                task_name = _task_name_cache.get(task_def_id, task_def_id)
                inputs = st.get("input", [])

                related_tasks.append({
                    "id": st.get("id"),
                    "status": st.get("status"),
                    "task_id": task_name,
                    "startedAt": st.get("startedAt"),
                    "completedAt": st.get("completedAt"),
                    "input": inputs[0] if inputs else None,
                })

            logger.info(f"Found {len(related_tasks)} spawned tasks for {task_run_id}")
            return related_tasks

    except httpx.HTTPStatusError as e:
        logger.warning(f"HTTP error fetching spawned tasks: {e.response.status_code} - {e.response.text}")
        return []
    except Exception as e:
        logger.warning(f"Could not fetch spawned tasks from API: {e}")
        return []


async def fetch_task_status(client: Render, task_run_id: str) -> Dict[str, Any]:
    """Fetch task run status and spawned tasks."""
    task_run = await client.workflows.get_task_run(task_run_id)

    response = {
        "id": task_run.id,
        "status": task_run.status,
        "retries": task_run.retries,
    }

    response["tasks"] = await fetch_spawned_tasks(task_run_id)

    if task_run.status == "completed":
        response["results"] = task_run.results

    return response
