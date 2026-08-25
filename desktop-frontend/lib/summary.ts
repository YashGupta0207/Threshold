const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

type Opts = {
  jwt?: string | null;
  meetingId?: string;
  signal?: AbortSignal;
};

/**
 * Ask the vault to summarise a transcript.
 *
 * The backend answers failures two different ways -- a FastAPI HTTPException
 * carries `detail` with a non-2xx status, while a caught provider error comes
 * back as 200 with `{status: "error", message}` -- so both are checked before
 * the result is trusted.
 */
export async function summarizeTranscript(
  text: string,
  opts: Opts = {},
): Promise<string> {
  const res = await fetch(`${API_URL}/summarize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}),
    },
    body: JSON.stringify({ text, meeting_id: opts.meetingId ?? "" }),
    signal: opts.signal,
  });

  let result: any = {};
  try {
    result = await res.json();
  } catch {
    /* falls through to the status-code message below */
  }

  if (!res.ok || result?.status === "error") {
    throw new Error(
      result?.detail || result?.message || `Summary failed: ${res.status}`,
    );
  }

  const summary = String(result?.summary ?? "").trim();
  if (!summary) throw new Error("The summary came back empty.");
  return summary;
}
