import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { CARD_SIZE, WIDE_CARD_HEIGHT, WIDE_CARD_WIDTH, createPages, renderCardToCanvas, renderVrchatExportCardToCanvas, renderWideCardToCanvas } from "./rendering";
import type { BackgroundSettings, CardMetadata, Track } from "./types";

type VisualCase =
  | "wide-30"
  | "wide-32"
  | "square-16"
  | "long-text"
  | "mixed-bpm"
  | "japanese"
  | "vrchat-safe-30"
  | "vrchat-safe-32"
  | "vrchat-safe-long-text"
  | "vrchat-safe-japanese";

const CASES = new Set<VisualCase>([
  "wide-30",
  "wide-32",
  "square-16",
  "long-text",
  "mixed-bpm",
  "japanese",
  "vrchat-safe-30",
  "vrchat-safe-32",
  "vrchat-safe-long-text",
  "vrchat-safe-japanese"
]);

const background: BackgroundSettings = {
  mode: "gradient",
  color: "#15151f",
  gradientPreset: "cyber-blue",
  imagePath: "",
  imageDataUrl: ""
};

const baseMetadata: CardMetadata = {
  eventName: "RALPH LOOP VISUAL CHECK",
  date: "2026/05/31",
  vrcName: "SetoriGen_Test_DJ",
  message: "Generated without Spotify, VRChat, OCR, or file dialogs"
};

const japaneseMetadata: CardMetadata = {
  eventName: "深夜のセットリスト検証会 日本語タイトル混在",
  date: "2026/05/31",
  vrcName: "検証DJ",
  message: "日本語表示と省略表示の固定検証"
};

const longMetadata: CardMetadata = {
  eventName: "Extremely Long Event Name For Visual Regression Layout Verification Across The Export Canvas",
  date: "2026/05/31",
  vrcName: "Very_Long_DJ_Display_Name_For_Truncation_Check",
  message: "This message is intentionally long to confirm header and footer truncation behavior"
};

const seedTracks: Array<Omit<Track, "number">> = [
  { title: "Neon Terminal", artist: "Astra Circuit", bpm: 128 },
  { title: "夜明け前のグルーヴ", artist: "水鏡シンセ", bpm: 132 },
  { title: "Longest Possible Track Title For Column Width Regression", artist: "Artist Name With Several Words For Truncation", bpm: 140 },
  { title: "Afterimage", artist: "Northline", bpm: null },
  { title: "Skyline Protocol", artist: "Mira Vale", bpm: 126 },
  { title: "透明なフロア", artist: "星野ループ", bpm: 118.5 },
  { title: "Signal Bloom", artist: "Echo Index", bpm: 124 },
  { title: "Low Orbit", artist: "Kite Assembly", bpm: null },
  { title: "Chrome Memory", artist: "Parcel Unit", bpm: 136 },
  { title: "Last Train Loop", artist: "Mono Harbor", bpm: 122 },
  { title: "Polyrhythm Test Pattern", artist: "Grid Rider", bpm: 129 },
  { title: "遠い夏のベースライン", artist: "薄明レコード", bpm: 115 },
  { title: "Vector Garden", artist: "Sora Field", bpm: null },
  { title: "Subsurface", artist: "Plain Mode", bpm: 100 },
  { title: "Kinetic Type", artist: "Glyph Runner", bpm: 150 },
  { title: "星屑のコントラスト", artist: "夜間飛行", bpm: 142 },
  { title: "Faint Blue", artist: "Quiet Amp", bpm: 112 },
  { title: "Overflow Guard", artist: "Canvas Crew", bpm: null },
  { title: "Three Column Proof", artist: "Wide Layout Department", bpm: 130 },
  { title: "Footer Clearance", artist: "Bottom Margin Unit", bpm: 127 },
  { title: "Crescent Bus", artist: "Metro Phase", bpm: 121 },
  { title: "回転する光", artist: "プリズム係", bpm: 134 },
  { title: "Controlled Input", artist: "Fixture Makers", bpm: null },
  { title: "No External Artwork", artist: "Offline Rendering", bpm: 125 },
  { title: "Stable Screenshot", artist: "Chromium Only", bpm: 128 },
  { title: "Column Ten", artist: "Row Counter", bpm: 131 },
  { title: "Late Night Parser", artist: "Regex Free", bpm: null },
  { title: "Window Resize Resistant", artist: "Viewport Lock", bpm: 123 },
  { title: "Final Visible Track", artist: "Limit Thirty", bpm: 138 },
  { title: "Track Thirty", artist: "Visible Boundary", bpm: 144 },
  { title: "Hidden Track Thirty One", artist: "Omitted Counter", bpm: 146 },
  { title: "Hidden Track Thirty Two", artist: "Omitted Counter", bpm: null }
];

