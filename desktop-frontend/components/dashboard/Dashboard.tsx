"use client";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
  Check,
  Save,
  Copy,
  Menu,
  FileText,
  Highlighter,
  ChevronDown,
} from "lucide-react";
import { useGlobalRecording } from "@/components/GlobalRecordingProvider";
import MyMeetings from "@/components/MyMeetings";
import Sidebar, { type DashboardView } from "./Sidebar";
import MobileSidebar from "./MobileSidebar";
import CaptureControls from "./CaptureControls";
import TranscriptArea from "./TranscriptArea";
import {
  loadMeetings,
  addMeeting,
  updateMeeting,
  MEETINGS_EVENT,
} from "@/lib/meetingStore";
import { getUserName, clearSession } from "@/lib/auth";
import { diarizeAudioFile, transcribeAudioFile } from "@/lib/diarize";
import {
  createDiariseJob,
  fetchPendingJobs,
  ackJob,
} from "@/lib/diarizeJobs";
import { reportUsageSeconds } from "@/lib/usage";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ScrollNav from "@/components/ui/ScrollNav";
import AudioPlayer from "@/components/ui/AudioPlayer";
import HighlightedText, {
  highlightRanges,
} from "@/components/ui/HighlightedText";

// How often the live speaker view looks for work while recording. A pass only
// starts when new speech has actually been recognised and none is already
// running, so this is a poll interval, not a fixed cost: silence is free, and
// the tail is picked up shortly after someone stops talking.
const LIVE_DIARISE_POLL_MS = 5000;

type TranscriptWord = {
  word: string;
  start: number;
  end: number;
};

/**
 * Spread words evenly across a time span, weighted by word length and by the
 * pause that punctuation implies. This is a port of interpolate_words() in
 * desktop-backend/vault/main.py, which the diarize path already falls back to
 * whenever the model returns segments without per-word timings. Keeping the
 * same weighting means both views highlight at the same cadence.
 *
 * These timings are estimated, not measured: gpt-4o-transcribe only supports
 * the "json" and "text" response formats, so it cannot return real word
 * timestamps (that needs verbose_json + timestamp_granularities, a whisper-1
 * feature). Highlighting tracks well through continuous speech and drifts
 * across long silences.
 */
function interpolateWords(
  text: string,
  start: number,
  end: number,
): TranscriptWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const weights = words.map(
    (w) => w.length + 1 + (/[.?!,;-]$/.test(w) ? 5 : 0),
  );
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const duration = Math.max(0, end - start);
  const out: TranscriptWord[] = [];
  let cursor = start;
  words.forEach((w, i) => {
    const cursorEnd = cursor + duration * (weights[i] / total);
    out.push({
      word: w,
      start: Number(cursor.toFixed(3)),
      end: Number(Math.min(end, cursorEnd).toFixed(3)),
    });
    cursor = cursorEnd;
  });
  out[out.length - 1].end = Number(end.toFixed(3));
  return out;
}

type MergedTranscriptRow = {
  speaker: string;
  text: string;
  start: number;
  end: number;
  words?: TranscriptWord[];
};

export type CaptureTab = "live" | "upload";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const stripSpeakerPrefix = (text: string) => text.replace(/^\[.*?\]\s*/, "");

const SPEAKER_HEX = [
  "#2FB5AA",
  "#2E6DBE",
  "#1F2540",
  "#3B96A9",
];

function formatTime(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function AmbientGlow() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_35%_at_18%_12%,rgba(47,181,170,0.12),transparent_60%),radial-gradient(45%_40%_at_85%_88%,rgba(46,109,190,0.10),transparent_60%)]"
    />
  );
}

