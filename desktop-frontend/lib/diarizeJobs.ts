import type { DiarizeRow } from "@/lib/diarize";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export type JobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export type DiarizeJob = {
  job_id: string;
  status: JobStatus;
  topic: string;
  meeting_id: string;
  duration_sec: number;
  created_at: string;
  completed_at: string | null;
  error: string | null;
  /** True when the transcript was too large for Cosmos to store word timings. */
  words_dropped?: boolean;
  /** Present only once status is "completed". */
  segments?: DiarizeRow[];
};

function authHeaders(jwt?: string | null): HeadersInit | undefined {
  return jwt ? { Authorization: `Bearer ${jwt}` } : undefined;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body?.detail || body?.message || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Upload the whole recording as one background job.
 *
 * Unlike diarizeAudioFile, which streams chunk by chunk and needs the app to
 * stay open for the entire run, this hands every chunk over in a single
 * request. Once it returns, the desktop app is free to close -- the vault owns
 * the work and the result from that point on.
 */
export async function createDiariseJob(
  audioFilePath: string,
  opts: {
    jwt?: string | null;
    topic?: string;
    meetingId?: string;
    durationSec?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const electron =
    typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!electron?.audioCompressAndRead) {
    throw new Error("Audio processing is only available in the desktop app.");
  }

  const { chunks, segmentSeconds, mimeType } =
    await electron.audioCompressAndRead(audioFilePath);
  if (!chunks.length) throw new Error("There is no audio to diarise.");

  const form = new FormData();
  for (const { buffer, name } of chunks) {
    // The server derives the decoder from this filename's extension, so the
    // chunk name has to travel with the blob.
    form.append("files", new Blob([buffer], { type: mimeType }), name);
  }
  form.append("duration_sec", String(opts.durationSec ?? 0));
  form.append("segment_seconds", String(segmentSeconds || 0));
  form.append("topic_guess", opts.topic || "Background diarisation");
  form.append("meeting_id", opts.meetingId || "");

  const res = await fetch(`${API_URL}/jobs/diarize`, {
    method: "POST",
    headers: authHeaders(opts.jwt),
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(
      await readError(res, `Could not start the job (${res.status}).`),
    );
  }
  const body = await res.json();
  if (!body?.job_id) throw new Error("The server did not return a job id.");
  return String(body.job_id);
}

/** Jobs this account has not acknowledged yet, oldest first. */
export async function fetchPendingJobs(
  jwt?: string | null,
  signal?: AbortSignal,
): Promise<DiarizeJob[]> {
  const res = await fetch(`${API_URL}/jobs/diarize/pending`, {
    headers: authHeaders(jwt),
    signal,
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body?.jobs) ? (body.jobs as DiarizeJob[]) : [];
}

/**
 * Mark a job consumed. Acknowledging is what stops a finished job being handed
 * out on every launch forever, so callers must only ack once the result is
 * safely stored locally.
 */
export async function ackJob(
  jobId: string,
  jwt?: string | null,
): Promise<void> {
  await fetch(`${API_URL}/jobs/diarize/${encodeURIComponent(jobId)}/ack`, {
    method: "POST",
    headers: authHeaders(jwt),
  }).catch(() => {});
}
