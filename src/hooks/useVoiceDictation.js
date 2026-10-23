import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Supported Speech Recognition Languages with BCP 47 language tags.
 * Comprehensive, reliable options with native and English labels.
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en-US', label: 'English (US)', flag: '🇺🇸', native: 'English (United States)' },
  { code: 'en-GB', label: 'English (UK)', flag: '🇬🇧', native: 'English (United Kingdom)' },
  { code: 'en-PK', label: 'English (Pakistan)', flag: '🇵🇰', native: 'English (Pakistan)' },
  { code: 'ur-PK', label: 'اردو / Urdu', flag: '🇵🇰', native: 'اردو (پاکستان)' },
  { code: 'es-ES', label: 'Español', flag: '🇪🇸', native: 'Español' },
  { code: 'fr-FR', label: 'Français', flag: '🇫🇷', native: 'Français' },
  { code: 'de-DE', label: 'Deutsch', flag: '🇩🇪', native: 'Deutsch' },
  { code: 'ar-SA', label: 'العربية / Arabic', flag: '🇸🇦', native: 'العربية' },
  { code: 'hi-IN', label: 'हिन्दी / Hindi', flag: '🇮🇳', native: 'हिन्दी' }
];

export const DEFAULT_LANGUAGE = 'en-US';

/**
 * Audio Capture & Buffering Configuration (Phase 5.2)
 */
export const MAX_RECORDED_BYTES = 25 * 1024 * 1024; // 25 MB safeguard against unbounded memory growth
export const MAX_RECORDING_DURATION_MS = 15 * 60 * 1000; // 15 minutes continuous dictation limit
export const CHUNK_TIMESLICE_MS = 250; // 250ms chunks for smooth real-time buffering

/**
 * Detects the most optimal audio MIME type supported by the user's browser.
 * Tests codecs dynamically (Opus, AAC, WebM, MP4, OGG) to ensure cross-browser fidelity.
 *
 * @returns {string} Supported MIME type or empty string if browser default should be used
 */
export function getSupportedAudioMimeType() {
  if (typeof window === 'undefined' || !window.MediaRecorder) {
    return '';
  }
  const candidateTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/aac'
  ];
  for (const mime of candidateTypes) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    } catch (_) {}
  }
  return '';
}

/**
 * Resolves the initial language locale, prioritizing localStorage,
 * then browser system locale (navigator.language), falling back to 'en-US'.
 */
export function getInitialLanguage() {
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('orvix_dictation_lang');
      if (stored && SUPPORTED_LANGUAGES.some((l) => l.code === stored)) {
        return stored;
      }
      const browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
      if (browserLang) {
        const exactMatch = SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase() === browserLang);
        if (exactMatch) return exactMatch.code;

        const prefix = browserLang.split('-')[0];
        const prefixMatch = SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase().startsWith(prefix));
        if (prefixMatch) return prefixMatch.code;
      }
    } catch (_) {}
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Common technical acronyms that should be formatted cleanly when spoken.
 * NOTE: As per project guidelines, no arbitrary word-replacement dictionaries are used.
 */
const COMMON_TECH_ACRONYMS = [
  [/\b(?:or\s*vix|our\s*vix|or\s*fix)\b/gi, 'Orvix'],
  [/\b(?:chat\s*gpt|chat\s*g\s*p\s*t)\b/gi, 'ChatGPT'],
  [/\bopen\s*ai\b/gi, 'OpenAI'],
  [/\bjava\s*script\b/gi, 'JavaScript'],
  [/\btype\s*script\b/gi, 'TypeScript'],
  [/\byou\s*tube\b/gi, 'YouTube'],
  [/\bpython\b/gi, 'Python'],
  [/\breact\b/gi, 'React'],
  [/\bangular\b/gi, 'Angular'],
  [/\bhannan\b/gi, 'Hannan'],
  [/\b(?:a\s*p\s*i)\b/gi, 'API'],
  [/\b(?:j\s*s\s*o\s*n)\b/gi, 'JSON'],
  [/\b(?:h\s*t\s*m\s*l)\b/gi, 'HTML'],
  [/\b(?:c\s*s\s*s)\b/gi, 'CSS'],
  [/\b(?:u\s*r\s*l)\b/gi, 'URL']
];

/**
 * Smart Verbal Punctuation and Typography Formatter
 * Converts spoken verbal commands ("period", "comma", "question mark", "new line")
 * into true typography, capitalizes sentences, and fixes spacing.
 *
 * @param {string} rawText
 * @param {string} langCode
 * @param {string} [precedingText='']
 * @returns {string} Clean, formatted speech text
 */