export default function Dashboard() {
  const router = useRouter();

  const [view, setView] = useState<DashboardView>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [sessionTime, setSessionTime] = useState(0);
  const [activeTab, setActiveTab] = useState<CaptureTab>("live");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [meetingsCount, setMeetingsCount] = useState(0);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  // File-upload phase (auto-starts on select) is separate from transcription:
  // upload streams to a bottom bar; transcription (on Process click) uses the
  // status bar. uploadedMediaUrl is the persisted audio to transcribe/play.
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [fileUploadPct, setFileUploadPct] = useState(0);
  const [uploadReady, setUploadReady] = useState(false);
  const [uploadedMediaUrl, setUploadedMediaUrl] = useState<string | null>(null);

  const [lines, setLines] = useState<string[]>([]);
  const [interim, setInterim] = useState("");
  const transcriptText = useMemo(
    () => [...lines, interim].filter(Boolean).join("\n\n"),
    [lines, interim],
  );

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [mergedTranscript, setMergedTranscript] = useState<MergedTranscriptRow[]>([]);
  const [isDiarizing, setIsDiarizing] = useState(false);
  const [diarizeProgress, setDiarizeProgress] = useState(0);
  // "Finishing recording" progress (stop → write → ready), so the user sees when
  // the transcript + audio will appear.
  const [isFinishing, setIsFinishing] = useState(false);
  const [finishProgress, setFinishProgress] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [transcriptView, setTranscriptView] = useState<"transcript" | "diarize">(
    "transcript",
  );
  const [audioFilePath, setAudioFilePath] = useState<string | null>(null);
  const [showDiarizeRetryModal, setShowDiarizeRetryModal] = useState(false);
  // The backend already turns Azure/gateway failures into a plain-English
  // sentence (quota used up, service busy, credentials rejected). Keep it so
  // the modal can say what actually went wrong instead of "failed".
  const [diarizeError, setDiarizeError] = useState<string | null>(null);
  const [savedMeetingId, setSavedMeetingId] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<string[]>([]);
  const [showHighlights, setShowHighlights] = useState(true);
  const [highlightsOnly, setHighlightsOnly] = useState(false);
  const [editingSpeakerIdx, setEditingSpeakerIdx] = useState<number | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState("");
  const [hlButton, setHlButton] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [currentAudioTime, setCurrentAudioTime] = useState(0);
  // Per-chunk transcripts from the plain transcribe path, plus the chunk size
  // and the player's resolved length. Together these let us synthesise word
  // timings so the transcript view highlights in sync like the diarize view.
  const [showDiariseMenu, setShowDiariseMenu] = useState(false);
  // handleSaveTranscript is defined further down, so it cannot be named in
  // this callback's dependency list. The ref is assigned right after that
  // declaration and always holds the current version.
  const saveTranscriptRef = useRef<
    (() => Promise<string | null>) | null
  >(null);
  const diariseMenuRef = useRef<HTMLDivElement | null>(null);
  // Tracks only the upload leg of a background job. Kept separate from
  // isDiarizing because that flag disables recording and upload app-wide, and
  // a background job must not lock anything.
  const [bgDiarising, setBgDiarising] = useState(false);
  // Separating speakers from a still-running recording.
  const [liveDiarising, setLiveDiarising] = useState(false);
  // Speakers for a still-running session. Deliberately NOT
  // mergedTranscript: that is the app's "this session is finished and
  // diarised" signal, and setting it mid-recording swaps the whole panel
  // for the playback view, hiding the transcript that is still growing.
  const [liveSegments, setLiveSegments] = useState<MergedTranscriptRow[]>(
    [],
  );
  // How many recognised lines the current liveSegments already cover.
  // Anything past this is speech that arrived after the snapshot and is
  // shown as plain text underneath, so the panel never looks frozen.
  const [liveSegmentsUpTo, setLiveSegmentsUpTo] = useState(0);
  // VIEW state, deliberately separate from the data above. Toggling this
  // switches between the speaker view and plain text; it never touches
  // liveSegments, lines or the recording, so switching cannot lose results.
  const [liveDiariseOn, setLiveDiariseOn] = useState(false);
  // Lines covered by the last completed run, so a refresh is skipped when
  // nothing new has been said.
  const lastRunLinesRef = useRef(-1);
  // Mirror the two in-flight flags so runLiveDiarisation can read them without
  // listing them as dependencies (see the note in that callback).
  const liveDiarisingRef = useRef(false);
  const isDiarizingRef = useRef(false);
  const [transcriptParts, setTranscriptParts] = useState<string[]>([]);
  const [transcriptSegmentSeconds, setTranscriptSegmentSeconds] = useState(300);
  const [resolvedAudioDuration, setResolvedAudioDuration] = useState(0);
  const [mergedEditMode, setMergedEditMode] = useState(false);
  const [mergedDraft, setMergedDraft] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  const [showFinishModal, setShowFinishModal] = useState(false);
  const [showNewConvoModal, setShowNewConvoModal] = useState(false);
  const [showStartConfirmModal, setShowStartConfirmModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);

  useEffect(() => {
    setUserName(getUserName());
  }, []);

  const startedAtRef = useRef<number>(0);
  const sessionIdRef = useRef(0);
  const liveRef = useRef(false);
  const interimRef = useRef("");
  const interimRafRef = useRef<number | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const hasUnsavedRef = useRef(false);

  const stopSmoothProgress = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  // Per-chunk progress: each completed chunk = 100/total. Between completions we
  // gently creep toward the next chunk's boundary so the bar never looks frozen.
  const handleDiarizeProgress = useCallback(
    (done: number, total: number) => {
      const t = total > 0 ? total : 1;
      const base = (done / t) * 100;
      setDiarizeProgress((p) => (base > p ? base : p));
      stopSmoothProgress();
      if (done >= t) return;
      const next = ((done + 1) / t) * 100;
      const startT = Date.now();
      progressTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - startT;
        const frac = elapsed / (elapsed + 30000);
        const val = base + (next - base) * frac;
        setDiarizeProgress((p) => (val > p ? val : p));
      }, 200);
    },
    [stopSmoothProgress],
  );

  const handleAzurePartial = useCallback((text: string) => {
    if (!liveRef.current) return;
    interimRef.current = text;
    if (interimRafRef.current == null) {
      interimRafRef.current = requestAnimationFrame(() => {
        interimRafRef.current = null;
        setInterim(interimRef.current);
      });
    }
  }, []);

  const handleAzureFinal = useCallback((text: string) => {
    if (!liveRef.current) return;
    if (interimRafRef.current != null) {
      cancelAnimationFrame(interimRafRef.current);
      interimRafRef.current = null;
    }
    interimRef.current = "";
    setInterim("");
    setLines((prev) => [...prev, text]);
  }, []);

  // Remembers why a start failed. start() reports through onError and then
  // returns false, and handleStart's own message used to overwrite it -- so
  // the real reason was set and immediately replaced by a generic one,
  // leaving "Couldn't start recording" as the only thing anyone ever saw.
  const startErrorRef = useRef<string | null>(null);

  const handleAzureError = useCallback((msg: string) => {
    if (!msg) return;
    startErrorRef.current = msg;
    setStatusMessage(`⚠️ ${msg}`);
  }, []);

  const {
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
  } = useGlobalRecording();

  useEffect(() => {
    setCallbacks({
      onPartial: handleAzurePartial,
      onFinal: handleAzureFinal,
      onError: handleAzureError,
      onProgress: handleDiarizeProgress,
    });
  }, [
    handleAzurePartial,
    handleAzureFinal,
    handleAzureError,
    handleDiarizeProgress,
    setCallbacks,
  ]);

  useEffect(() => {
    return () => {
      if (interimRafRef.current != null) {
        cancelAnimationFrame(interimRafRef.current);
      }
    };
  }, []);

  const stopLiveEvents = useCallback(() => {
    liveRef.current = false;
    if (interimRafRef.current != null) {
      cancelAnimationFrame(interimRafRef.current);
      interimRafRef.current = null;
    }
    interimRef.current = "";
  }, []);

  const systemStatus =
    statusMessage ??
    (isPaused ? "Paused" : isRecording ? "Listening..." : "Ready");

  /**
   * Word timings for the undiarized transcript view. The diarize path gets real
   * per-word spans from the model, but /transcribe/stream returns text only, so
   * without this the view renders one flat block and nothing can highlight.
   *
   * Anchored per chunk where possible: chunk i covers
   * [i * segmentSeconds, (i+1) * segmentSeconds] clamped to the real length, so
   * the estimate re-syncs to the audio every chunk instead of accumulating
   * drift across the whole file. Live recordings have no chunks, so they fall
   * back to spreading the transcript across the full duration.
   */
  const transcriptWords = useMemo<TranscriptWord[]>(() => {
    if (mergedTranscript.length > 0) return [];
    const duration = resolvedAudioDuration;
    if (!duration || duration <= 0) return [];

    if (transcriptParts.some((p) => p.trim()) && transcriptSegmentSeconds > 0) {
      const out: TranscriptWord[] = [];
      transcriptParts.forEach((part, i) => {
        if (!part.trim()) return;
        const start = Math.min(i * transcriptSegmentSeconds, duration);
        const end = Math.min((i + 1) * transcriptSegmentSeconds, duration);
        if (end <= start) return;
        out.push(...interpolateWords(part, start, end));
      });
      if (out.length > 0) return out;
    }

    return transcriptText.trim()
      ? interpolateWords(transcriptText, 0, duration)
      : [];
  }, [
    mergedTranscript.length,
    transcriptParts,
    transcriptSegmentSeconds,
    transcriptText,
    resolvedAudioDuration,
  ]);

  const activeWordStart = useMemo(() => {
    for (const seg of mergedTranscript) {
      const ws = seg.words;
      if (!ws) continue;
      for (const w of ws) {
        if (currentAudioTime >= w.start && currentAudioTime < w.end) {
          return w.start;
        }
      }
    }
    for (const w of transcriptWords) {
      if (currentAudioTime >= w.start && currentAudioTime < w.end) {
        return w.start;
      }
    }
    return null;
  }, [mergedTranscript, transcriptWords, currentAudioTime]);

  useEffect(() => {
    if (activeWordStart == null) return;
    activeWordRef.current?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [activeWordStart]);

  useEffect(() => {
    if (!isRecording || isPaused) return;
    const id = setInterval(() => {
      setSessionTime(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, [isRecording, isPaused]);

  useEffect(() => {
    const read = () => setMeetingsCount(loadMeetings().length);
    read();
    window.addEventListener(MEETINGS_EVENT, read);
    return () => window.removeEventListener(MEETINGS_EVENT, read);
  }, [view]);

  useEffect(() => {
    hasUnsavedRef.current =
      isRecording ||
      isDiarizing ||
      isUploading ||
      ((mergedTranscript.length > 0 || lines.length > 0) && !isSaved);
  }, [
    isRecording,
    isDiarizing,
    isUploading,
    mergedTranscript.length,
    lines.length,
    isSaved,
  ]);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.onCloseRequested) return;
    return api.onCloseRequested(() => {
      if (hasUnsavedRef.current) setShowCloseModal(true);
      else api.confirmClose?.();
    });
  }, []);

  const saveTranscriptLocally = useCallback(
    async (rows: MergedTranscriptRow[]) => {
      if (!rows.length) return;
      const electron =
        typeof window !== "undefined" ? window.electronAPI : undefined;
      if (!electron?.saveTranscriptLocal) return;
      try {
        const payload = {
          createdAt: new Date().toISOString(),
          merged_transcript: rows,
        };
        await electron.saveTranscriptLocal(payload, "ThreadNotes-Transcript");
      } catch (e) {
        console.warn("Local transcript save failed:", e);
      }
    },
    [],
  );

  const mergedPlainText = useMemo(
    () =>
      mergedTranscript
        .map((r) => `${r.speaker}: ${stripSpeakerPrefix(r.text)}`)
        .join("\n\n"),
    [mergedTranscript],
  );

  // True recorded length for the audio player: WebM blobs report a bogus/short
  // duration, so we hand the player the length we already know (last transcript
  // timestamp, or the live session timer).
  const playbackDurationSec = useMemo(() => {
    const endMax = mergedTranscript.length
      ? Math.round(
          Math.max(0, ...mergedTranscript.map((r) => Number(r.end) || 0)),
        )
      : 0;
    return endMax || sessionTime;
  }, [mergedTranscript, sessionTime]);

  const speakerHex = useMemo(() => {
    const map: Record<string, string> = {};
    mergedTranscript.forEach((r) => {
      if (!(r.speaker in map)) {
        map[r.speaker] = SPEAKER_HEX[Object.keys(map).length % SPEAKER_HEX.length];
      }
    });
    return map;
  }, [mergedTranscript]);

  const rowHasHighlight = (item: MergedTranscriptRow) => {
    if (!highlights.length) return false;
    const rowText = item.words?.length
      ? item.words.map((w) => w.word).join(" ")
      : stripSpeakerPrefix(item.text);
    return highlightRanges(rowText, highlights).length > 0;
  };

  const commitSpeakerRename = (origSpeaker: string) => {
    const name = speakerDraft.trim();
    setEditingSpeakerIdx(null);
    if (!name || name === origSpeaker) return;
    setMergedTranscript((rows) =>
      rows.map((r) => (r.speaker === origSpeaker ? { ...r, speaker: name } : r)),
    );
  };

  useEffect(() => {
    if (mergedTranscript.length === 0) return;
    setCurrentAudioTime(0);
    const el = audioRef.current;
    if (el) {
      el.currentTime = 0;
      el.load();
    }
  }, [mergedTranscript, audioUrl]);

  const toggleMergedEdit = useCallback(() => {
    setMergedEditMode((on) => {
      if (!on) {
        setMergedDraft(mergedPlainText);
        return true;
      }
      const paras = mergedDraft
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (paras.length === mergedTranscript.length) {
        setMergedTranscript((prev) =>
          prev.map((row, i) => {
            const p = paras[i];
            const colon = p.indexOf(":");
            const text = colon >= 0 ? p.slice(colon + 1).trim() : p;
            return { ...row, text };
          }),
        );
      }
      return false;
    });
  }, [mergedDraft, mergedPlainText, mergedTranscript.length]);

  const clearPlayback = useCallback(() => {
    setMergedEditMode(false);
    setMergedTranscript([]);
    setCurrentAudioTime(0);
    setAudioUrl((prev) => {
      if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const handleStart = useCallback(async () => {
    sessionIdRef.current += 1;
    clearPlayback();
    setLines([]);
    setInterim("");
    setMergedTranscript([]);
    setLiveSegments([]);
    setLiveSegmentsUpTo(0);
    setLiveDiariseOn(false);
    lastRunLinesRef.current = -1;
    setTranscriptParts([]);
    setResolvedAudioDuration(0);
    setSessionTime(0);
    setIsSaved(false);
    setAudioFilePath(null);
    setSavedMeetingId(null);
    setUploadFile(null);
    setIsUploadingFile(false);
    setFileUploadPct(0);
    setUploadReady(false);
    setUploadedMediaUrl(null);
    setTranscriptView("diarize");
    setHighlights([]);
    setHighlightsOnly(false);
    setHlButton(null);
    setStatusMessage(null);
    startErrorRef.current = null;
    const ok = await start();
    if (ok) {
      startedAtRef.current = Date.now();
      liveRef.current = true;
      setIsRecording(true);
      setIsPaused(false);
      setStatusMessage("Listening...");
    } else {
      setStatusMessage(
        `⚠️ ${startErrorRef.current || "Couldn't start recording"}`,
      );
    }
  }, [start, clearPlayback]);

  const handlePause = useCallback(() => {
    pause();
    setIsPaused(true);
    setStatusMessage("Paused");
  }, [pause]);

  const handleResume = useCallback(() => {
    startedAtRef.current = Date.now() - sessionTime * 1000;
    resume();
    setIsPaused(false);
    setStatusMessage("Listening...");
  }, [resume, sessionTime]);

  useEffect(() => {
    window.electronAPI?.recorderSetActive?.(isRecording);
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording) return;
    window.electronAPI?.recorderSetState?.({
      timeText: formatTime(sessionTime),
      isPaused,
    });
  }, [isRecording, sessionTime, isPaused]);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.onRecorderAction) return;
    return api.onRecorderAction((action) => {
      if (action === "pause") handlePause();
      else if (action === "resume") handleResume();
      else if (action === "stop") {
        setView("dashboard");
        setShowFinishModal(true);
      }
    });
  }, [handlePause, handleResume]);

  const confirmFinish = useCallback(async () => {
    const sid = sessionIdRef.current;
    stopLiveEvents();
    setShowFinishModal(false);
    setIsRecording(false);
    setIsPaused(false);
    setInterim("");
    setTranscriptView("transcript");
    setMergedTranscript([]);
    setIsSaved(false);
    setIsFinishing(true);
    setFinishProgress(5);
    setStatusMessage("Finishing recording...");
    try {
      const result = await finishRecording((p: number) => {
        if (sid === sessionIdRef.current) {
          setFinishProgress(Math.max(5, Math.round(p * 100)));
        }
      });
      if (sid !== sessionIdRef.current) return;
      // Audio shows immediately (reliable blob URL) — no ffmpeg wait.
      if (result?.audioUrl) {
        setCurrentAudioTime(0);
        setAudioUrl((prev) => {
          if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
          return result.audioUrl;
        });
      }
      if (result?.audioFilePath) setAudioFilePath(result.audioFilePath);
      setFinishProgress(100);
      setIsFinishing(false);
      setStatusMessage(
        "Transcript ready — click Diarise to separate speakers, or Save.",
      );
    } catch (e: any) {
      if (sid !== sessionIdRef.current) return;
      setIsFinishing(false);
      setFinishProgress(0);
      const path = getRecordingFilePath();
      if (path) setAudioFilePath(path);
      setStatusMessage("⚠️ Could not finalize the recording");
    }
  }, [finishRecording, getRecordingFilePath, stopLiveEvents]);

  const handleDiarizeRetry = useCallback(async () => {
    // bgDiarising is checked too: the retry modal can still reach this while a
    // background run is in flight, and two concurrent runs would race to set
    // mergedTranscript.
    if (
      !audioFilePath ||
      isDiarizing ||
      bgDiarising ||
      mergedTranscript.length > 0
    ) {
      setShowDiarizeRetryModal(false);
      return;
    }
    const sid = sessionIdRef.current;
    setShowDiarizeRetryModal(false);
    setDiarizeError(null);

    if (savedMeetingId) {
      const saved = loadMeetings().find((m) => m.id === savedMeetingId);
      if (saved?.diarized && saved.diarized.length > 0) {
        const rows = saved.diarized.map((r) => ({
          speaker: r.speaker,
          text: r.text,
          start: r.start ?? 0,
          end: r.end ?? 0,
          words: r.words,
        })) as MergedTranscriptRow[];
        setMergedTranscript(rows);
        setTranscriptView("diarize");
        setIsSaved(true);
        setStatusMessage("Loaded speakers from your saved meeting.");
        return;
      }
    }

    setIsDiarizing(true);
    setDiarizeProgress(2);
    setStatusMessage("Separating speakers...");
    try {
      const rows = (await diarizeAudioFile(audioFilePath, {
        jwt: localStorage.getItem("token"),
        onProgress: handleDiarizeProgress,
      })) as MergedTranscriptRow[];
      if (sid !== sessionIdRef.current) return;
      stopSmoothProgress();
      setDiarizeProgress(100);
      setMergedTranscript(rows);
      setTranscriptView("diarize");
      setIsSaved(false);
      void saveTranscriptLocally(rows);
      setStatusMessage("Speakers separated — click Save to keep it.");
    } catch (e: any) {
      stopSmoothProgress();
      if (sid !== sessionIdRef.current) return;
      setDiarizeProgress(0);
      const reason = typeof e?.message === "string" ? e.message.trim() : "";
      setDiarizeError(reason || null);
      setStatusMessage(`⚠️ ${reason || "Diarisation failed"}`);
      setShowDiarizeRetryModal(true);
    } finally {
      stopSmoothProgress();
      if (sid === sessionIdRef.current) setIsDiarizing(false);
    }
  }, [
    audioFilePath,
    isDiarizing,
    bgDiarising,
    mergedTranscript.length,
    savedMeetingId,
    stopSmoothProgress,
    handleDiarizeProgress,
    saveTranscriptLocally,
  ]);

  /**
   * Hand the whole recording to the vault as a background job.
   *
   * This uploads every chunk in one request and returns as soon as the server
   * has the audio, so the desktop app -- or the whole laptop -- can be closed
   * straight afterwards. The vault owns the work from that point, writes the
   * result to Cosmos, and the next launch collects it (see the pending-jobs
   * sweep below).
   *
   * An earlier version of this ran diarizeAudioFile in the renderer without
   * setting isDiarizing. That only avoided locking the UI; the work still died
   * with the app, which is not what "in background" means to anyone.
   */
  // Name the job after its opening words, the same shape handleSaveTranscript
  // uses, so a collected result is recognisable in MyMeetings later.
  // lines changes on every recognised phrase; a ref keeps handleDiariseLive
  // stable instead of rebuilding it constantly.
  const linesRef = useRef<string[]>([]);
  linesRef.current = lines;
  isDiarizingRef.current = isDiarizing;

  const liveTailText = useMemo(
    () => lines.slice(liveSegmentsUpTo).join("\n\n"),
    [lines, liveSegmentsUpTo],
  );

  const bgJobTopic = useMemo(() => {
    const words = transcriptText.trim().split(/\s+/).filter(Boolean).slice(0, 6);
    return words.length ? words.join(" ") : "Background diarisation";
  }, [transcriptText]);

  const handleDiariseInBackground = useCallback(async () => {
    if (!audioFilePath || isDiarizing || bgDiarising || mergedTranscript.length > 0) {
      return;
    }
    setDiarizeError(null);
    setBgDiarising(true);
    setStatusMessage("Saving the meeting…");
    try {
      // Save first so the job has a real meeting to attach its speakers to.
      // Without this the collected result had nowhere to go and became a
      // second, audio-less entry sitting beside the original -- two rows for
      // one recording, the diarised one with no player and the original still
      // offering to diarise work that was already done.
      const meetingId =
        savedMeetingId || (await saveTranscriptRef.current?.()) || null;
      if (!meetingId) throw new Error("Could not save this meeting first.");

      setStatusMessage("Uploading audio for background diarisation…");
      await createDiariseJob(audioFilePath, {
        jwt: localStorage.getItem("token"),
        topic: bgJobTopic,
        meetingId,
        durationSec: playbackDurationSec || sessionTime || 0,
      });
      setStatusMessage(
        "Diarising in the background — you can close the app. " +
          "The speakers will be waiting in MyMeetings.",
      );
    } catch (e: any) {
      const reason = typeof e?.message === "string" ? e.message.trim() : "";
      // No retry modal: it would seize the screen the user asked to keep using.
      setStatusMessage(
        `⚠️ ${reason || "Could not start the background job"} — you can try Diarise again.`,
      );
    } finally {
      setBgDiarising(false);
    }
  }, [
    audioFilePath,
    isDiarizing,
    bgDiarising,
    mergedTranscript.length,
    savedMeetingId,
    bgJobTopic,
    playbackDurationSec,
    sessionTime,
  ]);

  /**
   * Collect finished background jobs, once per launch.
   *
   * Results are written into the meeting store rather than the live view: by
   * the time a job lands the user is usually somewhere else entirely, and
   * overwriting whatever is on screen would destroy unrelated work. A job is
   * only acked after its rows are stored, so a crash mid-save leaves it
   * pending and it is collected again next time.
   */
  useEffect(() => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) return;
    let cancelled = false;

    (async () => {
      const jobs = await fetchPendingJobs(token).catch(() => []);
      if (cancelled || jobs.length === 0) return;

      let collected = 0;
      let failed = 0;
      for (const job of jobs) {
        if (job.status === "queued" || job.status === "processing") continue;

        if (job.status === "failed") {
          failed += 1;
          await ackJob(job.job_id, token);
          continue;
        }

        const rows = job.segments ?? [];
        if (rows.length === 0) {
          await ackJob(job.job_id, token);
          continue;
        }

        try {
          // Attach to the meeting the job was started from, so one recording
          // stays one row: it keeps its audio (and therefore its player) and
          // simply gains speakers. Only fall back to creating a row if that
          // meeting is gone -- otherwise the result would be lost.
          const existing = job.meeting_id
            ? loadMeetings().find((m) => m.id === job.meeting_id)
            : undefined;

          if (existing) {
            updateMeeting(existing.id, {
              diarized: rows,
              plainText: existing.plainText || rows.map((r) => r.text).join("\n\n"),
            });
          } else {
            addMeeting({
              id: job.meeting_id || `job-${job.job_id}`,
              topic: job.topic || "Background diarisation",
              date:
                job.completed_at || job.created_at || new Date().toISOString(),
              transcript: rows.map((r) => ({
                speaker: r.speaker,
                text: r.text,
                timestamp: "",
              })),
              durationSec: job.duration_sec || 0,
              plainText: rows.map((r) => r.text).join("\n\n"),
              diarized: rows,
            } as any);
          }
          collected += 1;
          await ackJob(job.job_id, token);
        } catch {
          // Leave it unacked so the next launch retries.
        }
      }

      if (cancelled) return;
      if (collected > 0) {
        setStatusMessage(
          collected === 1
            ? "A background diarisation finished — it is in MyMeetings."
            : `${collected} background diarisations finished — they are in MyMeetings.`,
        );
      } else if (failed > 0) {
        setStatusMessage(
          "A background diarisation did not finish. Please run it again.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Separate the speakers for what has been said so far, mid-recording.
   *
   * Diarisation needs a file and the session's own recording is not written
   * until it finishes, so this works from a throwaway snapshot of the buffered
   * audio. Recording is never interrupted: the mic keeps running and the final
   * recording still covers the whole session.
   *
   * Results go to mergedTranscript, which switches the panel to the speaker
   * view. Pressing it again later re-runs over the longer audio, so speakers
   * stay in step with a conversation that is still going.
   */
  const runLiveDiarisation = useCallback(async (announce: boolean) => {
    // Guarded by a ref, not by the liveDiarising state.
    //
    // This is the reason diarisation appeared to stop after the first pass.
    // liveDiarising flips true then false on every pass, so with it in this
    // callback's dependency list the callback was rebuilt twice per pass. The
    // refresh effect depends on this callback, so each rebuild tore down the
    // interval and started a fresh one -- the countdown restarted from zero
    // every time a pass finished, and nothing else could ever schedule work.
    // The ref keeps this callback stable, so the timer survives.
    if (liveDiarisingRef.current || isDiarizingRef.current) return;
    liveDiarisingRef.current = true;
    setLiveDiarising(true);
    if (announce) setStatusMessage("Separating speakers so far…");
    try {
      const snapshotPath = await snapshotAudioToFile();
      // Captured here, not after diarisation: the snapshot fixes the audio
      // boundary, and anything recognised while the model runs belongs to
      // the tail.
      const coveredLines = linesRef.current.length;
      // Mark the attempt now, not on success. Otherwise a pass that fails or
      // finds no speech would leave the marker behind and the poll would retry
      // it every few seconds forever. A later pass still happens as soon as
      // new speech is recognised, which is the only thing worth retrying for.
      lastRunLinesRef.current = coveredLines;
      if (!snapshotPath) {
        if (announce) setStatusMessage("Nothing recorded yet to separate.");
        return;
      }
      const rows = (await diarizeAudioFile(snapshotPath, {
        jwt: localStorage.getItem("token"),
        onProgress: handleDiarizeProgress,
      })) as MergedTranscriptRow[];
      stopSmoothProgress();
      if (rows.length === 0) {
        if (announce) setStatusMessage("No speech found in the recording so far.");
        return;
      }
      // Each run diarises the whole recording from the start, so replacing the
      // previous result is what keeps speakers consistent and cannot duplicate
      // segments -- appending would do both.
      setLiveSegments(rows);
      // Only a SUCCESSFUL pass moves the tail boundary, so a failure leaves
      // everything since the last good result visible as plain text rather
      // than silently swallowing it.
      setLiveSegmentsUpTo(coveredLines);
      if (announce) {
        setStatusMessage(
          "Separating speakers as you record — press Transcribe for plain text.",
        );
      }
    } catch (e: any) {
      stopSmoothProgress();
      const reason = typeof e?.message === "string" ? e.message.trim() : "";
      // A failed refresh must not wipe the speakers already on screen, and a
      // background refresh must not shout about it.
      if (announce) {
        setStatusMessage(`⚠️ ${reason || "Could not separate speakers yet"}`);
      }
    } finally {
      stopSmoothProgress();
      setDiarizeProgress(0);
      liveDiarisingRef.current = false;
      setLiveDiarising(false);
    }
  }, [snapshotAudioToFile, handleDiarizeProgress, stopSmoothProgress]);

  /** The button: start separating, or go back to plain text. */
  const handleToggleLiveDiarise = useCallback(() => {
    if (liveDiariseOn) {
      // Plain-text view. liveSegments are kept, so switching back is instant
      // and costs nothing.
      setLiveDiariseOn(false);
      setStatusMessage("Showing the plain transcript.");
      return;
    }
    setLiveDiariseOn(true);
    void runLiveDiarisation(true);
  }, [liveDiariseOn, runLiveDiarisation]);

  /**
   * Keep the speakers current while the recording continues.
   *
   * The button used to be one-shot, which is why diarisation appeared to stop
   * at the moment it was pressed. Each pass re-runs over the whole recording
   * so far -- including everything said before the click -- and replaces the
   * previous result, so nothing is duplicated and speaker numbering stays
   * consistent within a pass.
   *
   * A pass is skipped when no new final line has been recognised since the
   * last one, so silence costs nothing.
   */
  useEffect(() => {
    if (!liveDiariseOn || !isRecording) return;
    const id = setInterval(() => {
      // Nothing new said, or a pass already running: do nothing.
      if (linesRef.current.length === lastRunLinesRef.current) return;
      if (liveDiarisingRef.current) return;
      void runLiveDiarisation(false);
    }, LIVE_DIARISE_POLL_MS);
    return () => clearInterval(id);
  }, [liveDiariseOn, isRecording, runLiveDiarisation]);

  /**
   * Final pass once recording stops.
   *
   * The last few seconds are always spoken after the previous pass, so without
   * this they would sit in the tail forever and the finished result would be
   * missing its ending.
   */
  useEffect(() => {
    if (isRecording || !liveDiariseOn) return;
    if (linesRef.current.length === lastRunLinesRef.current) return;
    void runLiveDiarisation(false);
  }, [isRecording, liveDiariseOn, runLiveDiarisation]);

  // Close the Diarise dropdown on an outside click or Escape.
  useEffect(() => {
    if (!showDiariseMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!diariseMenuRef.current?.contains(e.target as Node)) {
        setShowDiariseMenu(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowDiariseMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showDiariseMenu]);

  // File just selected — reset state and wait for the user to click Upload.
  const handleSelectUploadFile = useCallback((file: File) => {
    setUploadFile(file);
    setUploadReady(false);
    setUploadedMediaUrl(null);
    setIsUploadingFile(false);
    setFileUploadPct(0);
    setStatusMessage(null);
  }, []);

  // Upload click → persist a durable media:// audio, streaming real progress to
  // the bottom bar. On done we mark ready ("Upload completed"); the button then
  // becomes Process, and the bottom bar disappears.
  const handleUploadFile = useCallback(async () => {
    if (!uploadFile || isUploadingFile || uploadReady) return;
    sessionIdRef.current += 1;
    const sid = sessionIdRef.current;
    clearPlayback();
    setLines([]);
    setInterim("");
    setMergedTranscript([]);
    setLiveSegments([]);
    setLiveSegmentsUpTo(0);
    setLiveDiariseOn(false);
    lastRunLinesRef.current = -1;
    setTranscriptParts([]);
    setResolvedAudioDuration(0);
    setIsSaved(false);
    setIsUploading(false);
    setUploadProgress(0);
    setTranscriptView("transcript");
    setCurrentAudioTime(0);

    const electron =
      typeof window !== "undefined" ? window.electronAPI : undefined;
    const localPath = electron?.getPathForFile?.(uploadFile) || "";
    setAudioFilePath(localPath || null);

    if (!electron?.persistUploadAudio || !localPath) {
      setUploadReady(true);
      setStatusMessage("Ready to process.");
      return;
    }

    setIsUploadingFile(true);
    setFileUploadPct(0);
    setStatusMessage("Uploading file…");
    const unsub = electron.onUploadProgress
      ? electron.onUploadProgress((pct) => {
          if (sid === sessionIdRef.current) setFileUploadPct(pct);
        })
      : undefined;
    try {
      const mediaUrl = await electron
        .persistUploadAudio(localPath)
        .then((r) => r.mediaUrl)
        .catch(() => null);
      if (sid !== sessionIdRef.current) return;
      setUploadedMediaUrl(mediaUrl);
      setUploadReady(true);
      setStatusMessage("Upload completed");
    } catch {
      if (sid === sessionIdRef.current) setStatusMessage("⚠️ Upload failed");
    } finally {
      unsub?.();
      // Reset the bar's value; it only shows while uploading, so it disappears.
      if (sid === sessionIdRef.current) {
        setIsUploadingFile(false);
        setFileUploadPct(0);
      }
    }
  }, [uploadFile, isUploadingFile, uploadReady, clearPlayback]);

  // Process click → transcribe the already-uploaded file. Progress shows in the
  // status bar (parallel chunks, real per-chunk progress).
  const handleProcessUpload = useCallback(async () => {
    if (!uploadFile || !uploadReady || isUploadingFile) return;
    const sid = sessionIdRef.current;
    const token = localStorage.getItem("token");
    const electron =
      typeof window !== "undefined" ? window.electronAPI : undefined;
    const localPath =
      audioFilePath || electron?.getPathForFile?.(uploadFile) || "";

    if (!electron?.audioCompressAndRead || !localPath) {
      setStatusMessage(
        "Audio processing is only available in the desktop app.",
      );
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setTranscriptView("transcript");
    setStatusMessage("Transcribing…");
    try {
      const { text, parts, segmentSeconds } = await transcribeAudioFile(
        localPath,
        {
          jwt: token,
          onProgress: (doneN, total) => {
            if (total > 0 && sid === sessionIdRef.current) {
              setUploadProgress(Math.round((doneN / total) * 100));
            }
          },
        },
      );
      if (sid !== sessionIdRef.current) return;
      setAudioUrl(uploadedMediaUrl || URL.createObjectURL(uploadFile));
      setLines(text.trim() ? [text.trim()] : []);
      setTranscriptParts(parts);
      setTranscriptSegmentSeconds(segmentSeconds);
      setMergedTranscript([]);
      setTranscriptView("transcript");
      setActiveTab("live");
      setStatusMessage(
        text.trim()
          ? "Transcript ready — click Diarise to separate speakers."
          : "No speech detected in the uploaded file.",
      );
    } catch (e: any) {
      if (sid !== sessionIdRef.current) return;
      setStatusMessage(e?.message || "Could not process the file.");
    } finally {
      if (sid === sessionIdRef.current) {
        setIsUploading(false);
        setUploadProgress(0);
      }
    }
  }, [uploadFile, uploadReady, isUploadingFile, audioFilePath, uploadedMediaUrl]);

  // Copy the open view: diarize -> "Speaker: text" blocks; transcript -> plain.
  const handleCopyTranscript = useCallback(async () => {
    const text =
      transcriptView === "diarize" && mergedTranscript.length > 0
        ? mergedTranscript
            .map((item) => `${item.speaker}: ${stripSpeakerPrefix(item.text)}`)
            .join("\n\n")
        : transcriptText;
    if (!text.trim()) return;
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text.trim());
        ok = true;
      }
    } catch {}
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text.trim();
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {}
    }
    setStatusMessage(ok ? "Copied to clipboard" : "Copy failed");
  }, [transcriptView, mergedTranscript, transcriptText]);

  const handleSaveTranscript = useCallback(async (): Promise<
    string | null
  > => {
    if (!transcriptText.trim() && mergedTranscript.length === 0) return null;
    const sid = sessionIdRef.current;
    const kind = transcriptView === "diarize" ? "Diarised" : "Transcript";
    const baseName = `ThreadNotes_${kind}_${new Date().toISOString().slice(0, 10)}`;
    const savedText =
      transcriptView === "diarize" && mergedTranscript.length > 0
        ? mergedTranscript
            .map((item) => `${item.speaker}: ${stripSpeakerPrefix(item.text)}`)
            .join("\n\n")
        : transcriptText;

    let savedFilePath: string | undefined;
    let savedName: string | undefined;

    setIsSaving(true);
    setSaveProgress(5);
    setStatusMessage("Saving…");

    try {
      if (
        typeof window !== "undefined" &&
        window.electronAPI?.saveTranscriptLocal
      ) {
        // Auto-save straight into the ThreadNotes folder (Documents/ThreadNotes)
        // — no OS dialog. MyMeetings' Export button keeps the pick-a-location
        // dialog for when users want to send a copy elsewhere.
        const result = await window.electronAPI.saveTranscriptLocal(
          savedText,
          baseName,
          "txt",
        );
        savedFilePath = result?.filePath;
        if (savedFilePath) {
          savedName = savedFilePath
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.[^.]+$/, "");
        }
      } else {
        const blob = new Blob([savedText], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${baseName}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      }

      const entries =
        mergedTranscript.length > 0
          ? mergedTranscript.map((item) => ({
              speaker: item.speaker,
              text: stripSpeakerPrefix(item.text),
              timestamp: "",
            }))
          : lines.map((l) => ({ speaker: "Speaker", text: l, timestamp: "" }));
      const firstWords =
        entries[0]?.text.split(" ").slice(0, 5).join(" ") || "Discussion";
      // sessionTime is the live recording timer, which is 0 for an uploaded
      // file. Without the player's resolved length in this chain, uploading a
      // 30 minute file and transcribing it without diarising recorded a
      // duration of zero -- and so reported no usage at all.
      const durationSec =
        mergedTranscript.length > 0
          ? Math.round(
              Math.max(0, ...mergedTranscript.map((r) => Number(r.end) || 0)),
            )
          : Math.round(resolvedAudioDuration || sessionTime || 0);
      const diarized =
        mergedTranscript.length > 0
          ? mergedTranscript.map((item) => ({
              speaker: item.speaker,
              text: stripSpeakerPrefix(item.text),
              start: item.start,
              end: item.end,
              words: item.words,
            }))
          : undefined;
      const recordedPath = audioFilePath || getRecordingFilePath();
      // Playback audio is a blob during the session; on save, remux the raw file
      // to a durable media:// URL so it also plays back in MyMeetings.
      let audioMediaUrl =
        audioUrl && audioUrl.startsWith("media://") ? audioUrl : undefined;
      if (
        !audioMediaUrl &&
        recordedPath &&
        typeof window !== "undefined" &&
        window.electronAPI?.remuxAudio
      ) {
        // Remuxing the raw recording is the slow part of Save — stream its real
        // ffmpeg progress to the status bar so the user sees it working.
        const unsub = window.electronAPI.onSaveProgress
          ? window.electronAPI.onSaveProgress((pct) => {
              setSaveProgress(Math.max(5, Math.min(99, pct)));
            })
          : undefined;
        try {
          const { mediaUrl } = await window.electronAPI.remuxAudio(
            recordedPath,
            durationSec,
          );
          audioMediaUrl = mediaUrl;
        } catch {
          audioMediaUrl = undefined;
        } finally {
          unsub?.();
        }
      }
      setSaveProgress(100);
      const record = {
        id: Date.now().toString(),
        topic: savedName || `Meeting on ${firstWords}`,
        date: new Date().toISOString(),
        transcript: entries,
        filePath: savedFilePath,
        durationSec,
        plainText: transcriptText,
        diarized,
        audioPath: recordedPath || undefined,
        audioMediaUrl,
        highlights: highlights.length ? highlights : undefined,
        highlightsShown: showHighlights,
      };
      // Always persist the meeting, even if the user moved on to a new session.
      addMeeting(record);
      // Report the length once, here, because this is the one place a
      // recording is finished and its duration is known.
      void reportUsageSeconds(durationSec, localStorage.getItem("token"));
      // …but only touch the live UI if we're still on the same session.
      if (sid === sessionIdRef.current) {
        setSavedMeetingId(record.id);
        setIsSaved(true);
        setStatusMessage("✅ Saved!");
      }
      return record.id;
    } catch {
      if (sid === sessionIdRef.current) setStatusMessage("⚠️ Save failed");
      return null;
    } finally {
      if (sid === sessionIdRef.current) {
        setIsSaving(false);
        setSaveProgress(0);
      }
    }
  }, [
    transcriptText,
    mergedTranscript,
    transcriptView,
    lines,
    sessionTime,
    audioFilePath,
    audioUrl,
    highlights,
    showHighlights,
    getRecordingFilePath,
  ]);

  saveTranscriptRef.current = handleSaveTranscript;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        if (mergedTranscript.length > 0 && !isDiarizing) {
          e.preventDefault();
          void handleSaveTranscript();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mergedTranscript.length, isDiarizing, handleSaveTranscript]);

  const doReset = useCallback(() => {
    sessionIdRef.current += 1;
    stopLiveEvents();
    cancel();
    if (uploadAbortRef.current) {
      try {
        uploadAbortRef.current.abort();
      } catch {}
      uploadAbortRef.current = null;
    }
    stopSmoothProgress();
    clearPlayback();
    setIsRecording(false);
    setIsPaused(false);
    setIsDiarizing(false);
    setDiarizeProgress(0);
    setIsUploading(false);
    setUploadProgress(0);
    setIsUploadingFile(false);
    setFileUploadPct(0);
    setUploadReady(false);
    setUploadedMediaUrl(null);
    setSessionTime(0);
    setLines([]);
    setInterim("");
    setMergedTranscript([]);
    setLiveSegments([]);
    setLiveSegmentsUpTo(0);
    setLiveDiariseOn(false);
    lastRunLinesRef.current = -1;
    setTranscriptParts([]);
    setResolvedAudioDuration(0);
    setUploadFile(null);
    setStatusMessage(null);
    setIsSaved(false);
    setAudioFilePath(null);
    setSavedMeetingId(null);
    setTranscriptView("diarize");
    setHighlights([]);
    setHighlightsOnly(false);
    setHlButton(null);
    setShowDiarizeRetryModal(false);
    setDiarizeError(null);
    setActiveTab("live");
    setView("dashboard");
  }, [cancel, clearPlayback, stopLiveEvents, stopSmoothProgress]);

  // Guard the Start button: if there's a recording being finished/saved, or an
  // unsaved transcript/audio on screen, confirm before discarding it.
  const handleStartClick = useCallback(() => {
    const hasUnsaved =
      isFinishing ||
      isSaving ||
      isDiarizing ||
      isUploading ||
      isUploadingFile ||
      ((!!audioUrl || lines.length > 0 || mergedTranscript.length > 0) &&
        !isSaved);
    if (hasUnsaved) {
      setShowStartConfirmModal(true);
    } else {
      void handleStart();
    }
  }, [
    isFinishing,
    isSaving,
    isDiarizing,
    isUploading,
    isUploadingFile,
    audioUrl,
    lines.length,
    mergedTranscript.length,
    isSaved,
    handleStart,
  ]);

  const handleNewConversationClick = useCallback(() => {
    if (
      isRecording ||
      isDiarizing ||
      isUploading ||
      lines.length > 0 ||
      mergedTranscript.length > 0
    ) {
      setShowNewConvoModal(true);
    } else {
      doReset();
    }
  }, [
    isRecording,
    isDiarizing,
    isUploading,
    lines.length,
    mergedTranscript.length,
    doReset,
  ]);

  const handleLogout = useCallback(() => {
    stopLiveEvents();
    if (isRecording) cancel();
    clearSession();
    router.push("/auth");
  }, [isRecording, cancel, router, stopLiveEvents]);

  const handleDeleteAccount = useCallback(async () => {
    if (!deletePassword) {
      setDeleteError("Please enter your password to confirm.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/delete-account`, {
        method: "DELETE",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirm_password: deletePassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to delete account");
      }
      stopLiveEvents();
      if (isRecording) cancel();
      localStorage.clear();
      router.replace("/auth");
    } catch (e: any) {
      setDeleting(false);
      setDeleteError(e?.message || "Delete failed");
    }
  }, [isRecording, cancel, router, stopLiveEvents, deletePassword]);

  const closeDeleteModal = useCallback(() => {
    setShowDeleteModal(false);
    setDeletePassword("");
    setDeleteError(null);
  }, []);

  const handleTranscriptEdit = useCallback((text: string) => {
    setLines(text ? [text] : []);
    setInterim("");
  }, []);

  const handleTranscriptMouseUp = useCallback(() => {
    if (transcriptView !== "diarize") {
      setHlButton(null);
      return;
    }
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    const text = sel?.toString().trim() ?? "";
    if (!sel || sel.rangeCount === 0 || text.length < 2) {
      setHlButton(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setHlButton({ x: rect.left + rect.width / 2, y: rect.top, text });
  }, [transcriptView]);

  const isHighlighted = useCallback(
    (text: string) =>
      highlights.some(
        (h) => h === text || h.includes(text) || text.includes(h),
      ),
    [highlights],
  );

  const addHighlight = useCallback(() => {
    const text = hlButton?.text;
    if (!text) return;
    setHighlights((prev) => {
      const already = prev.some(
        (h) => h === text || h.includes(text) || text.includes(h),
      );
      return already
        ? prev.filter(
            (h) => !(h === text || h.includes(text) || text.includes(h)),
          )
        : [...prev, text];
    });
    setShowHighlights(true);
    setHlButton(null);
    window.getSelection?.()?.removeAllRanges();
  }, [hlButton]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50 text-slate-800">
      <Sidebar
        className="hidden w-64 lg:flex"
        activeView={view}
        onNavigate={setView}
        meetingsCount={meetingsCount}
        userName={userName}
        onLogout={() => setShowLogoutModal(true)}
        onDeleteAccount={() => setShowDeleteModal(true)}
      />

      <MobileSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeView={view}
        onNavigate={setView}
        meetingsCount={meetingsCount}
        userName={userName}
        onLogout={() => setShowLogoutModal(true)}
        onDeleteAccount={() => setShowDeleteModal(true)}
      />

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <AmbientGlow />

        <header className="relative z-20 flex shrink-0 items-center gap-3 border-b border-white/60 bg-white/50 px-4 py-3 backdrop-blur-xl lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-600 transition-colors hover:bg-white/70 hover:text-slate-900"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="flex items-center gap-2 text-base font-bold tracking-tight text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-violet-500 to-blue-500 shadow-sm shadow-violet-500/30">
              <FileText className="h-4 w-4 text-white" strokeWidth={2.2} />
            </span>
            ThreadNotes
          </span>
        </header>

        {view === "dashboard" ? (
          <div className="custom-scrollbar relative z-10 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 lg:gap-4 lg:py-4">
            <div className="flex shrink-0 flex-wrap items-end justify-between gap-4 lg:mt-4">
              <div>
                <h2 className="text-2xl font-bold tracking-tight text-slate-900">
                  Capture &amp; Analysis
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Record live audio or upload a meeting file to generate
                  structured transcripts instantly.
                </p>
              </div>
              <button
                onClick={handleNewConversationClick}
                className="flex items-center gap-2 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600 active:scale-[0.98]"
              >
                <Plus className="h-4 w-4" strokeWidth={2.5} />
                New Conversation
              </button>
            </div>

            <div className="flex w-full flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row">
              <div className="flex min-h-[22rem] w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto lg:h-full lg:min-h-0 lg:w-1/2">
                <CaptureControls
                  isRecording={isRecording}
                  isPaused={isPaused}
                  sessionTime={sessionTime}
                  activeTab={activeTab}
                  systemStatus={systemStatus}
                  isDiarizing={isDiarizing}
                  diarizeProgress={diarizeProgress}
                  isFinishing={isFinishing}
                  finishProgress={finishProgress}
                  isSaving={isSaving}
                  saveProgress={saveProgress}
                  isCompleted={
                    !isRecording &&
                    !isDiarizing &&
                    !isUploading &&
                    !isUploadingFile &&
                    (!!audioUrl ||
                      lines.length > 0 ||
                      mergedTranscript.length > 0)
                  }
                  onStart={handleStartClick}
                  onPause={handlePause}
                  onResume={handleResume}
                  onStop={() => setShowFinishModal(true)}
                  onTabChange={setActiveTab}
                  uploadFile={uploadFile}
                  isUploading={isUploading}
                  uploadProgress={uploadProgress}
                  isUploadingFile={isUploadingFile}
                  fileUploadPct={fileUploadPct}
                  uploadReady={uploadReady}
                  onSelectFile={handleSelectUploadFile}
                  onUploadFile={handleUploadFile}
                  onProcessUpload={handleProcessUpload}
                  micLabel={micLabel}
                  detectedLanguage={detectedLanguage}
                  audioQuality={audioQuality}
                />
              </div>
              <div className="flex min-h-[22rem] w-full min-w-0 flex-col lg:h-full lg:min-h-0 lg:w-1/2">
                {mergedTranscript.length > 0 || audioUrl ? (
                  <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/60 bg-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.06)] backdrop-blur-xl">
                    <div className="flex items-center justify-between bg-linear-to-r from-violet-500 to-blue-500 px-6 py-4">
                      <h3 className="text-base font-bold text-white">
                        Playback &amp; Transcript
                      </h3>
                      <div className="flex items-center gap-2">
                        {transcriptView === "diarize" && (
                          <button
                            onClick={() => setHighlightsOnly((v) => !v)}
                            aria-label={
                              highlightsOnly
                                ? "Show full transcript"
                                : "Show only highlights"
                            }
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg ring-1 ring-white/30 transition-colors ${
                              highlightsOnly
                                ? "bg-white text-[#2E6DBE]"
                                : "bg-white/20 text-white hover:bg-white/30"
                            }`}
                          >
                            <Highlighter className="h-4 w-4" />
                            <span className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover:block">
                              {highlightsOnly ? "Show all" : "Only highlights"}
                            </span>
                          </button>
                        )}
                        {!mergedEditMode &&
                          (transcriptText.trim() ||
                            mergedTranscript.length > 0) && (
                            <button
                              onClick={handleCopyTranscript}
                              aria-label="Copy content"
                              className="group relative flex h-9 w-9 items-center justify-center rounded-lg bg-white/20 text-white ring-1 ring-white/30 transition-colors hover:bg-white/30"
                            >
                              <Copy className="h-4 w-4" />
                              <span className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover:block">
                                Copy
                              </span>
                            </button>
                          )}
                        <button
                          onClick={toggleMergedEdit}
                          aria-label={mergedEditMode ? "Done" : "Edit"}
                          className="group relative flex h-9 w-9 items-center justify-center rounded-lg bg-white/20 text-white ring-1 ring-white/30 transition-colors hover:bg-white/30"
                        >
                          {mergedEditMode ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Pencil className="h-4 w-4" />
                          )}
                          <span className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover:block">
                            {mergedEditMode ? "Done" : "Edit"}
                          </span>
                        </button>
                        <button
                          onClick={handleSaveTranscript}
                          disabled={mergedEditMode}
                          aria-label="Save"
                          className="group relative flex h-9 w-9 items-center justify-center rounded-lg bg-white/20 text-white ring-1 ring-white/30 transition-colors hover:bg-white/30 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Save className="h-4 w-4" />
                          <span className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover:block">
                            Save
                          </span>
                        </button>
                      </div>
                    </div>

                    {audioUrl && !mergedEditMode && (
                      <div className="shrink-0 border-b border-white/60 bg-white/40 px-6 py-4">
                        <AudioPlayer
                          src={audioUrl}
                          audioRef={audioRef}
                          onTimeUpdate={setCurrentAudioTime}
                          onDuration={setResolvedAudioDuration}
                          durationSec={playbackDurationSec}
                        />
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <p className="bg-linear-to-r from-indigo-500 to-blue-500 bg-clip-text text-[11px] font-semibold uppercase tracking-widest text-transparent">
                            Play to highlight the transcript in sync
                          </p>
                          {mergedTranscript.length === 0 ? (
                            <div
                              className="relative shrink-0"
                              ref={diariseMenuRef}
                            >
                              <button
                                onClick={() =>
                                  setShowDiariseMenu((v) => !v)
                                }
                                disabled={
                                  isDiarizing || bgDiarising || !audioFilePath
                                }
                                aria-haspopup="menu"
                                aria-expanded={showDiariseMenu}
                                className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE] px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:from-[#28a29a] hover:to-[#2a61a8] disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {isDiarizing
                                  ? "Diarising…"
                                  : bgDiarising
                                    ? "Uploading…"
                                    : "Diarise"}
                                <ChevronDown
                                  className={`h-3.5 w-3.5 transition-transform ${
                                    showDiariseMenu ? "rotate-180" : ""
                                  }`}
                                />
                              </button>

                              {showDiariseMenu && (
                                <div
                                  role="menu"
                                  className="absolute right-0 top-full z-30 mt-1.5 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl"
                                >
                                  <button
                                    role="menuitem"
                                    onClick={() => {
                                      setShowDiariseMenu(false);
                                      void handleDiarizeRetry();
                                    }}
                                    className="block w-full px-3 py-2 text-left transition-colors hover:bg-slate-50"
                                  >
                                    <span className="block text-xs font-semibold text-slate-700">
                                      Diarise now
                                    </span>
                                    <span className="mt-0.5 block text-[10px] leading-snug text-slate-400">
                                      Locks recording and upload until it
                                      finishes
                                    </span>
                                  </button>
                                  <button
                                    role="menuitem"
                                    onClick={() => {
                                      setShowDiariseMenu(false);
                                      void handleDiariseInBackground();
                                    }}
                                    className="block w-full px-3 py-2 text-left transition-colors hover:bg-slate-50"
                                  >
                                    <span className="block text-xs font-semibold text-slate-700">
                                      Diarise in background
                                    </span>
                                    <span className="mt-0.5 block text-[10px] leading-snug text-slate-400">
                                      Runs on the server — you can close the
                                      app and collect it later
                                    </span>
                                  </button>
                                </div>
                              )}
                            </div>
                          ) : transcriptText ? (
                            <button
                              onClick={() =>
                                setTranscriptView((v) =>
                                  v === "diarize" ? "transcript" : "diarize",
                                )
                              }
                              className="shrink-0 rounded-lg bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE] px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:from-[#28a29a] hover:to-[#2a61a8]"
                            >
                              {/* Label names the view you get by clicking, so it
                                  flips each time: on the transcript it offers
                                  "Diarise", on the diarised view "Transcript". */}
                              {transcriptView === "diarize"
                                ? "Transcript"
                                : "Diarise"}
                            </button>
                          ) : (
                            <span className="shrink-0 rounded-lg bg-slate-100 px-4 py-1.5 text-xs font-semibold text-slate-500 shadow-sm">
                              Diarised
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    <div
                      ref={transcriptScrollRef}
                      onMouseUp={handleTranscriptMouseUp}
                      onScroll={() => setHlButton(null)}
                      className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-6"
                    >
                      {highlightsOnly && highlights.length === 0 ? (
                        <p className="text-sm text-slate-400">
                          No highlights yet — select text and click Highlight.
                        </p>
                      ) : !highlightsOnly && transcriptView === "transcript" ? (
                        <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">
                          {(() => {
                            // Karaoke in transcript view too: if diarized words
                            // exist, flatten them and highlight the spoken word.
                            const diarizedWords = mergedTranscript.flatMap(
                              (r) => r.words ?? [],
                            );
                            // Fall back to the interpolated timings so the
                            // plain transcript highlights too, not just the
                            // diarized view.
                            const allWords = diarizedWords.length
                              ? diarizedWords
                              : transcriptWords;
                            if (allWords.length > 0) {
                              const rowText = allWords
                                .map((w) => w.word)
                                .join(" ");
                              const hlRanges =
                                showHighlights && highlights.length
                                  ? highlightRanges(rowText, highlights)
                                  : [];
                              const wordStarts: number[] = [];
                              let acc = 0;
                              for (const w of allWords) {
                                wordStarts.push(acc);
                                acc += w.word.length + 1;
                              }
                              return allWords.map((w, wi) => {
                                const isActive =
                                  currentAudioTime >= w.start &&
                                  currentAudioTime < w.end;
                                const wStart = wordStarts[wi];
                                const wEnd = wStart + w.word.length;
                                const isHl = hlRanges.some(
                                  ([s, e]) => wStart < e && wEnd > s,
                                );
                                return (
                                  <span
                                    key={wi}
                                    ref={isActive ? activeWordRef : null}
                                    className={
                                      isActive
                                        ? "rounded-md bg-indigo-100 px-1 py-0.5 font-bold text-indigo-700 shadow-sm ring-1 ring-indigo-200 transition-all duration-150"
                                        : isHl
                                          ? "rounded bg-amber-200/70 px-0.5 transition-all duration-150"
                                          : "transition-all duration-150"
                                    }
                                  >
                                    {w.word}{" "}
                                  </span>
                                );
                              });
                            }
                            return transcriptText ? (
                              <HighlightedText
                                text={transcriptText}
                                phrases={highlights}
                                enabled={showHighlights}
                              />
                            ) : (
                              "No transcript captured."
                            );
                          })()}
                        </div>
                      ) : !highlightsOnly && mergedEditMode ? (
                        <textarea
                          value={mergedDraft}
                          onChange={(e) => setMergedDraft(e.target.value)}
                          placeholder="Edit the transcript..."
                          className="h-full min-h-[300px] w-full resize-none rounded-xl border border-slate-200 bg-white/80 p-4 text-[15px] leading-relaxed text-slate-700 outline-none focus:ring-2 focus:ring-violet-500/40"
                        />
                      ) : (
                        <div className="space-y-3">
                          {(highlightsOnly
                            ? mergedTranscript.filter(rowHasHighlight)
                            : mergedTranscript
                          ).map((item, index) => {
                            const speakerLine =
                              speakerHex[item.speaker] || "#94A3B8";
                            const words = item.words ?? [];
                            const rowText = words.map((w) => w.word).join(" ");
                            const hlRanges =
                              showHighlights && highlights.length && words.length
                                ? highlightRanges(rowText, highlights)
                                : [];
                            const wordStarts: number[] = [];
                            let acc = 0;
                            for (const w of words) {
                              wordStarts.push(acc);
                              acc += w.word.length + 1;
                            }

                            return (
                              <div
                                key={`${item.speaker}-${item.start}-${index}`}
                                className="rounded-xl border border-l-4 border-white/40 bg-white/40 px-4 py-3"
                                style={{ borderLeftColor: speakerLine }}
                              >
                                <div className="mb-1 flex items-center gap-3">
                                  {editingSpeakerIdx === index ? (
                                    <input
                                      autoFocus
                                      value={speakerDraft}
                                      onChange={(e) =>
                                        setSpeakerDraft(e.target.value)
                                      }
                                      onBlur={() =>
                                        commitSpeakerRename(item.speaker)
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                          commitSpeakerRename(item.speaker);
                                        if (e.key === "Escape")
                                          setEditingSpeakerIdx(null);
                                      }}
                                      className="w-36 rounded border border-slate-300 bg-white px-2 py-0.5 text-sm font-bold outline-none focus:ring-2 focus:ring-violet-500/40"
                                      style={{ color: speakerLine }}
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingSpeakerIdx(index);
                                        setSpeakerDraft(item.speaker);
                                      }}
                                      title="Click to rename this speaker everywhere"
                                      className="text-sm font-bold hover:underline"
                                      style={{ color: speakerLine }}
                                    >
                                      {item.speaker}
                                    </button>
                                  )}
                                </div>
                                <p className="text-[15px] leading-relaxed text-slate-700">
                                  {words.length > 0
                                    ? words.map((w, wi) => {
                                        const isActive =
                                          currentAudioTime >= w.start &&
                                          currentAudioTime < w.end;
                                        const wStart = wordStarts[wi];
                                        const wEnd = wStart + w.word.length;
                                        const isHl = hlRanges.some(
                                          ([s, e]) => wStart < e && wEnd > s,
                                        );
                                        return (
                                          <span
                                            key={wi}
                                            ref={
                                              isActive ? activeWordRef : null
                                            }
                                            className={
                                              isActive
                                                ? "rounded-md bg-indigo-100 px-1 py-0.5 font-bold text-indigo-700 shadow-sm ring-1 ring-indigo-200 transition-all duration-150"
                                                : isHl
                                                  ? "rounded bg-amber-200/70 px-0.5 transition-all duration-150"
                                                  : "transition-all duration-150"
                                            }
                                          >
                                            {w.word}{" "}
                                          </span>
                                        );
                                      })
                                    : (
                                        <HighlightedText
                                          text={stripSpeakerPrefix(item.text)}
                                          phrases={highlights}
                                          enabled={showHighlights}
                                        />
                                      )}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <ScrollNav targetRef={transcriptScrollRef} />
                  </div>
                ) : (
                  <TranscriptArea
                        onDiariseLive={
                          isRecording ? handleToggleLiveDiarise : undefined
                        }
                        diarisingLive={liveDiarising}
                        diariseActive={liveDiariseOn}
                        hasDiarisation={liveSegments.length > 0}
                        segments={liveDiariseOn ? liveSegments : []}
                        tailText={liveDiariseOn ? liveTailText : ""}
                    transcriptText={transcriptText}
                    editable={!isRecording}
                    onSave={handleSaveTranscript}
                    onTranscriptEdit={handleTranscriptEdit}
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="relative z-10 min-h-0 flex-1">
            <MyMeetings />
          </div>
        )}
      </main>

      {isRecording && view !== "dashboard" && (
        <div className="fixed bottom-6 right-6 z-150 w-70 rounded-2xl border border-white/60 bg-white/80 p-4 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.18)] backdrop-blur-2xl">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-slate-700">
              <span className="relative flex h-2.5 w-2.5">
                {!isPaused && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-60" />
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                    isPaused ? "bg-slate-400" : "bg-rose-500"
                  }`}
                />
              </span>
              {isPaused ? "Paused" : "Listening"}
            </span>
            <span className="font-mono text-sm font-black tabular-nums text-slate-800">
              {formatTime(sessionTime)}
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={isPaused ? handleResume : handlePause}
              className={`flex-1 rounded-xl py-2.5 text-xs font-bold text-white shadow-md transition-all active:scale-95 ${
                isPaused
                  ? "bg-linear-to-r from-violet-500 to-blue-500 hover:from-violet-600 hover:to-blue-600"
                  : "bg-linear-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600"
              }`}
            >
              {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={() => {
                setView("dashboard");
                setShowFinishModal(true);
              }}
              className="flex-1 rounded-xl bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE] py-2.5 text-xs font-bold text-white shadow-md transition-all hover:from-[#28a29a] hover:to-[#2a61a8] active:scale-95"
            >
              Finish
            </button>
          </div>
        </div>
      )}

      {showFinishModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Finish recording?
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              We&apos;ll stop the live stream and generate the final
              speaker-tagged transcript.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowFinishModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmFinish}
                className="flex-1 rounded-xl bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE] py-3 text-sm font-bold text-white shadow-lg shadow-[#2FB5AA]/25 transition-all hover:from-[#28a29a] hover:to-[#2a61a8]"
              >
                Finish
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewConvoModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Start a new conversation?
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              Unsaved progress will be lost.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowNewConvoModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowNewConvoModal(false);
                  doReset();
                }}
                className="flex-1 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600"
              >
                Start New
              </button>
            </div>
          </div>
        </div>
      )}

      {showStartConfirmModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Start a new recording?
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              Your current recording hasn&apos;t been saved yet. Starting a new
              one will discard it. Save it first if you want to keep it.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowStartConfirmModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowStartConfirmModal(false);
                  // Abort any in-flight diarize/recognizer before a fresh start.
                  if (isDiarizing || isUploading) {
                    if (uploadAbortRef.current) {
                      try {
                        uploadAbortRef.current.abort();
                      } catch {}
                      uploadAbortRef.current = null;
                    }
                    cancel();
                    stopSmoothProgress();
                    setIsDiarizing(false);
                    setDiarizeProgress(0);
                    setIsUploading(false);
                    setUploadProgress(0);
                  }
                  void handleStart();
                }}
                className="flex-1 rounded-xl bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE] py-3 text-sm font-bold text-white shadow-lg shadow-[#2FB5AA]/25 transition-all hover:from-[#28a29a] hover:to-[#2a61a8]"
              >
                Discard &amp; Start
              </button>
            </div>
          </div>
        </div>
      )}

      {showDiarizeRetryModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Diarisation failed
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              {diarizeError ??
                "We couldn't separate the speakers this time."}{" "}
              Your transcript is safe — you can retry diarisation on the same
              recording.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowDiarizeRetryModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Not now
              </button>
              <button
                onClick={handleDiarizeRetry}
                disabled={!audioFilePath}
                className="flex-1 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {showCloseModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">Close ThreadNotes?</h3>
            <p className="mt-2 text-sm text-slate-500">
              You have unsaved work. If you close now, the current transcript
              will be lost. Are you sure?
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowCloseModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowCloseModal(false);
                  window.electronAPI?.confirmClose?.();
                }}
                className="flex-1 rounded-xl bg-linear-to-r from-rose-500 to-red-500 py-3 text-sm font-bold text-white shadow-lg shadow-red-500/25 transition-all hover:from-rose-600 hover:to-red-600"
              >
                Close anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {showLogoutModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">Log out?</h3>
            <p className="mt-2 text-sm text-slate-500">
              Are you sure you want to log out? Any active session will be
              stopped and unsaved data may be lost.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowLogoutModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowLogoutModal(false);
                  handleLogout();
                }}
                className="flex-1 rounded-xl bg-linear-to-r from-rose-500 to-red-500 py-3 text-sm font-bold text-white shadow-lg shadow-red-500/25 transition-all hover:from-rose-600 hover:to-red-600"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {hlButton && (
        <button
          onClick={addHighlight}
          style={{ left: hlButton.x, top: hlButton.y - 44 }}
          className="fixed z-200 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-xl"
        >
          <Highlighter className="h-3.5 w-3.5" />
          {isHighlighted(hlButton.text) ? "Unhighlight" : "Highlight"}
        </button>
      )}

      <ConfirmModal
        open={showDeleteModal}
        danger
        loading={deleting}
        confirmDisabled={!deletePassword}
        title="Delete account?"
        message="This permanently deletes your account and cannot be undone. Enter your password to confirm."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDeleteAccount}
        onCancel={closeDeleteModal}
      >
        <input
          type="password"
          value={deletePassword}
          onChange={(e) => {
            setDeletePassword(e.target.value);
            if (deleteError) setDeleteError(null);
          }}
          placeholder="Current password"
          autoComplete="current-password"
          disabled={deleting}
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-200 disabled:opacity-50"
        />
        {deleteError && (
          <p className="mt-2 text-xs font-semibold text-rose-600">{deleteError}</p>
        )}
      </ConfirmModal>
    </div>
  );
}
