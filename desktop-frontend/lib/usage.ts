const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/**
 * Tell the vault how long a finished recording was, so the admin portal can
 * show minutes used against each account's allowance.
 *
 * Reported once per recording rather than measured server side: the live
 * speaker view re-diarises the whole recording on every pass, so counting
 * per request would charge the same audio repeatedly.
 *
 * Never throws. Usage accounting must not be able to fail a save that has
 * already happened.
 */
export async function reportUsageSeconds(
  seconds: number,
  jwt?: string | null,
): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0 || !jwt) return;
  try {
    await fetch(`${API_URL}/usage/minutes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ seconds }),
    });
  } catch {
    /* offline, or the vault is asleep - the recording is still saved */
  }
}
