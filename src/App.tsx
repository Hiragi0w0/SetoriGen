import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { FileDown, FolderOpen, Image, RefreshCw, Upload, ScanText } from "lucide-react";
import { createPages, renderCardToCanvas, renderVrchatExportCardToCanvas, renderWideCardToCanvas } from "./rendering";
import type { BackgroundSettings, CardMetadata, ExportAspectRatio, GradientPreset, OcrResult, PlaylistSummary, PngPayload, Track, TrackEnrichmentFailure, TrackEnrichmentResult, VrcImageOptions, VrcLoginStatus, VrcPendingEmailOtp, VrcUploadResult } from "./types";

const initialMetadata: CardMetadata = {
  eventName: "MIDNIGHT HARDCORE LOUNGE",
  date: formatToday(),
  vrcName: "",
  message: ""
};

const initialBackground: BackgroundSettings = {
  mode: "gradient",
  color: "#111111",
  gradientPreset: "neon-purple",
  imagePath: "",
  imageDataUrl: ""
};

const wizardSteps = ["Import", "Details", "Design", "Export"] as const;
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const LEGACY_GEMINI_API_KEY_STORAGE_KEY = "gemini_api_key";
type ActiveInput = "none" | "xml" | "ocr";
type VrchatUiState = "checking_saved_login" | "logged_in" | "logged_out" | "relogin_required" | "pending_email_otp";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const exportCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [xmlPath, setXmlPath] = useState("");
  const [localPlaylists, setLocalPlaylists] = useState<PlaylistSummary[]>([]);
  const [playlistKey, setPlaylistKey] = useState("");
  const [activeInput, setActiveInput] = useState<ActiveInput>("none");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [metadata, setMetadata] = useState<CardMetadata>(initialMetadata);
  const [background, setBackground] = useState<BackgroundSettings>(initialBackground);
  const [exportAspectRatio, setExportAspectRatio] = useState<ExportAspectRatio>("default");
  const [activeStep, setActiveStep] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [importStatus, setImportStatus] = useState("rekordbox XML を選択してください。");
  const [importError, setImportError] = useState("");
  const [detailsStatus, setDetailsStatus] = useState("");
  const [detailsError, setDetailsError] = useState("");
  const [designError, setDesignError] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [exportError, setExportError] = useState("");
  const [vrchatStatus, setVrchatStatus] = useState("");
  const [vrchatError, setVrchatError] = useState("");

  const [shouldSaveGeminiApiKey, setShouldSaveGeminiApiKey] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiApiKeyStorageStatus, setGeminiApiKeyStorageStatus] = useState("");
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [vrchatUsername, setVrchatUsername] = useState("");
  const [vrchatPassword, setVrchatPassword] = useState("");
  const [vrchatEmailOtp, setVrchatEmailOtp] = useState("");
  const [vrchatPendingPngDataUrl, setVrchatPendingPngDataUrl] = useState("");
  const [vrchatLoginState, setVrchatLoginState] = useState<VrchatUiState>("checking_saved_login");
  const [vrchatOtpRequestId, setVrchatOtpRequestId] = useState("");
  const [vrchatOtpExpiresAt, setVrchatOtpExpiresAt] = useState(0);
  const [isVrchatSubmitting, setIsVrchatSubmitting] = useState(false);

  const totalTrackCount = tracks.length;
  const pages = useMemo(() => createPages(tracks, totalTrackCount), [totalTrackCount, tracks]);
  const currentPage = pages[Math.min(pageIndex, pages.length - 1)];
  const playlists = localPlaylists;

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderPreview =
      exportAspectRatio === "vrchat_1920_1080"
        ? renderWideCardToCanvas(canvasRef.current, tracks, totalTrackCount, metadata, background)
        : renderCardToCanvas(canvasRef.current, currentPage, metadata, background);
    renderPreview.catch((err: unknown) => {
      const message = `プレビュー描画に失敗しました。${errorMessage(err)}`;
      setDesignError(message);
      void writeAppLog("ERROR", "preview.render.error", message);
    });
  }, [background, currentPage, exportAspectRatio, metadata, totalTrackCount, tracks]);

  useEffect(() => {
    void initializeGeminiApiKeyStorage();
    void refreshVrchatLoginStatus();
  }, []);

  useEffect(() => {
    if (vrchatLoginState !== "pending_email_otp" || !vrchatOtpExpiresAt) {
      return;
    }

    const timer = window.setInterval(() => {
      if (Date.now() < vrchatOtpExpiresAt) {
        return;
      }
      clearVrchatPendingState();
      setVrchatPendingPngDataUrl("");
      setVrchatLoginState("relogin_required");
      setVrchatStatus("VRChatのメール認証コード入力期限が切れました。もう一度ログインからやり直してください。");
    }, 1000);

    return () => window.clearInterval(timer);
  }, [vrchatLoginState, vrchatOtpExpiresAt]);

  async function chooseXml() {
    setImportError("");
    const selected = await open({
      multiple: false,
      filters: [{ name: "rekordbox XML", extensions: ["xml"] }]
    });

    if (typeof selected !== "string") return;

    setXmlPath(selected);
    setTracks([]);
    setPlaylistKey("");
    setPageIndex(0);

    try {
      const items = await invoke<PlaylistSummary[]>("list_rekordbox_playlists", { path: selected });
      setLocalPlaylists(items);
      setActiveInput("xml");
      setImportStatus(`${items.length} 件のプレイリストを読み込みました。`);
    } catch (err) {
      setLocalPlaylists([]);
      setImportError(errorMessage(err));
    }
  }

  async function loadPlaylist(nextKey: string) {
    setPlaylistKey(nextKey);
    setDetailsError("");
    setPageIndex(0);

    if (!nextKey) {
      setTracks([]);
      return;
    }

    try {
      const loadedTracks = await loadLocalTracks(nextKey);
      setTracks(loadedTracks);
      setActiveInput("xml");
      setDetailsStatus(`${loadedTracks.length} 曲を読み込みました。`);
    } catch (err) {
      setTracks([]);
      setDetailsError(errorMessage(err));
    }
  }

  async function loadLocalTracks(playlistKey: string): Promise<Track[]> {
    if (!xmlPath) {
      throw new Error("rekordbox XML を選択してください。");
    }
    return invoke<Track[]>("get_playlist_tracks", { path: xmlPath, playlistKey });
  }

  async function chooseBackgroundImage() {
    setDesignError("");
    const selected = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }]
    });

    if (typeof selected !== "string") return;

    try {
      const dataUrl = await invoke<string>("read_image_as_data_url", { path: selected });
      setBackground((current) => ({
        ...current,
        mode: "image",
        imagePath: selected,
        imageDataUrl: dataUrl
      }));
    } catch (err) {
      setDesignError(`背景画像を読み込めませんでした。${errorMessage(err)}`);
      setBackground((current) => ({ ...current, mode: "gradient", imagePath: "", imageDataUrl: "" }));
    }
  }


  async function runOcrImport() {
    setImportError("");
    if (!geminiApiKey.trim()) {
      setImportError("Gemini APIキーを設定してください。");
      return;
    }

    const selected = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }]
    });

    if (typeof selected !== "string") return;

    setIsOcrProcessing(true);
    setImportStatus("OCRを実行しています...");

    try {
      const result = await invoke<OcrResult>("extract_setlist_from_image", {
        imagePath: selected,
        apiKey: geminiApiKey.trim(),
        model: GEMINI_MODEL
      });

      let loadedTracks = result.tracks.map((track, index) => ({ ...track, number: index + 1 }));
      setImportStatus("OCR完了: Gemini で正式曲名と正式アーティスト名を確認しています...");
      const enriched = await invoke<TrackEnrichmentResult>("enrich_tracks_with_gemini", {
        apiKey: geminiApiKey.trim(),
        model: GEMINI_MODEL,
        tracks: loadedTracks
      });
      loadedTracks = enriched.tracks;

      setTracks(loadedTracks);
      setActiveInput("ocr");
      setPlaylistKey("");
      setPageIndex(0);
      setDetailsStatus(
        trackEnrichmentStatus(loadedTracks.length, enriched)
      );
      if (enriched.failures.length) {
        const message = trackEnrichmentFailureSummary(enriched.failures);
        setDetailsError(message);
        void writeAppLog("WARN", "ocr.gemini_normalization.partial_failure", message);
      }
      setActiveStep(1);
    } catch (err) {
      const message = `OCRに失敗しました。${errorMessage(err)}`;
      setImportError(message);
      void writeAppLog("ERROR", "ocr.import.error", message);
      setImportStatus("OCRに失敗しました。");
    } finally {
      setIsOcrProcessing(false);
    }
  }

  async function initializeGeminiApiKeyStorage() {
    const legacyApiKey = localStorage.getItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY);
    if (legacyApiKey !== null) {
      localStorage.removeItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY);
    }

    try {
      const savedApiKey = await invoke<string | null>("load_saved_gemini_api_key");
      if (savedApiKey) {
        setGeminiApiKey(savedApiKey);
        setShouldSaveGeminiApiKey(true);
        setGeminiApiKeyStorageStatus("Gemini APIキーはこの端末の暗号化ストレージから読み込みました。");
        return;
      }

      if (legacyApiKey) {
        setGeminiApiKey(legacyApiKey);
        await invoke("store_gemini_api_key", { apiKey: legacyApiKey });
        setShouldSaveGeminiApiKey(true);
        setGeminiApiKeyStorageStatus("Gemini APIキーを旧localStorageから暗号化ストレージへ移行しました。");
        return;
      }

      const status = await invoke<{ saved: boolean }>("get_saved_gemini_api_key_status");
      setShouldSaveGeminiApiKey(status.saved);
    } catch (err) {
      const message = errorMessage(err);
      if (!isTauriInvokeUnavailable(message)) {
        setGeminiApiKeyStorageStatus(`Gemini APIキーの保存状態を確認できませんでした。${message}`);
      }
    }
  }

  async function updateGeminiApiKey(next: string) {
    setGeminiApiKey(next);
    if (!shouldSaveGeminiApiKey) {
      return;
    }
    await saveGeminiApiKey(next);
  }

  async function updateShouldSaveGeminiApiKey(checked: boolean) {
    setShouldSaveGeminiApiKey(checked);
    if (checked) {
      await saveGeminiApiKey(geminiApiKey);
      return;
    }
    await clearSavedGeminiApiKey();
  }

  async function saveGeminiApiKey(apiKey: string) {
    try {
      await invoke("store_gemini_api_key", { apiKey });
      setGeminiApiKeyStorageStatus(apiKey.trim() ? "Gemini APIキーをこの端末に暗号化保存しました。" : "保存済みGemini APIキーを削除しました。");
    } catch (err) {
      setGeminiApiKeyStorageStatus(`Gemini APIキーを保存できませんでした。${errorMessage(err)}`);
    }
  }

  async function clearSavedGeminiApiKey() {
    try {
      await invoke("clear_gemini_api_key");
      setGeminiApiKeyStorageStatus("保存済みGemini APIキーを削除しました。");
    } catch (err) {
      setGeminiApiKeyStorageStatus(`Gemini APIキーを削除できませんでした。${errorMessage(err)}`);
    }
  }

  async function exportPngs() {
    setExportError("");

    const validationError = validateCardOutputInputs();
    if (validationError) {
      setExportError(validationError);
      return;
    }

    const target = await save({
      defaultPath: exportAspectRatio === "vrchat_1920_1080" ? "setorigen_vrchat_1920x1080.png" : "setlist.png",
      filters: [{ name: "PNG", extensions: ["png"] }]
    });

    if (!target) return;

    const canvas = exportCanvasRef.current;
    if (!canvas) return;

    const payloads: PngPayload[] = [];
    try {
      if (exportAspectRatio === "vrchat_1920_1080") {
        await renderVrchatExportCardToCanvas(canvas, tracks, totalTrackCount, metadata, background);
        payloads.push({
          file_name: "setorigen_vrchat_1920x1080.png",
          data_url: canvas.toDataURL("image/png")
        });
      } else {
        for (const page of pages) {
          await renderCardToCanvas(canvas, page, metadata, background);
          payloads.push({
            file_name: page.pageCount === 1 ? "setlist.png" : `setlist_${String(page.pageNumber).padStart(2, "0")}.png`,
            data_url: canvas.toDataURL("image/png")
          });
        }
      }

      await invoke("save_png_files", { targetPath: target, images: payloads });
      setExportStatus(`${payloads.length} 件の PNG を書き出しました。`);
    } catch (err) {
      setExportError(errorMessage(err));
    }
  }

  async function refreshCurrentSource() {
    setImportError("");
    setDetailsError("");

    if (activeInput === "ocr") {
      setImportStatus("OCR入力は再読込できません。必要な場合は画像からOCRを再実行してください。");
      return;
    }

    try {
      if (playlistKey) {
        await loadPlaylist(playlistKey);
      } else if (xmlPath) {
        const items = await invoke<PlaylistSummary[]>("list_rekordbox_playlists", { path: xmlPath });
        setLocalPlaylists(items);
        setImportStatus(`${items.length} 件のプレイリストを読み込みました。`);
      }
    } catch (err) {
      setImportStatus("再読込に失敗しました。");
      setImportError(errorMessage(err));
    }
  }

  async function refreshVrchatLoginStatus() {
    setVrchatLoginState("checking_saved_login");
    try {
      const result = await invoke<VrcLoginStatus>("get_vrchat_login_status");
      setVrchatLoginState(result.state);
      if (result.state === "logged_in") {
        setVrchatStatus("保存済みのVRChatログイン状態を確認しました。");
      } else if (result.state === "relogin_required") {
        setVrchatStatus("保存済みのVRChatログイン状態が無効です。再度ログインしてください。");
      }
    } catch (err) {
      const message = errorMessage(err);
      setVrchatLoginState("logged_out");
      if (isTauriInvokeUnavailable(message)) {
        return;
      }
      setVrchatError(message);
      void writeAppLog("WARN", "vrchat.login_status.error", message);
    }
  }

  async function startGeneratedCardVrchatPost() {
    setVrchatError("");

    const validationError = validateCardOutputInputs();
    if (validationError) {
      setVrchatError(validationError);
      return;
    }

    let pngDataUrl: string;
    try {
      pngDataUrl = await createCurrentCardPngDataUrl();
    } catch (err) {
      setVrchatError(`アップロード用画像の生成に失敗しました。${errorMessage(err)}`);
      return;
    }

    setVrchatPendingPngDataUrl(pngDataUrl);
    if (vrchatLoginState === "logged_in") {
      await uploadVrchatPhotoGalleryWithSavedLogin(pngDataUrl);
      return;
    }

    setVrchatStatus("現在のカードをVRChatのPhoto Galleryへアップロードします。username / password を入力し、メール認証コード送信を実行してください。");
  }

  async function uploadVrchatPhotoGalleryWithSavedLogin(pngDataUrl: string) {
    setIsVrchatSubmitting(true);
    setVrchatStatus("保存済みのVRChatログイン状態でPhoto Galleryへアップロードしています...");
    try {
      const result = await invoke<VrcUploadResult>("upload_vrchat_photo_gallery_with_saved_login", {
        options: {
          image: createVrchatImageOptions(pngDataUrl)
        }
      });
      setVrchatStatus(`Photo Galleryへのアップロードが完了しました。SetoriGenから直接Print投稿はしていません。VRChat内のPhoto Galleryから画像を確認してください。${result.gallery_id ? ` galleryId: ${result.gallery_id}` : ""}`);
      setVrchatPendingPngDataUrl("");
    } catch (err) {
      if (typeof err === "string" && err.includes("保存済みのVRChatログイン状態が無効")) {
        setVrchatLoginState("relogin_required");
      }
      setVrchatStatus("Photo Galleryへのアップロードに失敗しました。");
      setVrchatError(errorMessage(err));
    } finally {
      setIsVrchatSubmitting(false);
    }
  }

  async function beginVrchatLoginAndUpload() {
    setVrchatError("");
    if (!vrchatPendingPngDataUrl) {
      setVrchatError("先に現在のカードをPhoto Galleryアップロード用に準備してください。");
      return;
    }
    if (!vrchatUsername.trim() || !vrchatPassword) {
      setVrchatError("VRChat username / password を入力してください。");
      return;
    }

    setIsVrchatSubmitting(true);
    setVrchatStatus("VRChatログイン中です...");
    try {
      const result = await invoke<VrcPendingEmailOtp>("begin_vrchat_photo_gallery_upload", {
        options: {
          username: vrchatUsername.trim(),
          password: vrchatPassword,
          image: createVrchatImageOptions(vrchatPendingPngDataUrl)
        }
      });
      setVrchatLoginState("pending_email_otp");
      setVrchatOtpRequestId(result.request_id);
      setVrchatOtpExpiresAt(result.expires_at_epoch_ms);
      setVrchatEmailOtp("");
      setVrchatPassword("");
      setVrchatStatus("VRChatからメールで届いた認証コードを入力してください。");
    } catch (err) {
      setVrchatStatus("Photo Galleryへのアップロードに失敗しました。");
      setVrchatError(errorMessage(err));
    } finally {
      setIsVrchatSubmitting(false);
    }
  }

  async function completeVrchatEmailOtpAndUpload() {
    setVrchatError("");
    if (!vrchatOtpRequestId || !vrchatEmailOtp.trim()) {
      setVrchatError("VRChatからメールで届いた認証コードを入力してください。");
      return;
    }

    setIsVrchatSubmitting(true);
    setVrchatStatus("emailOtpを検証してPhoto Galleryへアップロードしています...");
    try {
      const result = await invoke<VrcUploadResult>("complete_vrchat_email_otp_and_upload", {
        options: {
          request_id: vrchatOtpRequestId,
          code: vrchatEmailOtp.trim()
        }
      });
      clearVrchatPendingState();
      setVrchatLoginState("logged_in");
      setVrchatEmailOtp("");
      setVrchatPendingPngDataUrl("");
      setVrchatStatus(`Photo Galleryへのアップロードが完了しました。SetoriGenから直接Print投稿はしていません。VRChat内のPhoto Galleryから画像を確認してください。${result.gallery_id ? ` galleryId: ${result.gallery_id}` : ""}`);
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("期限が切れました")) {
        clearVrchatPendingState();
        setVrchatPendingPngDataUrl("");
        setVrchatLoginState("relogin_required");
      } else if (!message.includes("メール認証コードを確認してください")) {
        clearVrchatPendingState();
        setVrchatLoginState(
          message.includes("保存済みのVRChatログイン状態が無効") || message.includes("保存") || message.includes("暗号化")
            ? "relogin_required"
            : "logged_in"
        );
      }
      setVrchatStatus("Photo Galleryへのアップロードに失敗しました。");
      setVrchatError(message);
    } finally {
      setIsVrchatSubmitting(false);
    }
  }

  async function resetVrchatLoginState(): Promise<boolean> {
    setVrchatError("");
    setIsVrchatSubmitting(true);
    try {
      await invoke("reset_vrchat_login_state");
      clearVrchatPendingState();
      setVrchatLoginState("logged_out");
      setVrchatPassword("");
      setVrchatEmailOtp("");
      setVrchatPendingPngDataUrl("");
      setVrchatStatus("保存済みのVRChatログイン状態をリセットしました。");
      return true;
    } catch (err) {
      setVrchatError(errorMessage(err));
      return false;
    } finally {
      setIsVrchatSubmitting(false);
    }
  }

  async function cancelVrchatPendingOtp() {
    const reset = await resetVrchatLoginState();
    if (!reset) {
      return;
    }
    setVrchatPendingPngDataUrl("");
    setVrchatStatus("Photo Galleryアップロードをキャンセルしました。");
  }

  function clearVrchatPendingState() {
    setVrchatOtpRequestId("");
    setVrchatOtpExpiresAt(0);
  }

  function validateCardOutputInputs(): string | null {
    if (!metadata.eventName.trim() || !metadata.date.trim() || !metadata.vrcName.trim()) {
      return "イベント名、開催日、DJ名を入力してください。";
    }

    if (!tracks.length) {
      return "プレイリストを選択してください。";
    }

    return null;
  }

  async function createCurrentCardPngDataUrl(): Promise<string> {
    const canvas = exportCanvasRef.current;
    if (!canvas) {
      throw new Error("アップロード用画像を生成できませんでした。");
    }

    if (exportAspectRatio === "vrchat_1920_1080") {
      await renderWideCardToCanvas(canvas, tracks, totalTrackCount, metadata, background);
      return canvas.toDataURL("image/png");
    }

    await renderCardToCanvas(canvas, currentPage, metadata, background);

    return canvas.toDataURL("image/png");
  }

  function createVrchatImageOptions(pngDataUrl: string): VrcImageOptions {
    return {
      png_data_url: pngDataUrl
    };
  }

  function vrchatStateLabel() {
    switch (vrchatLoginState) {
      case "checking_saved_login":
        return "保存済みログイン状態を確認中";
      case "logged_in":
        return "ログイン済み";
      case "pending_email_otp":
        return "メール認証コード待ち";
      case "relogin_required":
        return "ログイン状態が無効なため再ログインが必要";
      default:
        return "未ログイン";
    }
  }

  function vrchatPostButtonLabel() {
    if (isVrchatSubmitting) {
      return "処理中";
    }
    return "Photo Galleryへアップロード";
  }

  function canStartVrchatLogin() {
    return Boolean(vrchatPendingPngDataUrl && vrchatUsername.trim() && vrchatPassword && !isVrchatSubmitting);
  }

  function canSubmitVrchatOtp() {
    return Boolean(vrchatOtpRequestId && vrchatEmailOtp.trim() && !isVrchatSubmitting);
  }

  function vrchatOtpDeadlineLabel() {
    if (!vrchatOtpExpiresAt) {
      return "";
    }
    const remainingSeconds = Math.max(0, Math.ceil((vrchatOtpExpiresAt - Date.now()) / 1000));
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  return (
    <main className="app-shell">
      <section className="panel controls" aria-label="入力">
        <header className="app-header">
          <div>
            <p className="eyebrow">DJ Setlist Card</p>
            <h1>SetoriGen</h1>
          </div>
          <button className="icon-button" type="button" onClick={() => void refreshCurrentSource()} title="再読込">
            <RefreshCw size={20} />
          </button>
        </header>

        <nav className="wizard-steps" aria-label="作成ステップ">
          {wizardSteps.map((step, index) => (
            <button key={step} type="button" className={activeStep === index ? "active" : ""} onClick={() => setActiveStep(index)}>
              {step}
            </button>
          ))}
        </nav>

        {activeStep === 0 && (
          <section className="wizard-page">
            <div className="field">
              <label>rekordbox XML</label>
              <button className="file-button" type="button" onClick={chooseXml}>
                <Upload size={18} />
                <span>{xmlPath ? compactPath(xmlPath) : "XMLを選択"}</span>
              </button>
            </div>

            <div className="field">
              <label>Gemini API Key</label>
              <input
                type="password"
                value={geminiApiKey}
                onChange={(event) => {
                  const next = event.target.value;
                  void updateGeminiApiKey(next);
                }}
                placeholder="AIza..."
              />
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={shouldSaveGeminiApiKey}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    void updateShouldSaveGeminiApiKey(checked);
                  }}
                />
                <span>この端末に保存</span>
              </label>
              <p className="message">未チェック時は保存しません。チェック時のみこの端末のアプリデータに暗号化保存します。</p>
              {geminiApiKeyStorageStatus && <p className="message">{geminiApiKeyStorageStatus}</p>}
            </div>

            <button className="file-button" type="button" onClick={() => void runOcrImport()} disabled={isOcrProcessing}>
              <ScanText size={18} />
              <span>{isOcrProcessing ? "OCR 実行中" : "画像からOCRで読み込み"}</span>
            </button>

            {importStatus && <p className="message">{importStatus}</p>}
            {importError && <p className="message error">{importError}</p>}
          </section>
        )}

        {activeStep === 1 && (
          <section className="wizard-page">
            <div className="grid two">
              <TextField label="Event" value={metadata.eventName} onChange={(eventName) => setMetadata((current) => ({ ...current, eventName }))} />
              <TextField label="Date" value={metadata.date} onChange={(date) => setMetadata((current) => ({ ...current, date }))} />
            </div>

            <TextField label="DJ Name" value={metadata.vrcName} onChange={(vrcName) => setMetadata((current) => ({ ...current, vrcName }))} />

            <div className="field">
              <label>Message</label>
              <textarea
                value={metadata.message}
                onChange={(event) => setMetadata((current) => ({ ...current, message: event.target.value }))}
                rows={3}
                placeholder="Thank you for listening!"
              />
            </div>

            <div className="field">
              <label>Playlist</label>
              <select
                value={playlistKey}
                onChange={(event) => void loadPlaylist(event.target.value)}
                disabled={!playlists.length || activeInput === "ocr"}
              >
                <option value="">選択してください</option>
                {playlists.map((playlist) => (
                  <option key={`${playlist.path.join("/")}/${playlist.name}`} value={playlistValue(playlist)}>
                    {playlistLabel(playlist)}
                  </option>
                ))}
              </select>
              {activeInput === "ocr" && <p className="message">現在はOCR入力を表示中です。XMLプレイリストを使う場合は rekordbox XML を読み込み直してください。</p>}
            </div>

            {detailsStatus && <p className="message">{detailsStatus}</p>}
            {detailsError && <p className="message error">{detailsError}</p>}
          </section>
        )}

        {activeStep === 2 && (
          <section className="wizard-page">
            <div className="segmented" aria-label="背景モード">
              {(["gradient", "solid", "image"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={background.mode === mode ? "active" : ""}
                  onClick={() => setBackground((current) => ({ ...current, mode }))}
                >
                  {mode}
                </button>
              ))}
            </div>

            {background.mode === "gradient" && (
              <div className="field">
                <label>Gradient</label>
                <select
                  value={background.gradientPreset}
                  onChange={(event) => setBackground((current) => ({ ...current, gradientPreset: event.target.value as GradientPreset }))}
                >
                  <option value="neon-purple">neon-purple</option>
                  <option value="cyber-blue">cyber-blue</option>
                  <option value="sunset-magenta">sunset-magenta</option>
                  <option value="dark-club">dark-club</option>
                </select>
              </div>
            )}

            {background.mode === "solid" && (
              <div className="field">
                <label>Color</label>
                <input
                  type="color"
                  value={background.color}
                  onChange={(event) => setBackground((current) => ({ ...current, color: event.target.value }))}
                />
              </div>
            )}

            {background.mode === "image" && (
              <button className="file-button" type="button" onClick={chooseBackgroundImage}>
                <Image size={18} />
                <span>{background.imagePath ? compactPath(background.imagePath) : "背景画像を選択"}</span>
              </button>
            )}

            {designError && <p className="message error">{designError}</p>}
          </section>
        )}

        {activeStep === 3 && (
          <section className="wizard-page">
            <div className="field">
              <label>出力形式</label>
              <div className="segmented two-options" aria-label="出力形式">
                <button
                  type="button"
                  className={exportAspectRatio === "default" ? "active" : ""}
                  onClick={() => setExportAspectRatio("default")}
                >
                  1:1 通常
                </button>
                <button
                  type="button"
                  className={exportAspectRatio === "vrchat_1920_1080" ? "active" : ""}
                  onClick={() => setExportAspectRatio("vrchat_1920_1080")}
                >
                  1920:1080 VRChat向け
                </button>
              </div>
            </div>

            <div className="action-row">
              <button className="primary" type="button" onClick={() => void exportPngs()}>
                <FileDown size={18} />
                Export PNG
              </button>
              {vrchatLoginState !== "pending_email_otp" && (
                <button className="primary" type="button" onClick={() => void startGeneratedCardVrchatPost()} disabled={isVrchatSubmitting}>
                  <Upload size={18} />
                  {vrchatPostButtonLabel()}
                </button>
              )}
            </div>

            {exportStatus && <p className="message">{exportStatus}</p>}
            {exportError && <p className="message error">{exportError}</p>}

            <section className="source-box" aria-label="Photo Galleryアップロード">
              <div className="field">
                <label>Photo Galleryアップロード</label>
                <p className="connection-status">{vrchatStateLabel()}</p>
              </div>

              <p className="message">アップロード対象: 現在のプレビューカード。SetoriGenから直接Print投稿はせず、Photo Galleryへ画像を保存します。</p>

              {vrchatLoginState !== "logged_in" && vrchatLoginState !== "pending_email_otp" && (
                <>
                  <TextField label="VRChat Username / Email" value={vrchatUsername} onChange={setVrchatUsername} />
                  <div className="field">
                    <label>VRChat Password</label>
                    <input type="password" value={vrchatPassword} onChange={(event) => setVrchatPassword(event.target.value)} />
                  </div>
                </>
              )}

              {vrchatLoginState === "pending_email_otp" && (
                <>
                  <p className="message">VRChatからメールで届いた認証コードを入力してください。</p>
                  <div className="field">
                    <label>emailOtp</label>
                    <input type="password" value={vrchatEmailOtp} onChange={(event) => setVrchatEmailOtp(event.target.value)} />
                  </div>
                  <p className="message">入力期限: {vrchatOtpDeadlineLabel()}</p>
                </>
              )}

              <div className="vrchat-action-row">
                {vrchatLoginState !== "logged_in" && vrchatLoginState !== "pending_email_otp" && (
                  <button className="secondary" type="button" onClick={() => void beginVrchatLoginAndUpload()} disabled={!canStartVrchatLogin()}>
                    メール認証コード送信
                  </button>
                )}

                {vrchatLoginState === "pending_email_otp" && (
                  <>
                    <button className="secondary" type="button" onClick={() => void completeVrchatEmailOtpAndUpload()} disabled={!canSubmitVrchatOtp()}>
                      認証コードを送信してアップロード
                    </button>
                    <button className="secondary" type="button" onClick={() => void cancelVrchatPendingOtp()} disabled={isVrchatSubmitting}>
                      キャンセル
                    </button>
                  </>
                )}

                <button className="secondary" type="button" onClick={() => void resetVrchatLoginState()} disabled={isVrchatSubmitting}>
                  ログイン状態をリセット
                </button>
              </div>

              {vrchatStatus && <p className="message">{vrchatStatus}</p>}
              {vrchatError && <p className="message error">{vrchatError}</p>}
            </section>
          </section>
        )}
      </section>

      <section className={`preview-area ${exportAspectRatio === "vrchat_1920_1080" ? "preview-wide" : "preview-square"}`} aria-label="プレビュー">
        <div className="preview-toolbar">
          <div className="track-summary">
            <FolderOpen size={18} />
            <span>{totalTrackCount} tracks</span>
          </div>
        </div>
        <div className="canvas-frame">
          <canvas ref={canvasRef} aria-label="setlist card preview" />
        </div>
      </section>

      <canvas ref={exportCanvasRef} className="export-canvas" />
    </main>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/);
  if (parts.length <= 2) return path;
  return `${parts[parts.length - 2]}\\${parts[parts.length - 1]}`;
}