export function formatSpeechTranscript(rawText, langCode = 'en-US', precedingText = '') {
  if (!rawText) return '';
  let text = rawText.trim();
  const isUrdu = (langCode || '').toLowerCase().startsWith('ur');

  if (isUrdu) {
    // Urdu verbal punctuation rules
    text = text
      .replace(/\s*(?:ختمہ|فل\s*اسٹاپ)\s*/gi, '۔ ')
      .replace(/\s*(?:وقفہ|کوما)\s*/gi, '، ')
      .replace(/\s*سوالیہ\s*نشان\s*/gi, '؟ ')
      .replace(/\s*ندائیہ\s*/gi, '! ')
      .replace(/\s*نئی\s*لائن\s*/gi, '\n');
  } else {
    // English & standard verbal punctuation rules
    text = text
      .replace(/(?:\s+|^)\b(?:period|full\s*stop)\b/gi, '.')
      .replace(/(?:\s+|^)\bcomma\b/gi, ',')
      .replace(/(?:\s+|^)\bquestion\s*mark\b/gi, '?')
      .replace(/(?:\s+|^)\b(?:exclamation\s*mark|exclamation\s*point)\b/gi, '!')
      .replace(/(?:\s+|^)\bcolon\b/gi, ':')
      .replace(/(?:\s+|^)\bsemicolon\b/gi, ';')
      .replace(/(?:\s+|^)\b(?:new\s*paragraph|next\s*paragraph)\b/gi, '\n\n')
      .replace(/(?:\s+|^)\b(?:new\s*line|newline)\b/gi, '\n')
      .replace(/(?:\s+|^)\b(?:hyphen|dash)\b/gi, ' - ');

    // English pronoun "I" and contractions
    text = text
      .replace(/\bi\b/g, 'I')
      .replace(/\bi'm\b/g, "I'm")
      .replace(/\bi'll\b/g, "I'll")
      .replace(/\bi've\b/g, "I've")
      .replace(/\bi'd\b/g, "I'd");

    // Standard tech acronyms
    for (const [pattern, replacement] of COMMON_TECH_ACRONYMS) {
      text = text.replace(pattern, replacement);
    }
  }

  // Remove irregular spaces before punctuation
  text = text
    .replace(/\s+([.,!?:;۔،؟])/g, '$1')
    .replace(/([.,!?:;۔،؟])([^\s\d\n])/g, '$1 $2')
    .replace(/[ \t]+/g, ' ');

  // Sentence capitalization for Latin scripts
  if (!isUrdu) {
    const shouldCapitalizeStart =
      !precedingText ||
      /[.!?\n]\s*$/.test(precedingText);

    if (shouldCapitalizeStart && text.length > 0) {
      text = text.charAt(0).toUpperCase() + text.slice(1);
    }

    text = text.replace(/([.!?\n]\s+)([a-z])/g, (_, sep, letter) => `${sep}${letter.toUpperCase()}`);
  }

  return text;
}

/**
 * Combines existing composer text with newly recognized speech,
 * ensuring appropriate whitespace separation without creating double spaces.
 *
 * @param {string} base - Existing composer content
 * @param {string} speech - Newly recognized speech
 * @returns {string} Combined text
 */
export function combineComposerText(base = '', speech = '') {
  const cleanBase = base || '';
  const cleanSpeech = speech || '';

  if (!cleanBase) return cleanSpeech;
  if (!cleanSpeech) return cleanBase;

  // If base ends with whitespace or newline, simply append
  if (/\s$/.test(cleanBase)) {
    return cleanBase + cleanSpeech;
  }

  // If speech begins with leading punctuation like '.', ',', '?', '!', do not add space
  if (/^[.,!?:;]/.test(cleanSpeech)) {
    return cleanBase + cleanSpeech;
  }

  // Otherwise, join with a clean single space
  return `${cleanBase} ${cleanSpeech}`;
}

/**
 * Selects the best candidate from a SpeechRecognitionResult's alternatives.
 * Evaluates alternative confidence scores when available to select the highest quality result.
 *
 * @param {SpeechRecognitionResult} result
 * @returns {string} Clean candidate transcript
 */
function selectBestAlternative(result) {
  if (!result || result.length === 0) return '';
  if (result.length === 1) return (result[0]?.transcript || '').trim();

  let best = result[0];
  let bestScore = typeof best?.confidence === 'number' && !isNaN(best.confidence) ? best.confidence : 0;

  for (let i = 1; i < result.length; i++) {
    const alt = result[i];
    if (!alt || !alt.transcript) continue;
    const conf = typeof alt.confidence === 'number' && !isNaN(alt.confidence) ? alt.confidence : 0;

    // Prefer candidate with higher confidence if available and non-empty
    if (conf > bestScore && alt.transcript.trim().length > 0) {
      best = alt;
      bestScore = conf;
    }
  }

  return (best?.transcript || result[0]?.transcript || '').trim();
}

/**
 * Hook providing reliable, robust voice dictation using browser Web Speech API.
 *
 * Implements:
 * - Safe browser capability detection (window.SpeechRecognition || window.webkitSpeechRecognition).
 * - Multi-alternative candidate scoring (maxAlternatives = 3).
 * - Separation of interim vs finalized transcript accumulation.
 * - Non-destructive insertion that respects existing composer text.
 * - Protection against manual typing overwrites during dictation.
 * - Auto-restart deduplication to eliminate repeated words across silence restarts.
 * - Complete event lifecycle handling (start, result, error, end, speechstart, speechend, nomatch).
 * - Non-blocking Web Audio soundwave visualization with safe permission fallback.
 * - Clean teardown preventing duplicate recognition instances or memory leaks.
 *
 * @param {Object} options
 * @param {string} options.inputValue - Current text in the composer
 * @param {(text: string) => void} options.onInputChange - Callback to update composer text
 * @returns {Object} Dictation states, controls, and audio metrics
 */
export function useVoiceDictation({ inputValue = '', onInputChange }) {
  // Safe initial detection of browser SpeechRecognition support
  const [isSupported, setIsSupported] = useState(() => {
    if (typeof window !== 'undefined') {
      return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    }
    return false;
  });

  const [recordingState, setRecordingState] = useState('idle'); // 'idle' | 'requesting' | 'listening' | 'paused' | 'finalizing' | 'error'
  const [dictationError, setDictationError] = useState(null);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [lastSessionTranscript, setLastSessionTranscript] = useState('');

  // Real-time audio reactivity: volume (0-100) and 5 frequency bins (0.0 - 1.0)
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioFrequencies, setAudioFrequencies] = useState([0.15, 0.25, 0.35, 0.25, 0.15]);

  // Selected language with localStorage and browser locale resolution
  const [selectedLanguage, setSelectedLanguageState] = useState(getInitialLanguage);

  // Core references
  const recognitionRef = useRef(null);
  const baseTextRef = useRef('');
  const committedSegmentsRef = useRef([]); // Array of { instanceId: number, index: number, text: string, timestamp: number }
  const lastEmittedValueRef = useRef(''); // Tracks exact value sent to onInputChange
  const recentEmissionsRef = useRef(new Set()); // Tracks values emitted by dictation to distinguish from user typing
  const interimTranscriptRef = useRef('');
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  const onInputChangeRef = useRef(onInputChange);
  onInputChangeRef.current = onInputChange;

  const isExplicitStopRef = useRef(false);
  const hasFatalErrorRef = useRef(false);
  const recordingStateRef = useRef(recordingState);
  recordingStateRef.current = recordingState;

  const selectedLanguageRef = useRef(selectedLanguage);
  selectedLanguageRef.current = selectedLanguage;

  const restartTimeoutRef = useRef(null);
  const consecutiveErrorsRef = useRef(0);
  const isStartingRef = useRef(false);
  const instanceCounterRef = useRef(0);
  const lastCommittedSegmentRef = useRef({ text: '', timestamp: 0 });

  // AudioContext & Analyser refs for real-time soundwave
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const animFrameRef = useRef(null);

  // Phase 5.2: MediaRecorder audio capture & buffering state & refs
  const [recordedAudioBlob, setRecordedAudioBlob] = useState(null);
  const [recordedAudioDuration, setRecordedAudioDuration] = useState(0);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]); // Ordered array of audio Blob chunks
  const recordedBytesRef = useRef(0);
  const recordingStartTimeRef = useRef(0);
  const activeMimeTypeRef = useRef('');
  const recordedAudioBlobRef = useRef(null);

  // Synchronous state updater to avoid React re-render closure lag in event handlers
  const updateRecordingState = useCallback((newState) => {
    recordingStateRef.current = newState;
    setRecordingState(newState);
  }, []);

  // Handle genuine manual typing, pasting, or editing during an active dictation session.
  // Using recentEmissionsRef prevents React's asynchronous render cycle from falsely treating
  // its own emitted dictation values as external user edits.
  useEffect(() => {
    if (recentEmissionsRef.current.has(inputValue)) {
      recentEmissionsRef.current.delete(inputValue);
      return;
    }

    // If inputValue changed externally while dictating, respect user's manual edits as new base
    if (
      recordingStateRef.current !== 'idle' &&
      inputValue !== lastEmittedValueRef.current
    ) {
      baseTextRef.current = inputValue;
      committedSegmentsRef.current = [];
      lastEmittedValueRef.current = inputValue;
    }
  }, [inputValue]);

  // Check Web Speech API browser support on mount
  useEffect(() => {
    const SpeechRecognition =
      typeof window !== 'undefined'
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;
    setIsSupported(Boolean(SpeechRecognition));
  }, []);

  // Cleanup helper for all microphone, visualizer, and audio recorder resources (Phase 5.2)
  const stopAudioResources = useCallback(() => {
    // 1. Cancel visualizer animation frame
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    // 2. Safely stop MediaRecorder if active
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch (_) {}
      mediaRecorderRef.current = null;
    }

    // 3. Stop all audio tracks on the shared MediaStream
    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      mediaStreamRef.current = null;
    }

    // 4. Safely close AudioContext
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch (_) {}
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    setAudioLevel(0);
    setAudioFrequencies([0.15, 0.25, 0.35, 0.25, 0.15]);
  }, []);

  // Safely acquires a single shared microphone MediaStream (Phase 5.2).
  // Coordinates both the visualizer AnalyserNode and MediaRecorder on the same stream,
  // preventing multiple hardware capture streams and audio pipeline renegotiation.
  const acquireMicrophoneStream = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this browser.');
    }

    // Re-use active microphone stream across silence restarts so hardware doesn't drop words
    if (mediaStreamRef.current && mediaStreamRef.current.active) {
      const audioTracks = mediaStreamRef.current.getAudioTracks();
      if (audioTracks.length > 0 && audioTracks[0].readyState === 'live') {
        return mediaStreamRef.current;
      }
    }

    // Stop stale tracks before requesting new stream
    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      mediaStreamRef.current = null;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    mediaStreamRef.current = stream;
    return stream;
  }, []);

  // Connects Web Audio analyser to the shared MediaStream for non-blocking reactive visualizer
  const attachAudioAnalyser = useCallback((stream) => {
    if (typeof window === 'undefined' || !stream) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      let ctx = audioContextRef.current;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioCtx();
        audioContextRef.current = ctx;
      }
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.75;
      analyserRef.current = analyser;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateMeter = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const normalizedVol = Math.min(100, Math.round((avg / 128) * 100));
        setAudioLevel(normalizedVol);

        const step = Math.floor(dataArray.length / 5);
        const bars = [
          Math.max(0.15, (dataArray[step * 0] || 0) / 255),
          Math.max(0.2, (dataArray[step * 1] || 0) / 255),
          Math.max(0.25, (dataArray[step * 2] || 0) / 255),
          Math.max(0.2, (dataArray[step * 3] || 0) / 255),
          Math.max(0.15, (dataArray[step * 4] || 0) / 255)
        ];
        setAudioFrequencies(bars);

        animFrameRef.current = requestAnimationFrame(updateMeter);
      };

      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      animFrameRef.current = requestAnimationFrame(updateMeter);
    } catch (_) {
      // Non-fatal visualizer fallback
    }
  }, []);

  // Starts or continues audio buffering using MediaRecorder on the shared MediaStream (Phase 5.2).
  // Preserves audio across native SpeechRecognition restarts without losing initial words or sentence ends.
  const startMediaRecorder = useCallback((stream) => {
    if (typeof window === 'undefined' || !window.MediaRecorder || !stream) return;

    // If recorder is already recording or paused on this stream, maintain continuous session
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      return;
    }

    try {
      const mimeType = getSupportedAudioMimeType();
      activeMimeTypeRef.current = mimeType;

      const options = mimeType ? { mimeType } : undefined;
      const recorder = new MediaRecorder(stream, options);

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;

        // Memory safeguard: prevent unbounded memory growth during long dictation sessions
        if (recordedBytesRef.current + event.data.size > MAX_RECORDED_BYTES) {
          console.warn('Orvix dictation audio buffer reached maximum memory limit (25MB). Capping audio capture.');
          return;
        }

        audioChunksRef.current.push(event.data);
        recordedBytesRef.current += event.data.size;
      };

      recorder.onerror = (err) => {
        console.warn('MediaRecorder error during dictation:', err);
      };

      recorder.start(CHUNK_TIMESLICE_MS);
      mediaRecorderRef.current = recorder;
    } catch (recErr) {
      console.warn('MediaRecorder initialization failed:', recErr);
    }
  }, []);

  const clearDictationError = useCallback(() => {
    setDictationError(null);
    if (recordingStateRef.current === 'error') {
      updateRecordingState('idle');
    }
  }, [updateRecordingState]);

  const clearLastSessionTranscript = useCallback(() => {
    setLastSessionTranscript('');
  }, []);

  const clearRecordedAudio = useCallback(() => {
    audioChunksRef.current = [];
    recordedBytesRef.current = 0;
    recordedAudioBlobRef.current = null;
    setRecordedAudioBlob(null);
    setRecordedAudioDuration(0);
  }, []);

  const getAudioBlob = useCallback(() => {
    return recordedAudioBlobRef.current;
  }, []);

  /**
   * Safely disposes a SpeechRecognition instance and detaches all event listeners.
   */
  const cleanupRecognitionInstance = useCallback(() => {
    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try {
        rec.onstart = null;
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.onspeechstart = null;
        rec.onspeechend = null;
        rec.onaudiostart = null;
        rec.onaudioend = null;
        rec.onnomatch = null;
        rec.abort();
      } catch (_) {}
    }
  }, []);

  /**
   * Starts or restarts the browser SpeechRecognition instance with complete audio capture lifecycle.
   *
   * @param {boolean} [isNewSession=true] - Whether this is an initial user-triggered session
   */
  const startRecognitionSession = useCallback(
    async (isNewSession = true) => {
      clearTimeout(restartTimeoutRef.current);

      const SpeechRecognition =
        typeof window !== 'undefined'
          ? window.SpeechRecognition || window.webkitSpeechRecognition
          : null;

      if (!SpeechRecognition) {
        setDictationError(
          'Voice dictation is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Safari.'
        );
        hasFatalErrorRef.current = true;
        updateRecordingState('error');
        return;
      }

      instanceCounterRef.current += 1;
      const currentInstanceId = instanceCounterRef.current;

      if (isNewSession) {
        // Cancel active TTS playback so microphone does not pick up audio from device speakers
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          try {
            window.speechSynthesis.cancel();
          } catch (_) {}
        }

        // Snapshot existing composer content as the base prefix
        baseTextRef.current = inputValueRef.current || '';
        committedSegmentsRef.current = [];
        interimTranscriptRef.current = '';
        recentEmissionsRef.current.clear();
        lastEmittedValueRef.current = baseTextRef.current;
        setInterimTranscript('');
        setLastSessionTranscript('');
        isExplicitStopRef.current = false;
        hasFatalErrorRef.current = false;
        consecutiveErrorsRef.current = 0;
        lastCommittedSegmentRef.current = { text: '', timestamp: 0 };

        // Reset audio capture buffers for fresh session
        audioChunksRef.current = [];
        recordedBytesRef.current = 0;
        recordingStartTimeRef.current = Date.now();
        recordedAudioBlobRef.current = null;
        setRecordedAudioBlob(null);
        setRecordedAudioDuration(0);

        updateRecordingState('requesting');
      } else {
        // Continuing session after browser silence restart:
        // Fold already finalized speech segments into baseTextRef so the new instance starts cleanly
        if (committedSegmentsRef.current.length > 0) {
          const committedSoFar = committedSegmentsRef.current.map((s) => s.text).join(' ').trim();
          baseTextRef.current = combineComposerText(baseTextRef.current, committedSoFar);
          committedSegmentsRef.current = [];
        }
        interimTranscriptRef.current = '';
        setInterimTranscript('');
      }

      // Clean up any existing recognition instance completely before instantiating a new one
      cleanupRecognitionInstance();

      // Acquire shared microphone stream and coordinate visualizer + MediaRecorder
      let sharedStream = null;
      try {
        sharedStream = await acquireMicrophoneStream();

        // If user stopped or cancelled while getUserMedia was resolving, immediately release stream
        if (
          isExplicitStopRef.current ||
          (recordingStateRef.current !== 'listening' && recordingStateRef.current !== 'requesting')
        ) {
          stopAudioResources();
          return;
        }

        attachAudioAnalyser(sharedStream);
        startMediaRecorder(sharedStream);
      } catch (streamErr) {
        isStartingRef.current = false;
        hasFatalErrorRef.current = true;
        stopAudioResources();
        const errorMsg =
          streamErr?.name === 'NotAllowedError' || streamErr?.name === 'PermissionDeniedError'
            ? 'Microphone access was denied. Please allow microphone permissions in your browser address bar.'
            : streamErr?.name === 'NotFoundError' || streamErr?.name === 'DevicesNotFoundError'
            ? 'No microphone detected or microphone is currently busy in another application.'
            : 'Unable to access microphone. Please check device permissions.';
        setDictationError(errorMsg);
        updateRecordingState('error');
        return;
      }

      if (isStartingRef.current) return;
      isStartingRef.current = true;

      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 3;
        recognition.lang = selectedLanguageRef.current;

        hasFatalErrorRef.current = false;

        recognition.onstart = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          isStartingRef.current = false;
          updateRecordingState('listening');
          setDictationError(null);
          consecutiveErrorsRef.current = 0;
        };

        recognition.onspeechstart = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          consecutiveErrorsRef.current = 0;
        };

        recognition.onspeechend = () => {
          // User paused speaking; session remains open
        };

        recognition.onnomatch = () => {
          // Audio detected but no alternative met confidence threshold; keep listening
        };

        recognition.onresult = (event) => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          if (isExplicitStopRef.current) return;
          consecutiveErrorsRef.current = 0;

          // 1. Process all newly finalized results
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && res.isFinal) {
              const bestCandidate = selectBestAlternative(res);
              if (!bestCandidate) continue;

              const precedingText = [
                baseTextRef.current,
                ...committedSegmentsRef.current.map((s) => s.text)
              ]
                .filter(Boolean)
                .join(' ');

              const formatted = formatSpeechTranscript(
                bestCandidate,
                selectedLanguageRef.current,
                precedingText
              );

              if (formatted) {
                const now = Date.now();
                // Precise deduplication: Only suppress if this is the very first result (i === 0)
                // of a silence restart instance AND its exact text matches the last chunk from
                // the previous instance within a narrow 2-second restart window.
                const isRestartFirstResult = !isNewSession && i === 0;
                const isExactRestartEcho =
                  isRestartFirstResult &&
                  lastCommittedSegmentRef.current &&
                  lastCommittedSegmentRef.current.text &&
                  now - lastCommittedSegmentRef.current.timestamp < 2000 &&
                  lastCommittedSegmentRef.current.text.toLowerCase().trim() === formatted.toLowerCase().trim();

                // Prevent committing the same index twice in this instance
                const alreadyCommitted = committedSegmentsRef.current.some(
                  (s) => s.instanceId === currentInstanceId && s.index === i
                );

                if (!isExactRestartEcho && !alreadyCommitted) {
                  committedSegmentsRef.current.push({
                    instanceId: currentInstanceId,
                    index: i,
                    text: formatted,
                    timestamp: now
                  });
                  lastCommittedSegmentRef.current = {
                    text: formatted,
                    timestamp: now
                  };
                }
              }
            }
          }

          // 2. Compute current interim text across all unfinalized results
          let currentInterim = '';
          for (let i = 0; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && !res.isFinal) {
              const interimCand = selectBestAlternative(res);
              if (interimCand) {
                currentInterim += (currentInterim ? ' ' : '') + interimCand;
              }
            }
          }

          interimTranscriptRef.current = currentInterim;
          setInterimTranscript(currentInterim);

          // 3. Assemble and emit combined text to composer
          const allFinalSpeech = committedSegmentsRef.current.map((s) => s.text).join(' ').trim();
          const combinedFinal = combineComposerText(baseTextRef.current, allFinalSpeech);

          if (combinedFinal !== inputValueRef.current) {
            lastEmittedValueRef.current = combinedFinal;
            recentEmissionsRef.current.add(combinedFinal);
            // Keep set size bounded
            if (recentEmissionsRef.current.size > 20) {
              const first = recentEmissionsRef.current.values().next().value;
              recentEmissionsRef.current.delete(first);
            }
            if (onInputChangeRef.current) {
              onInputChangeRef.current(combinedFinal);
            }
          }
        };

        recognition.onerror = (event) => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          isStartingRef.current = false;
          const errorType = event?.error;

          // Ignore intentional user stops or aborts
          if (errorType === 'aborted' || isExplicitStopRef.current) {
            return;
          }

          if (errorType === 'not-allowed' || errorType === 'service-not-allowed') {
            hasFatalErrorRef.current = true;
            stopAudioResources();
            setDictationError(
              'Microphone access was denied. Please allow microphone permissions in your browser address bar.'
            );
            updateRecordingState('error');
          } else if (errorType === 'audio-capture') {
            hasFatalErrorRef.current = true;
            stopAudioResources();
            setDictationError(
              'No microphone detected or microphone is currently busy in another application.'
            );
            updateRecordingState('error');
          } else if (errorType === 'no-speech') {
            // Natural pause in speech: keep listening.
            // Do NOT increment fatal errors or close mic.
            return;
          } else if (errorType === 'network') {
            consecutiveErrorsRef.current += 1;
            if (consecutiveErrorsRef.current > 2) {
              hasFatalErrorRef.current = true;
              stopAudioResources();
              setDictationError('Speech recognition network error. Please verify your internet connection.');
              updateRecordingState('error');
            }
          } else if (errorType === 'language-not-supported') {
            hasFatalErrorRef.current = true;
            stopAudioResources();
            setDictationError(
              `The selected language (${selectedLanguageRef.current}) is not supported in this browser. Falling back to English (US).`
            );
            selectedLanguageRef.current = DEFAULT_LANGUAGE;
            setSelectedLanguageState(DEFAULT_LANGUAGE);
            updateRecordingState('error');
          } else {
            consecutiveErrorsRef.current += 1;
            if (consecutiveErrorsRef.current > 3) {
              hasFatalErrorRef.current = true;
              stopAudioResources();
              setDictationError('Dictation stopped unexpectedly. Please tap the microphone to continue.');
              updateRecordingState('error');
            }
          }
        };

        recognition.onend = () => {
          if (instanceCounterRef.current !== currentInstanceId) return;
          isStartingRef.current = false;
          recognitionRef.current = null;

          if (hasFatalErrorRef.current) {
            hasFatalErrorRef.current = false;
            stopAudioResources();
            updateRecordingState('error');
            return;
          }

          // If speech recognizer ended naturally during active listening without explicit user stop
          // (such as standard browser 60s silence timeout or mobile sentence cutoff), recover quickly.
          // MediaRecorder and microphone stream remain active throughout this pause!
          if (
            !isExplicitStopRef.current &&
            recordingStateRef.current === 'listening'
          ) {
            clearTimeout(restartTimeoutRef.current);
            restartTimeoutRef.current = setTimeout(() => {
              if (recordingStateRef.current === 'listening' && !isExplicitStopRef.current) {
                startRecognitionSession(false);
              }
            }, 40);
            return;
          }

          stopAudioResources();

          if (recordingStateRef.current !== 'paused') {
            updateRecordingState('idle');
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch (initErr) {
        isStartingRef.current = false;
        console.warn('SpeechRecognition initialization error:', initErr);
        hasFatalErrorRef.current = true;
        stopAudioResources();
        setDictationError('Unable to activate microphone. Please verify device permissions.');
        updateRecordingState('error');
      }
    },
    [
      acquireMicrophoneStream,
      attachAudioAnalyser,
      cleanupRecognitionInstance,
      startMediaRecorder,
      stopAudioResources,
      updateRecordingState
    ]
  );

  // Start a fresh dictation session
  const startListening = useCallback(() => {
    isExplicitStopRef.current = false;
    hasFatalErrorRef.current = false;
    setDictationError(null);
    startRecognitionSession(true);
  }, [startRecognitionSession]);

  // Pause dictation temporarily
  const pauseListening = useCallback(() => {
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    cleanupRecognitionInstance();

    // Pause MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try {
        mediaRecorderRef.current.pause();
      } catch (_) {}
    }

    // Pause visualizer animation
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setAudioLevel(0);
    setAudioFrequencies([0.15, 0.25, 0.35, 0.25, 0.15]);

    // Commit any interim transcript captured up to pause
    let allFinalSpeech = committedSegmentsRef.current.map((s) => s.text).join(' ').trim();
    if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
      const formattedInterim = formatSpeechTranscript(
        interimTranscriptRef.current.trim(),
        selectedLanguageRef.current,
        combineComposerText(baseTextRef.current, allFinalSpeech)
      );
      if (formattedInterim) {
        allFinalSpeech = combineComposerText(allFinalSpeech, formattedInterim);
      }
    }
    const finalCombined = combineComposerText(baseTextRef.current, allFinalSpeech);
    baseTextRef.current = finalCombined;
    committedSegmentsRef.current = [];
    interimTranscriptRef.current = '';
    setInterimTranscript('');

    if (onInputChangeRef.current) {
      onInputChangeRef.current(finalCombined);
    }
    lastEmittedValueRef.current = finalCombined;
    recentEmissionsRef.current.add(finalCombined);

    updateRecordingState('paused');
  }, [cleanupRecognitionInstance, updateRecordingState]);

  // Resume paused dictation session
  const resumeListening = useCallback(() => {
    isExplicitStopRef.current = false;
    hasFatalErrorRef.current = false;
    setDictationError(null);

    // Resume MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      try {
        mediaRecorderRef.current.resume();
      } catch (_) {}
    }

    // Resume visualizer
    if (mediaStreamRef.current && mediaStreamRef.current.active) {
      attachAudioAnalyser(mediaStreamRef.current);
    }

    startRecognitionSession(false);
  }, [attachAudioAnalyser, startRecognitionSession]);

  // Stop dictation and commit finalized transcript and audio buffer (Phase 5.2)
  const stopListening = useCallback(() => {
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    updateRecordingState('finalizing');

    // Clean up recognition instance immediately to prevent trailing onresult events from double-committing
    cleanupRecognitionInstance();

    // Finalize MediaRecorder audio chunks
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        if (typeof mediaRecorderRef.current.requestData === 'function') {
          mediaRecorderRef.current.requestData();
        }
        mediaRecorderRef.current.stop();
      } catch (_) {}
    }

    // Assemble and store final audio blob for Phase 5.2 buffer access
    if (audioChunksRef.current.length > 0) {
      const type = activeMimeTypeRef.current || 'audio/webm';
      const finalBlob = new Blob(audioChunksRef.current, { type });
      recordedAudioBlobRef.current = finalBlob;
      setRecordedAudioBlob(finalBlob);

      const duration = recordingStartTimeRef.current > 0
        ? Math.round((Date.now() - recordingStartTimeRef.current) / 1000)
        : 0;
      setRecordedAudioDuration(duration);
    }

    // Release microphone tracks and visualizer resources
    stopAudioResources();

    // Assemble final committed speech including any pending interim transcript
    let allFinalSpeech = committedSegmentsRef.current.map((s) => s.text).join(' ').trim();

    if (interimTranscriptRef.current && interimTranscriptRef.current.trim()) {
      const formattedInterim = formatSpeechTranscript(
        interimTranscriptRef.current.trim(),
        selectedLanguageRef.current,
        combineComposerText(baseTextRef.current, allFinalSpeech)
      );
      if (formattedInterim) {
        allFinalSpeech = combineComposerText(allFinalSpeech, formattedInterim);
      }
    }

    const finalCombined = combineComposerText(baseTextRef.current, allFinalSpeech);
    lastEmittedValueRef.current = finalCombined;
    recentEmissionsRef.current.add(finalCombined);

    if (onInputChangeRef.current) {
      onInputChangeRef.current(finalCombined);
    }

    interimTranscriptRef.current = '';
    setInterimTranscript('');

    if (allFinalSpeech) {
      setLastSessionTranscript(allFinalSpeech);
    }

    committedSegmentsRef.current = [];
    updateRecordingState('idle');
  }, [cleanupRecognitionInstance, stopAudioResources, updateRecordingState]);

  // Cancel dictation: Discards speech from this session and restores original composer text
  const cancelListening = useCallback(() => {
    isExplicitStopRef.current = true;
    clearTimeout(restartTimeoutRef.current);
    cleanupRecognitionInstance();

    // Stop MediaRecorder and discard recorded audio chunks completely
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (_) {}
    }
    audioChunksRef.current = [];
    recordedBytesRef.current = 0;
    recordingStartTimeRef.current = 0;
    recordedAudioBlobRef.current = null;
    setRecordedAudioBlob(null);
    setRecordedAudioDuration(0);

    // Release microphone tracks and visualizer resources
    stopAudioResources();

    // Revert to original composer content prior to this session
    if (onInputChangeRef.current) {
      onInputChangeRef.current(baseTextRef.current);
    }

    committedSegmentsRef.current = [];
    interimTranscriptRef.current = '';
    setInterimTranscript('');
    updateRecordingState('idle');
  }, [cleanupRecognitionInstance, stopAudioResources, updateRecordingState]);

  // Master toggle button
  const toggleListening = useCallback(() => {
    if (recordingStateRef.current === 'listening') {
      stopListening();
    } else if (recordingStateRef.current === 'paused') {
      resumeListening();
    } else if (recordingStateRef.current === 'requesting') {
      cancelListening();
    } else if (recordingStateRef.current === 'finalizing') {
      return;
    } else {
      startListening();
    }
  }, [startListening, stopListening, resumeListening, cancelListening]);

  // Configurable language setter with instant live session restart
  const setSelectedLanguage = useCallback(
    (code) => {
      setSelectedLanguageState(code);
      selectedLanguageRef.current = code;
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem('orvix_dictation_lang', code);
        } catch (_) {}
      }
      // If actively listening, restart recognition session with new language immediately
      if (recordingStateRef.current === 'listening' && recognitionRef.current) {
        startRecognitionSession(false);
      }
    },
    [startRecognitionSession]
  );

  // PWA and Mobile Lifecycle: Gracefully pause dictation when app goes to background
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // App went to background - pause or stop active recognition gracefully
        if (recordingStateRef.current === 'listening') {
          pauseListening();
        } else if (recordingStateRef.current === 'requesting') {
          cancelListening();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [pauseListening, cancelListening]);

  // Component unmount cleanup (Phase 5.2)
  useEffect(() => {
    return () => {
      clearTimeout(restartTimeoutRef.current);
      stopAudioResources();
      cleanupRecognitionInstance();
    };
  }, [cleanupRecognitionInstance, stopAudioResources]);

  return {
    recordingState,
    isListening: recordingState === 'listening',
    isPaused: recordingState === 'paused',
    isRequesting: recordingState === 'requesting',
    isFinalizing: recordingState === 'finalizing',
    isSupported,
    dictationError,
    interimTranscript,
    lastSessionTranscript,
    selectedLanguage,
    setSelectedLanguage,
    supportedLanguages: SUPPORTED_LANGUAGES,
    audioLevel,
    audioFrequencies,
    startListening,
    pauseListening,
    resumeListening,
    stopListening,
    cancelListening,
    toggleListening,
    clearDictationError,
    clearLastSessionTranscript,
    // Phase 5.2 Audio Capture & Buffering exports
    recordedAudioBlob,
    recordedAudioDuration,
    hasRecordedAudio: Boolean(recordedAudioBlob),
    supportedAudioMimeType: activeMimeTypeRef.current || getSupportedAudioMimeType(),
    getAudioBlob,
    clearRecordedAudio
  };
}
