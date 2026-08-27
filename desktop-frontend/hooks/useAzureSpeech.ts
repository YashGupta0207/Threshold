import { useCallback, useRef, useState } from "react";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const TOKEN_REFRESH_MS = 8 * 60 * 1000;

type UseAzureSpeechProps = {
  getAuthToken?: () => string | null;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onProgress?: (done: number, total: number) => void;
};

export function useAzureSpeech(initialProps?: UseAzureSpeechProps) {
  const callbacksRef = useRef({
    onPartial: initialProps?.onPartial,
    onFinal: initialProps?.onFinal,
    onError: initialProps?.onError,
    onProgress: initialProps?.onProgress,
  });

  const setCallbacks = useCallback(
    (cbs: {
      onPartial?: (text: string) => void;
      onFinal?: (text: string) => void;
      onError?: (message: string) => void;
      onProgress?: (done: number, total: number) => void;
    }) => {
      callbacksRef.current = { ...callbacksRef.current, ...cbs };
    },
    [],
  );

  const [micLabel, setMicLabel] = useState<string>("Default Microphone");
  const [detectedLanguage, setDetectedLanguage] = useState<string>("English");
  const [audioQuality, setAudioQuality] = useState<string>("Medium");

  const recognizerRef = useRef<SpeechSDK.SpeechRecognizer | null>(null);
  const renewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioFilePathRef = useRef<string | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const qualityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const isPausedRef = useRef<boolean>(false);
  const recognizerDeadRef = useRef<boolean>(false);
  const reconnectingRef = useRef<boolean>(false);
  const finishingRef = useRef<boolean>(false);
  const reconnectRef = useRef<null | (() => Promise<boolean>)>(null);
  const diarizeAbortRef = useRef<AbortController | null>(null);
  const seenLangsRef = useRef<Set<string>>(new Set());
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const deviceSwitchRef = useRef<null | (() => void)>(null);
  const deviceSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const readJwt = useCallback((): string | null => {
    if (initialProps?.getAuthToken) return initialProps.getAuthToken();
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
  }, [initialProps]);

  const fetchAzureToken = useCallback(async (): Promise<{
    token: string;
    region: string;
  }> => {
    const jwt = readJwt();
    if (!jwt)
      throw new Error("Not authenticated — no app token in localStorage.");
    const res = await fetch(`${API_URL}/azure/token`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) {
      // Include the server's own explanation; a bare status code sent people
      // hunting through client code for what was actually a vault-side
      // problem.
      let detail = "";
      try {
        detail = (await res.json())?.detail || "";
      } catch {
        /* body was not JSON */
      }
      throw new Error(
        res.status === 401
          ? "Your login session has expired — please sign in again."
          : detail || `The vault could not issue a speech token (${res.status}).`,
      );
    }
    return res.json();
  }, [readJwt]);

  const startRenewalLoop = useCallback(() => {
    if (renewTimerRef.current) clearInterval(renewTimerRef.current);
    renewTimerRef.current = setInterval(async () => {
      try {
        const { token } = await fetchAzureToken();
        if (recognizerRef.current && !recognizerDeadRef.current) {
          recognizerRef.current.authorizationToken = token;
        }
      } catch {
        callbacksRef.current.onError?.("Token renewal failed (will retry)");
      }
    }, TOKEN_REFRESH_MS);
  }, [fetchAzureToken]);

  const initRecognizer = useCallback(
    (token: string, region: string): SpeechSDK.SpeechRecognizer => {
      // An orphaned recognizer keeps firing `recognized` through
      // callbacksRef, and once this ref is overwritten nothing can ever
      // stop it -- so dispose whatever is here before replacing it.
      const stale = recognizerRef.current;
      if (stale) {
        recognizerRef.current = null;
        try {
          stale.stopContinuousRecognitionAsync(
            () => stale.close(),
            () => stale.close(),
          );
        } catch {
          try {
            stale.close();
          } catch {}
        }
      }
      const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
        token,
        region,
      );

      speechConfig.setProperty(
        SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode,
        "Continuous",
      );

      const autoDetectSourceLanguageConfig =
        SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages([
          "en-US",
          "en-IN",
        ]);

      const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(
        streamRef.current as MediaStream,
      );

      const recognizer = SpeechSDK.SpeechRecognizer.FromConfig(
        speechConfig,
        autoDetectSourceLanguageConfig,
        audioConfig,
      );

      const updateDetectedLanguage = (result: any) => {
        let lang = "";
        try {
          lang =
            SpeechSDK.AutoDetectSourceLanguageResult.fromResult(result)
              ?.language || "";
        } catch {}
        if (!lang) {
          lang =
            result.properties?.getProperty(
              (SpeechSDK.PropertyId as any)
                .SpeechServiceConnection_AutoDetectSourceLanguageResult,
            ) || "";
        }
        if (!lang) return;
        const l = lang.toLowerCase();
        setDetectedLanguage(
          l.startsWith("en-in")
            ? "Indian English"
            : l.startsWith("en-us")
              ? "US English"
              : "English",
        );
      };

      recognizer.recognizing = (_s: any, e: any) => {
        if (e.result.text) {
          updateDetectedLanguage(e.result);
          callbacksRef.current.onPartial?.(e.result.text);
        }
      };

      recognizer.recognized = (_s: any, e: any) => {
        if (
          e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
          e.result.text
        ) {
          updateDetectedLanguage(e.result);
          callbacksRef.current.onFinal?.(e.result.text);
        }
      };

      recognizer.canceled = (_s: any, e: any) => {
        recognizerDeadRef.current = true;
        if (e.reason === SpeechSDK.CancellationReason.Error) {
          callbacksRef.current.onError?.(
            e.errorDetails || "Recognition canceled",
          );
        }
        if (!isPausedRef.current && !finishingRef.current) {
          void reconnectRef.current?.();
        }
      };

      recognizer.sessionStopped = () => {
        recognizerDeadRef.current = true;
      };

      recognizerRef.current = recognizer;
      recognizerDeadRef.current = false;
      return recognizer;
    },
    [],
  );

  // Guards start() against running twice. A second run used to reset
  // recordedChunksRef (dropping the first recorder's header chunk, which
  // left an undecodable .webm) and attach a second recognizer, which
  // reported every sentence twice.
  const startingRef = useRef(false);

  const reconnect = useCallback(async (): Promise<boolean> => {
    if (reconnectingRef.current) return false;
    if (!streamRef.current || finishingRef.current) return false;
    reconnectingRef.current = true;
    try {
      const old = recognizerRef.current;
      recognizerRef.current = null;
      if (old) {
        try {
          old.stopContinuousRecognitionAsync(
            () => old.close(),
            () => old.close(),
          );
        } catch {
          try {
            old.close();
          } catch {}
        }
      }

      const { token, region } = await fetchAzureToken();
      const recognizer = initRecognizer(token, region);
      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(
          () => resolve(),
          (err) => reject(err),
        );
      });

      startRenewalLoop();
      return true;
    } catch (e: any) {
      callbacksRef.current.onError?.(
        `Live reconnect failed: ${e?.message || e}`,
      );
      return false;
    } finally {
      reconnectingRef.current = false;
    }
  }, [fetchAzureToken, initRecognizer, startRenewalLoop]);

  reconnectRef.current = reconnect;

  const start = useCallback(async (): Promise<boolean> => {
    // Only a concurrent start is refused.
    //
    // This used to also refuse when recognizerRef or mediaRecorderRef were
    // still set, which meant any session that ended abnormally -- a failed
    // start, an error mid-session -- left one of them populated and blocked
    // recording permanently, reporting only "Couldn't start recording". Those
    // leftovers are now torn down instead. Two recognisers or two recorders
    // still cannot run at once, which is what the guard was for.
    if (startingRef.current) {
      console.warn("[Recorder] start() ignored - one is already starting");
      return false;
    }
    startingRef.current = true;

    // initRecognizer disposes a stale recogniser; this covers the recorder.
    const staleRecorder = mediaRecorderRef.current;
    if (staleRecorder) {
      mediaRecorderRef.current = null;
      try {
        if (staleRecorder.state !== "inactive") staleRecorder.stop();
      } catch {}
    }
    try {
      finishingRef.current = false;
      seenLangsRef.current = new Set();
      setDetectedLanguage("Detecting");

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      micStreamRef.current = micStream;

      const micTracks = micStream.getAudioTracks();
      console.log(
        "[Recorder] getUserMedia mic tracks:",
        micTracks.length,
        micTracks.map((t) => ({
          label: t.label,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState,
        })),
      );

      if (micTracks.length > 0) {
        setMicLabel(micTracks[0].label || "Default Microphone");
      }

      let systemStream: MediaStream | null = null;
      try {
        if (
          typeof window !== "undefined" &&
          (window as any).electronAPI &&
          (window as any).electronAPI.getDesktopSourceId
        ) {
          const sourceId = await (
            window as any
          ).electronAPI.getDesktopSourceId();
          systemStream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: "desktop" } } as any,
            video: {
              mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: sourceId,
              },
            } as any,
          });
        } else {
          systemStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
        }
        systemStreamRef.current = systemStream;
      } catch (err) {
        console.warn("System audio capture skipped.", err);
      }

      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") {
        console.warn("[Recorder] AudioContext suspended — resuming.");
        await audioCtx.resume();
      }
      console.log("[Recorder] AudioContext state:", audioCtx.state);
      const destination = audioCtx.createMediaStreamDestination();
      destinationRef.current = destination;

      const micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(destination);
      micSourceRef.current = micSource;

      if (systemStream && systemStream.getAudioTracks().length > 0) {
        const systemSource = audioCtx.createMediaStreamSource(systemStream);
        systemSource.connect(destination);
        systemStream.getVideoTracks().forEach((t) => t.stop());
      } else if (systemStream) {
        systemStream.getTracks().forEach((t) => t.stop());
      }

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      micSource.connect(analyser);
      analyserRef.current = analyser;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      if (qualityIntervalRef.current) clearInterval(qualityIntervalRef.current);
      qualityIntervalRef.current = setInterval(() => {
        if (!isPausedRef.current && analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
          const average = sum / bufferLength;

          if (average < 8) setAudioQuality("Bad");
          else if (average < 30) setAudioQuality("Medium");
          else if (average < 70) setAudioQuality("Good");
          else setAudioQuality("Excellent");
        }
      }, 1000);

      const mixedStream = destination.stream;
      streamRef.current = mixedStream;
      isPausedRef.current = false;

      console.log(
        "[Recorder] mixed (recorded) stream audio tracks:",
        mixedStream.getAudioTracks().length,
      );

      recordedChunksRef.current = [];
      audioFilePathRef.current = null;

      const PREFERRED_TYPES = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ];
      const mimeType =
        PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const recorder = mimeType
        ? new MediaRecorder(mixedStream, { mimeType })
        : new MediaRecorder(mixedStream);
      console.log(
        "[Recorder] MediaRecorder created. requested:",
        mimeType || "(browser default)",
        "| actual mimeType:",
        recorder.mimeType,
      );

      let recordedChunksLength = 0;
      recorder.onstart = () =>
        console.log("[Recorder] onstart — state:", recorder.state);
      recorder.onerror = (ev) =>
        console.error("[Recorder] MediaRecorder error event:", ev);

      recorder.ondataavailable = (e) => {
        const size = e.data?.size ?? 0;
        if (e.data && size > 0) {
          recordedChunksRef.current.push(e.data);
        }
        recordedChunksLength += 1;
        console.log(
          `[Recorder] chunk #${recordedChunksLength} — size: ${size} bytes, type: ${
            e.data?.type || "(none)"
          } (buffered: ${recordedChunksRef.current.length})`,
        );
      };
      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      console.log(
        "[Recorder] recorder.start(1000) invoked — state:",
        recorder.state,
      );

      const { token, region } = await fetchAzureToken();
      const recognizer = initRecognizer(token, region);
      recognizer.startContinuousRecognitionAsync(
        () => startRenewalLoop(),
        (err) => callbacksRef.current.onError?.(String(err)),
      );

      const handleDeviceChange = () => {
        if (deviceSwitchTimerRef.current) {
          clearTimeout(deviceSwitchTimerRef.current);
        }
        deviceSwitchTimerRef.current = setTimeout(async () => {
          if (finishingRef.current || isPausedRef.current) return;
          const ctx = audioCtxRef.current;
          const dest = destinationRef.current;
          if (!ctx || !dest || ctx.state === "closed") return;
          try {
            const newStream = await navigator.mediaDevices.getUserMedia({
              audio: true,
            });
            const newLabel = newStream.getAudioTracks()[0]?.label;
            const oldLabel = micStreamRef.current?.getAudioTracks()[0]?.label;
            if (newLabel && oldLabel && newLabel === oldLabel) {
              newStream.getTracks().forEach((t) => t.stop());
              return;
            }
            const newSource = ctx.createMediaStreamSource(newStream);
            newSource.connect(dest);
            if (analyserRef.current) newSource.connect(analyserRef.current);
            try {
              micSourceRef.current?.disconnect();
            } catch {}
            micStreamRef.current?.getTracks().forEach((t) => t.stop());
            micSourceRef.current = newSource;
            micStreamRef.current = newStream;
            if (newLabel) setMicLabel(newLabel);
            console.log("[Recorder] mic device hot-swapped →", newLabel);
          } catch (err) {
            console.warn(
              "[Recorder] device switch failed — keeping current mic:",
              err,
            );
          }
        }, 400);
      };
      deviceSwitchRef.current = handleDeviceChange;
      navigator.mediaDevices.addEventListener(
        "devicechange",
        handleDeviceChange,
      );

      return true;
    } catch (e: any) {
      callbacksRef.current.onError?.(e?.message || "Failed to start");
      return false;
    } finally {
      // In a finally so an early return added later cannot strand the flag and
      // lock the user out of recording.
      startingRef.current = false;
    }
  }, [fetchAzureToken, initRecognizer, startRenewalLoop]);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    micStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false));
    systemStreamRef.current
      ?.getAudioTracks()
      .forEach((t) => (t.enabled = false));
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
    }
    setAudioQuality("Paused");
  }, []);

  const resume = useCallback(async () => {
    isPausedRef.current = false;
    micStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = true));
    systemStreamRef.current
      ?.getAudioTracks()
      .forEach((t) => (t.enabled = true));
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
    }
    if (recognizerDeadRef.current || !recognizerRef.current) {
      await reconnect();
    }
  }, [reconnect]);

  const cleanupStreams = useCallback(() => {
    if (qualityIntervalRef.current) clearInterval(qualityIntervalRef.current);
    if (deviceSwitchRef.current) {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        deviceSwitchRef.current,
      );
      deviceSwitchRef.current = null;
    }
    if (deviceSwitchTimerRef.current) {
      clearTimeout(deviceSwitchTimerRef.current);
      deviceSwitchTimerRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    systemStreamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current?.getTracks().forEach((t) => t.stop());

    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
    }

    micStreamRef.current = null;
    systemStreamRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;
    destinationRef.current = null;
    micSourceRef.current = null;
    analyserRef.current = null;
  }, []);

  const finishRecording = useCallback(
    async (onProgress?: (p: number) => void): Promise<any> => {
      finishingRef.current = true;
      if (renewTimerRef.current) {
        clearInterval(renewTimerRef.current);
        renewTimerRef.current = null;
      }
      onProgress?.(0.1);

      // Stop the Azure recognizer — but never let it hang the finish. If neither
      // the success nor error callback fires, a 4s race unblocks us.
      await Promise.race([
        new Promise<void>((resolve) => {
          const r = recognizerRef.current;
          if (!r) return resolve();
          r.stopContinuousRecognitionAsync(
            () => {
              try {
                r.close();
              } catch {}
              resolve();
            },
            () => resolve(),
          );
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 4000)),
      ]);
      recognizerRef.current = null;
      onProgress?.(0.25);

      await new Promise<void>((resolve) => {
        const recorder = mediaRecorderRef.current;
        if (!recorder || recorder.state === "inactive") return resolve();
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        recorder.onstop = done;
        setTimeout(done, 4000);
        try {
          recorder.stop();
        } catch {
          done();
        }
      });
      onProgress?.(0.3);

      let audioFilePath: string | null = null;
      const recordedChunks = recordedChunksRef.current;
      const recordedBlob =
        recordedChunks.length > 0
          ? new Blob(recordedChunks, {
              type: mediaRecorderRef.current?.mimeType || "audio/webm",
            })
          : null;

      // INSTANT, reliable playback URL from the recorded blob — no ffmpeg on the
      // critical path (remux was the flaky/slow step that made audio late/absent).
      const playbackUrl =
        recordedBlob && recordedBlob.size > 0
          ? URL.createObjectURL(recordedBlob)
          : null;

      // Write the raw file to disk in chunks so the finishing bar reflects REAL
      // bytes written (the genuinely slow part for long meetings) — 30% → 95%.
      if (
        recordedBlob &&
        recordedBlob.size > 0 &&
        typeof window !== "undefined" &&
        window.electronAPI?.audioFileCreate
      ) {
        try {
          audioFilePath = await window.electronAPI.audioFileCreate();
          const arrayBuffer = await recordedBlob.arrayBuffer();
          const total = arrayBuffer.byteLength;
          const CHUNK = 4 * 1024 * 1024;
          let offset = 0;
          while (offset < total) {
            const end = Math.min(offset + CHUNK, total);
            await window.electronAPI.audioFileAppend(
              audioFilePath,
              arrayBuffer.slice(offset, end),
            );
            offset = end;
            onProgress?.(0.3 + 0.65 * (offset / total));
          }
          await window.electronAPI.audioFileClose(audioFilePath);
          audioFilePathRef.current = audioFilePath;
        } catch {
          audioFilePath = null;
        }
      }
      onProgress?.(1);

      cleanupStreams();
      mediaRecorderRef.current = null;

      return {
        status: "success",
        audioUrl: playbackUrl,
        audioFilePath,
      };
    },
    [cleanupStreams],
  );

  const getRecordingFilePath = useCallback(
    () => audioFilePathRef.current,
    [],
  );

  const cancel = useCallback(() => {
    finishingRef.current = true;
    if (diarizeAbortRef.current) {
      try {
        diarizeAbortRef.current.abort();
      } catch {}
      diarizeAbortRef.current = null;
    }
    if (renewTimerRef.current) clearInterval(renewTimerRef.current);
    const r = recognizerRef.current;
    if (r) {
      try {
        r.stopContinuousRecognitionAsync(
          () => r.close(),
          () => r.close(),
        );
      } catch {}
      recognizerRef.current = null;
    }
    const mr = mediaRecorderRef.current;
    if (mr) {
      try {
        if (mr.state !== "inactive") mr.stop();
      } catch {}
      mediaRecorderRef.current = null;
    }

    if (audioFilePathRef.current && typeof window !== "undefined" && window.electronAPI?.audioFileClose) {
      void window.electronAPI.audioFileClose(audioFilePathRef.current).catch(() => {});
      audioFilePathRef.current = null;
    }

    cleanupStreams();
    isPausedRef.current = false;
    recognizerDeadRef.current = false;
    recordedChunksRef.current = [];
  }, [cleanupStreams]);

  /**
   * Write everything captured so far to its own file, without disturbing the
   * recording, so speakers can be separated mid-session.
   *
   * Diarisation needs a file, and the real recording is only written when the
   * session finishes. The buffered chunks are still a complete stream on their
   * own -- chunk 0 carries the EBML header -- so a blob built from them decodes
   * on its own. requestData() is called first because MediaRecorder holds the
   * current timeslice in an internal buffer that ondataavailable has not seen
   * yet, and without flushing it the snapshot stops a second short.
   *
   * The file is a throwaway copy: the session keeps recording into its own
   * buffer and still produces the full recording at the end.
   */
  const snapshotAudioToFile = useCallback(async (): Promise<string | null> => {
    const recorder = mediaRecorderRef.current;
    const electron = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!electron?.audioFileCreate) return null;

    // Flush while paused too. pause() calls MediaRecorder.pause(), which holds
    // the slice recorded since the last ondataavailable in an internal buffer;
    // skipping the flush there strands the final seconds of speech, which is
    // exactly the audio someone is most likely to want labelled.
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.requestData();
      } catch {}
      // Give ondataavailable a turn to land the flushed chunk.
      await new Promise((r) => setTimeout(r, 150));
    }

    const chunks = recordedChunksRef.current;
    if (!chunks.length) return null;

    const blob = new Blob(chunks, {
      type: chunks[0]?.type || "audio/webm",
    });
    if (blob.size === 0) return null;

    const path = await electron.audioFileCreate();
    const buf = await blob.arrayBuffer();
    const CHUNK = 4 * 1024 * 1024;
    let offset = 0;
    while (offset < buf.byteLength) {
      const end = Math.min(offset + CHUNK, buf.byteLength);
      await electron.audioFileAppend(path, buf.slice(offset, end));
      offset = end;
    }
    await electron.audioFileClose(path);
    return path;
  }, []);

  return {
    start,
    pause,
    resume,
    finishRecording,
    snapshotAudioToFile,
    getRecordingFilePath,
    cancel,
    micLabel,
    detectedLanguage,
    audioQuality,
    setCallbacks,
  };
}