function playlistValue(playlist: PlaylistSummary): string {
  return localPlaylistKey(playlist.path, playlist.name);
}

function playlistLabel(playlist: PlaylistSummary): string {
  const label = playlist.path.length ? `${playlist.path.join(" / ")} / ${playlist.name}` : playlist.name;
  return typeof playlist.track_count === "number" ? `${label} (${playlist.track_count})` : label;
}

function localPlaylistKey(path: string[], name: string): string {
  return [...path, name].join("\u001f");
}

function trackEnrichmentStatus(total: number, result: TrackEnrichmentResult): string {
  const parts = [`OCR完了: ${total} 曲を抽出し、Gemini で ${result.enriched_count} 曲の正式表記を反映しました。`];
  if (result.failed_count) {
    parts.push(`${result.failed_count} 曲は正式表記を確定できませんでした。`);
  }
  if (result.skipped_count) {
    parts.push(`${result.skipped_count} 曲は曲名が空のためスキップしました。`);
  }
  return parts.join(" ");
}

function trackEnrichmentFailureSummary(failures: TrackEnrichmentFailure[]): string {
  const shown = failures.slice(0, 5).map((failure) => {
    const label = [failure.title, failure.artist].filter(Boolean).join(" / ") || "曲名なし";
    return `${failure.number}. ${label}: ${failure.detail}`;
  });
  const suffix = failures.length > shown.length ? ` 他 ${failures.length - shown.length} 件。` : "";
  return `Gemini正式表記確認で確認が必要な曲があります。\n${shown.join("\n")}${suffix}`;
}

async function writeAppLog(level: "INFO" | "WARN" | "ERROR", event: string, detail: string): Promise<void> {
  try {
    await invoke("write_app_log", { level, event, detail });
  } catch {
    // Logging must never block the user flow.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "不明なエラーが発生しました。";
  }
}

function isTauriInvokeUnavailable(message: string): boolean {
  return message.includes("reading 'invoke'") || message.includes("window.__TAURI_INTERNALS__");
}

function formatToday(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}