export function VisualHarness(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<"rendering" | "ready" | "error">("rendering");
  const [error, setError] = useState("");
  const visualCase = getVisualCase();
  const scenario = useMemo(() => buildScenario(visualCase), [visualCase]);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    setStatus("rendering");
    setError("");
    canvas.removeAttribute("data-visual-ready");

    const render = scenario.renderMode === "vrchatExport"
      ? renderVrchatExportCardToCanvas(canvas, scenario.tracks, scenario.totalTrackCount, scenario.metadata, background)
      : scenario.aspectRatio === "wide"
      ? renderWideCardToCanvas(canvas, scenario.tracks, scenario.totalTrackCount, scenario.metadata, background)
      : renderCardToCanvas(canvas, createPages(scenario.tracks, scenario.totalTrackCount)[0], scenario.metadata, background);

    render
      .then(() => {
        if (!cancelled) {
          canvas.setAttribute("data-visual-ready", "true");
          document.body.setAttribute("data-visual-ready", "true");
          setStatus("ready");
        }
      })
      .catch((renderError: unknown) => {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : String(renderError));
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
      document.body.removeAttribute("data-visual-ready");
    };
  }, [scenario]);

  const width = scenario.aspectRatio === "wide" ? WIDE_CARD_WIDTH : CARD_SIZE;
  const height = scenario.aspectRatio === "wide" ? WIDE_CARD_HEIGHT : CARD_SIZE;

  return (
    <main style={styles.root} data-visual-case={visualCase} data-visual-status={status}>
      <canvas
        ref={canvasRef}
        aria-label={`SetoriGen visual regression ${visualCase}`}
        data-testid="visual-canvas"
        width={width}
        height={height}
        style={{ ...styles.canvas, width, height }}
      />
      {status === "error" ? <pre style={styles.error}>{error}</pre> : null}
    </main>
  );
}

function getVisualCase(): VisualCase {
  const value = new URLSearchParams(window.location.search).get("case");
  return value && CASES.has(value as VisualCase) ? (value as VisualCase) : "wide-30";
}

function buildScenario(visualCase: VisualCase): {
  aspectRatio: "square" | "wide";
  metadata: CardMetadata;
  renderMode?: "preview" | "vrchatExport";
  totalTrackCount: number;
  tracks: Track[];
} {
  if (visualCase === "square-16") {
    return {
      aspectRatio: "square",
      metadata: baseMetadata,
      totalTrackCount: 16,
      tracks: numberedTracks(16)
    };
  }

  if (visualCase === "wide-32") {
    return {
      aspectRatio: "wide",
      metadata: baseMetadata,
      totalTrackCount: 32,
      tracks: numberedTracks(32)
    };
  }

  if (visualCase === "vrchat-safe-32") {
    return {
      aspectRatio: "wide",
      metadata: baseMetadata,
      renderMode: "vrchatExport",
      totalTrackCount: 32,
      tracks: numberedTracks(32)
    };
  }

  if (visualCase === "vrchat-safe-30") {
    return {
      aspectRatio: "wide",
      metadata: baseMetadata,
      renderMode: "vrchatExport",
      totalTrackCount: 30,
      tracks: numberedTracks(30)
    };
  }

  if (visualCase === "vrchat-safe-long-text") {
    return {
      aspectRatio: "wide",
      metadata: longMetadata,
      renderMode: "vrchatExport",
      totalTrackCount: 30,
      tracks: numberedTracks(30).map((track) => ({
        ...track,
        artist: `${track.artist} With Extra Words To Exercise Artist Truncation`,
        title: `${track.title} With An Additional Very Long Suffix For Canvas Measurement`
      }))
    };
  }

  if (visualCase === "vrchat-safe-japanese") {
    return {
      aspectRatio: "wide",
      metadata: japaneseMetadata,
      renderMode: "vrchatExport",
      totalTrackCount: 30,
      tracks: numberedTracks(30).map((track, index) => ({
        ...track,
        artist: index % 2 === 0 ? `日本語アーティスト ${track.artist}` : track.artist,
        title: index % 2 === 0 ? `日本語タイトル ${track.title}` : track.title
      }))
    };
  }

  if (visualCase === "long-text") {
    return {
      aspectRatio: "wide",
      metadata: longMetadata,
      totalTrackCount: 30,
      tracks: numberedTracks(30).map((track) => ({
        ...track,
        artist: `${track.artist} With Extra Words To Exercise Artist Truncation`,
        title: `${track.title} With An Additional Very Long Suffix For Canvas Measurement`
      }))
    };
  }

  if (visualCase === "mixed-bpm") {
    return {
      aspectRatio: "wide",
      metadata: baseMetadata,
      totalTrackCount: 30,
      tracks: numberedTracks(30).map((track, index) => ({
        ...track,
        bpm: index % 3 === 1 ? null : track.bpm
      }))
    };
  }

  if (visualCase === "japanese") {
    return {
      aspectRatio: "wide",
      metadata: japaneseMetadata,
      totalTrackCount: 30,
      tracks: numberedTracks(30).map((track, index) => ({
        ...track,
        artist: index % 2 === 0 ? `日本語アーティスト ${track.artist}` : track.artist,
        title: index % 2 === 0 ? `日本語タイトル ${track.title}` : track.title
      }))
    };
  }

  return {
    aspectRatio: "wide",
    metadata: baseMetadata,
    totalTrackCount: 30,
    tracks: numberedTracks(30)
  };
}

function numberedTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, index) => ({
    ...seedTracks[index % seedTracks.length],
    number: index + 1
  }));
}

const styles = {
  root: {
    alignItems: "flex-start",
    background: "#101014",
    display: "flex",
    justifyContent: "flex-start",
    margin: 0,
    minHeight: "100vh",
    padding: 0
  },
  canvas: {
    display: "block",
    flex: "0 0 auto"
  },
  error: {
    color: "#ffb4b4",
    font: "16px monospace",
    margin: 24,
    whiteSpace: "pre-wrap"
  }
} satisfies Record<string, CSSProperties>;
