/**
 * Utility functions for Render SDK operations.
 * Handles client creation, error mapping, and task data fetching.
 */
import { AbortError, ClientError, Render, RenderError, ServerError } from "@renderinc/sdk";
import { LRUCache } from "lru-cache";
import { RENDER_API_BASE_URL, RENDER_API_KEY } from "./config.js";

/** Represents a child task spawned by the root audit task */
export interface SpawnedTask {
  id: string;
  status: string;
  task_id: string;
  input: string | null;
  startedAt?: string;
  completedAt?: string;
}

/** Cache task definition ID -> name to avoid repeated API calls */
const taskNameCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

/** Create Render SDK client (supports local dev via RENDER_USE_LOCAL_DEV env var) */
export function getRenderClient(): Render {
  const baseUrl = process.env.RENDER_USE_LOCAL_DEV?.toLowerCase() === "true"
    ? "http://localhost:8120"
    : undefined;

  return new Render({
    token: RENDER_API_KEY || undefined,
    baseUrl,
  });
}

/** Map Render SDK errors to HTTP status codes and messages */
export function toSdkErrorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof AbortError) {
    return { status: 504, message: "Request to Render API timed out" };
  }
  if (error instanceof ClientError) {
    return {
      status: error.statusCode ?? 400,
      message: error.message || "Invalid request to Render API",
    };
  }
  if (error instanceof ServerError) {
    return {
      status: error.statusCode ?? 502,
      message: "Render API error",
    };
  }
  if (error instanceof RenderError) {
    return { status: 502, message: error.message || "Render API error" };
  }
  return {
    status: 500,
    message: error instanceof Error ? error.message : "Unexpected error",
  };
}

/** Resolve task definition ID to human-readable name (cached) */
async function getTaskName(taskDefId: string): Promise<string> {
  const cached = taskNameCache.get(taskDefId);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(
      `${RENDER_API_BASE_URL}/tasks/${taskDefId}`,
      { headers: { Authorization: `Bearer ${RENDER_API_KEY}` } }
    );

    if (!response.ok) {
      console.warn(`Could not fetch task definition for ${taskDefId}`);
      return taskDefId;
    }

    const data = await response.json() as { name?: string; slug?: string };
    const slugPart = data.slug?.includes("/") ? data.slug.split("/").pop() : undefined;
    const taskName = data.name || slugPart || taskDefId;
    taskNameCache.set(taskDefId, taskName);
    console.log(`Cached task name: ${taskDefId} -> ${taskName}`);
    return taskName;
  } catch (error) {
    console.warn(`Could not fetch task definition for ${taskDefId}:`, error);
    return taskDefId;
  }
}

/** Fetch all child tasks spawned by a root task run */
export async function fetchSpawnedTasks(taskRunId: string): Promise<SpawnedTask[]> {
  if (!RENDER_API_KEY) {
    console.warn("RENDER_API_KEY not set, cannot fetch spawned tasks");
    return [];
  }

  try {
    const response = await fetch(
      `${RENDER_API_BASE_URL}/task-runs?rootTaskRunId=${taskRunId}&limit=100`,
      { headers: { Authorization: `Bearer ${RENDER_API_KEY}` } }
    );

    if (!response.ok) {
      console.warn(`Failed to fetch task runs: ${response.status}`);
      return [];
    }

    const taskRuns = await response.json() as Array<{
      id: string;
      taskId?: string;
      status: string;
      input?: unknown[];
      startedAt?: string;
      completedAt?: string;
    }>;

    console.log(`API returned ${taskRuns.length} task runs for root ${taskRunId}`);

    // Pre-fetch task names for all unique task definitions
    const uniqueTaskIds = new Set<string>(
      taskRuns
        .filter((st) => st.id !== taskRunId && st.taskId)
        .map((st) => st.taskId as string)
    );

    for (const tid of uniqueTaskIds) {
      if (!taskNameCache.has(tid)) {
        await getTaskName(tid);
      }
    }

    const filteredTasks = taskRuns.filter((st) => st.id !== taskRunId);

    const relatedTasks: SpawnedTask[] = filteredTasks
      .map((st) => {
        const taskDefId = st.taskId || "";
        const taskName = taskNameCache.get(taskDefId) || taskDefId;
        const inputs = st.input || [];

        return {
          id: st.id,
          status: st.status,
          task_id: taskName,
          input: (inputs[0] as string) || null,
          startedAt: st.startedAt,
          completedAt: st.completedAt,
        };
      });

    console.log(`Found ${relatedTasks.length} spawned tasks for ${taskRunId}`);
    return relatedTasks;
  } catch (error) {
    console.warn("Could not fetch spawned tasks:", error);
    return [];
  }
}
