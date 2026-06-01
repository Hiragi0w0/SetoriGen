export interface PlaylistSummary {
  name: string;
  path: string[];
  track_count?: number;
}

export interface Track {
  number: number;
  artist: string;
  title: string;
  bpm: number | null;
}

export interface CardMetadata {
  eventName: string;
  date: string;
  vrcName: string;
  message: string;
}

export type BackgroundMode = "solid" | "gradient" | "image";

export interface BackgroundSettings {
  mode: BackgroundMode;
  color: string;
  gradientPreset: GradientPreset;
  imagePath: string;
  imageDataUrl: string;
}

export type GradientPreset = "neon-purple" | "cyber-blue" | "sunset-magenta" | "dark-club";

export type ExportAspectRatio = "default" | "vrchat_1920_1080";

export interface RenderPage {
  pageNumber: number;
  pageCount: number;
  tracks: Track[];
  hasOmittedTracks: boolean;
  omittedTrackCount: number;
  totalTrackCount: number;
}

export interface PngPayload {
  file_name: string;
  data_url: string;
}

export interface OcrResult {
  tracks: Track[];
}

export interface TrackEnrichmentResult {
  tracks: Track[];
  enriched_count: number;
  failed_count: number;
  skipped_count: number;
  failures: TrackEnrichmentFailure[];
}

export interface TrackEnrichmentFailure {
  number: number;
  artist: string;
  title: string;
  reason: string;
  detail: string;
}

export interface VrcUploadResult {
  gallery_id?: string | null;
  status: string;
}

export interface VrcImageOptions {
  png_data_url: string;
}

export interface VrcLoginStatus {
  state: "logged_in" | "logged_out" | "relogin_required";
}

export interface VrcPendingEmailOtp {
  request_id: string;
  expires_at_epoch_ms: number;
  status: "pending_email_otp";
}
