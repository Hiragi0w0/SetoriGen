use base64::Engine;
use rand::{distributions::Alphanumeric, Rng};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use roxmltree::{Document, Node};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
struct PlaylistSummary {
    name: String,
    path: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    track_count: Option<usize>,
}

#[derive(Clone, Debug)]
struct PlaylistData {
    name: String,
    path: Vec<String>,
    keys: Vec<String>,
}

#[derive(Clone, Debug)]
struct TrackData {
    artist: String,
    title: String,
    bpm: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Track {
    number: usize,
    artist: String,
    title: String,
    bpm: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct PngPayload {
    file_name: String,
    data_url: String,
}

#[derive(Debug, Serialize)]
struct TrackEnrichmentResult {
    tracks: Vec<Track>,
    enriched_count: usize,
    failed_count: usize,
    skipped_count: usize,
    failures: Vec<TrackEnrichmentFailure>,
}

#[derive(Debug, Serialize)]
struct TrackEnrichmentFailure {
    number: usize,
    artist: String,
    title: String,
    reason: String,
    detail: String,
}

#[derive(Debug, Serialize)]
struct OcrResult {
    tracks: Vec<Track>,
}

#[derive(Debug, Deserialize)]
struct OcrParseResult {
    tracks: Vec<OcrTrack>,
}

#[derive(Debug, Deserialize)]
struct OcrTrack {
    artist: String,
    title: String,
    #[serde(default, deserialize_with = "deserialize_optional_bpm")]
    bpm: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct GeminiTrackEnrichmentResponse {
    #[serde(default)]
    tracks: Vec<GeminiTrackEnrichmentItem>,
}

#[derive(Debug, Deserialize)]
struct GeminiTrackEnrichmentItem {
    number: usize,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    title: String,
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    #[serde(default)]
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize)]
struct GeminiPart {
    text: Option<String>,
}

const VRCHAT_PENDING_LOGIN_TTL_SECS: u64 = 5 * 60;
const VRCHAT_PHOTO_GALLERY_ENDPOINT: &str = "https://api.vrchat.cloud/api/1/gallery";
const VRCHAT_PHOTO_GALLERY_MAX_PNG_BYTES: usize = 10 * 1024 * 1024;
const VRCHAT_PHOTO_GALLERY_MIN_DIMENSION: u32 = 64;
const VRCHAT_PHOTO_GALLERY_MAX_DIMENSION: u32 = 2048;

#[derive(Debug, Deserialize, Clone)]
struct VrcImageOptions {
    png_data_url: String,
}

#[derive(Debug, Deserialize)]
struct VrcLoginStartOptions {
    username: String,
    password: String,
    image: VrcImageOptions,
}

#[derive(Debug, Deserialize)]
struct VrcOtpVerifyOptions {
    request_id: String,
    code: String,
}

#[derive(Debug, Deserialize)]
struct VrcSavedUploadOptions {
    image: VrcImageOptions,
}

#[derive(Debug, Serialize)]
struct VrcUploadResult {
    gallery_id: Option<String>,
    status: String,
}

#[derive(Debug)]
struct PreparedVrcPng {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
struct VrcLoginStatus {
    state: String,
}

#[derive(Debug, Serialize)]
struct SavedSecretStatus {
    saved: bool,
}

#[derive(Debug, Serialize)]
struct VrcPendingEmailOtp {
    request_id: String,
    expires_at_epoch_ms: u64,
    status: String,
}

struct PendingVrcUpload {
    auth_cookie: String,
    png: PreparedVrcPng,
    created_at: Instant,
}

type PendingVrcUploadStore = Mutex<HashMap<String, PendingVrcUpload>>;

#[derive(Debug, Deserialize)]
struct VrchatTwoFactorResponse {
    #[serde(default, rename = "requiresTwoFactorAuth")]
    requires_two_factor_auth: Vec<String>,
}
fn log_info(event: &str, detail: impl AsRef<str>) {
    write_log_line("INFO", event, detail.as_ref());
}

fn log_warn(event: &str, detail: impl AsRef<str>) {
    write_log_line("WARN", event, detail.as_ref());
}

fn log_error(event: &str, detail: impl AsRef<str>) {
    write_log_line("ERROR", event, detail.as_ref());
}

fn write_log_line(level: &str, event: &str, detail: &str) {
    let Some(log_path) = setorigen_log_path() else {
        return;
    };

    if let Some(parent) = log_path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) else {
        return;
    };

    let detail = sanitize_log_detail(detail);
    let _ = writeln!(file, "{} [{level}] {event}: {detail}", log_timestamp());
}

fn setorigen_log_path() -> Option<PathBuf> {
    dirs::data_dir().map(|base| base.join("SetoriGen").join("logs").join("setorigen.log"))
}

fn log_timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis())
}

fn sanitize_log_detail(detail: &str) -> String {
    let sanitized = redact_secret_like_values(&detail.replace(['\r', '\n'], " "));
    sanitized.chars().take(1200).collect()
}

fn sanitize_log_event(event: &str) -> String {
    let sanitized = event
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(120)
        .collect::<String>();

    if sanitized.is_empty() {
        "app.event".to_string()
    } else {
        sanitized
    }
}

fn redact_secret_like_values(value: &str) -> String {
    let mut redacted = redact_query_key(value);
    redacted = redact_json_secret_field(&redacted, "apiKey");
    redacted = redact_json_secret_field(&redacted, "api_key");
    redacted = redact_json_secret_field(&redacted, "password");
    redacted = redact_json_secret_field(&redacted, "emailOtp");
    redacted = redact_json_secret_field(&redacted, "code");
    redacted = redact_cookie_pair(&redacted, "auth=");
    redacted = redact_header_token(&redacted, "Bearer ");
    redacted = redact_header_token(&redacted, "Basic ");
    redacted
}

fn redact_query_key(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;

    while let Some(index) = rest.find("key=") {
        result.push_str(&rest[..index]);
        result.push_str("key=<redacted>");
        let after_key = &rest[index + 4..];
        let next_separator = after_key
            .find(|character| matches!(character, '&' | ' ' | '"' | '\''))
            .unwrap_or(after_key.len());
        rest = &after_key[next_separator..];
    }

    result.push_str(rest);
    result
}

fn redact_json_secret_field(value: &str, field: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    let quoted_field = format!("\"{field}\"");

    while let Some(index) = rest.find(&quoted_field) {
        result.push_str(&rest[..index]);
        result.push_str(&quoted_field);
        let after_field = &rest[index + quoted_field.len()..];
        let Some(colon_index) = after_field.find(':') else {
            rest = after_field;
            continue;
        };
        result.push_str(&after_field[..=colon_index]);
        let after_colon = &after_field[colon_index + 1..];
        let leading_whitespace_len = after_colon
            .chars()
            .take_while(|character| character.is_whitespace())
            .map(char::len_utf8)
            .sum::<usize>();
        result.push_str(&after_colon[..leading_whitespace_len]);
        let value_part = &after_colon[leading_whitespace_len..];
        if let Some(stripped) = value_part.strip_prefix('"') {
            result.push_str("\"<redacted>\"");
            let next_quote = stripped.find('"').unwrap_or(stripped.len());
            rest = &stripped[next_quote + usize::from(next_quote < stripped.len())..];
        } else {
            result.push_str("<redacted>");
            let next_separator = value_part
                .find(|character| matches!(character, ',' | '}' | ' ' | '\t'))
                .unwrap_or(value_part.len());
            rest = &value_part[next_separator..];
        }
    }

    result.push_str(rest);
    result
}

fn redact_cookie_pair(value: &str, marker: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;

    while let Some(index) = rest.find(marker) {
        result.push_str(&rest[..index]);
        result.push_str(marker);
        result.push_str("<redacted>");
        let after_marker = &rest[index + marker.len()..];
        let next_separator = after_marker
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ';' | '"' | '\'')
            })
            .unwrap_or(after_marker.len());
        rest = &after_marker[next_separator..];
    }

    result.push_str(rest);
    result
}

fn redact_header_token(value: &str, marker: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;

    while let Some(index) = rest.find(marker) {
        result.push_str(&rest[..index]);
        result.push_str(marker);
        result.push_str("<redacted>");
        let after_marker = &rest[index + marker.len()..];
        let next_separator = after_marker
            .find(|character: char| character.is_whitespace() || matches!(character, '"' | '\''))
            .unwrap_or(after_marker.len());
        rest = &after_marker[next_separator..];
    }

    result.push_str(rest);
    result
}

#[tauri::command]
fn list_rekordbox_playlists(path: String) -> Result<Vec<PlaylistSummary>, String> {
    log_info("list_rekordbox_playlists.start", "path_present=true");
    let xml = read_xml(&path)?;
    let document = parse_xml(&xml)?;
    let playlists = extract_playlists(&document)
        .into_iter()
        .map(|playlist| PlaylistSummary {
            name: playlist.name,
            path: playlist.path,
            track_count: Some(playlist.keys.len()),
        })
        .collect::<Vec<_>>();
    log_info(
        "list_rekordbox_playlists.success",
        format!("playlist_count={}", playlists.len()),
    );
    Ok(playlists)
}

#[tauri::command]
fn write_app_log(level: String, event: String, detail: String) -> Result<(), String> {
    let event = sanitize_log_event(&event);
    match level.as_str() {
        "ERROR" => log_error(&event, detail),
        "WARN" => log_warn(&event, detail),
        "INFO" => log_info(&event, detail),
        _ => return Err("Invalid log level.".to_string()),
    }
    Ok(())
}

#[tauri::command]
fn get_saved_gemini_api_key_status() -> Result<SavedSecretStatus, String> {
    Ok(SavedSecretStatus {
        saved: gemini_api_key_path()?.exists(),
    })
}

#[tauri::command]
fn load_saved_gemini_api_key() -> Result<Option<String>, String> {
    load_gemini_api_key_encrypted()
}

#[tauri::command]
fn store_gemini_api_key(api_key: String) -> Result<SavedSecretStatus, String> {
    store_gemini_api_key_encrypted(&api_key)?;
    Ok(SavedSecretStatus { saved: true })
}

#[tauri::command]
fn clear_gemini_api_key() -> Result<SavedSecretStatus, String> {
    clear_gemini_api_key_file()?;
    Ok(SavedSecretStatus { saved: false })
}

#[tauri::command]
fn get_playlist_tracks(path: String, playlist_key: String) -> Result<Vec<Track>, String> {
    log_info(
        "get_playlist_tracks.start",
        format!("path_present=true playlist_key={playlist_key}"),
    );
    let xml = read_xml(&path)?;
    let document = parse_xml(&xml)?;
    let tracks = extract_collection_tracks(&document);
    let playlists = extract_playlists(&document);
    let playlist = playlists
        .iter()
        .find(|item| local_playlist_key(&item.path, &item.name) == playlist_key)
        .ok_or_else(|| playlist_not_found_message(&playlist_key, &playlists))?;

    let result = playlist
        .keys
        .iter()
        .enumerate()
        .filter_map(|(index, key)| {
            tracks.get(key).map(|track| Track {
                number: index + 1,
                artist: track.artist.clone(),
                title: track.title.clone(),
                bpm: track.bpm,
            })
        })
        .collect::<Vec<_>>();
    log_info(
        "get_playlist_tracks.success",
        format!("track_count={}", result.len()),
    );
    Ok(result)
}

#[tauri::command]
fn read_image_as_data_url(path: String) -> Result<String, String> {
    log_info("read_image_as_data_url.start", "path_present=true");
    let mime = validate_local_image_path(&path)?;
    let bytes = fs::read(&path).map_err(|_| {
        "Warning: background image not found. fallback to default gradient.".to_string()
    })?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    log_info(
        "read_image_as_data_url.success",
        format!("mime={mime} bytes={}", encoded.len()),
    );
    Ok(format!("data:{};base64,{}", mime, encoded))
}

fn call_gemini_generate_content(
    model: &str,
    api_key: &str,
    body: &serde_json::Value,
    event: &str,
) -> Result<String, String> {
    let client = Client::new();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );
    let response = client.post(url).json(body).send().map_err(|error| {
        let message = sanitize_log_detail(&format!("Gemini API呼び出しに失敗: {error}"));
        log_error(format!("{event}.request_error").as_str(), &message);
        message
    })?;
    let status = response.status();
    let raw = response
        .text()
        .map_err(|error| sanitize_log_detail(&format!("Gemini応答読取失敗: {error}")))?;
    if !status.is_success() {
        let message = sanitize_log_detail(&format!(
            "Gemini APIエラー: {status} {}",
            response_snippet(&raw)
        ));
        log_error(format!("{event}.http_error").as_str(), &message);
        return Err(message);
    }

    let gemini: GeminiResponse = serde_json::from_str(&raw).map_err(|error| {
        let message = sanitize_log_detail(&format!("Gemini応答解析失敗: {error}"));
        log_error(format!("{event}.parse_response_error").as_str(), &message);
        message
    })?;
    gemini
        .candidates
        .into_iter()
        .find_map(|candidate| {
            candidate
                .content
                .and_then(|content| content.parts.into_iter().find_map(|part| part.text))
        })
        .ok_or_else(|| "Gemini応答にJSON本文がありません。".to_string())
}

#[tauri::command]
fn extract_setlist_from_image(
    image_path: String,
    api_key: String,
    model: String,
) -> Result<OcrResult, String> {
    log_info(
        "extract_setlist_from_image.start",
        format!("model={model} image_path_present=true"),
    );
    let mime = validate_local_image_path(&image_path)?.to_string();
    let bytes = fs::read(&image_path).map_err(|e| format!("画像を読み込めませんでした: {e}"))?;
    let image_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);

    let prompt = "You are OCR for Japanese DJ setlist cards. Extract only track list. Return ONLY JSON with key tracks. tracks must be an array of objects: {artist,title,bpm}. bpm must be a number without the BPM suffix, or null if unknown. Do not include any other keys. If artist or title is unknown, use empty string.";

    let body = serde_json::json!({
      "contents": [{"parts": [
        {"text": prompt},
        {"inline_data": {"mime_type": mime, "data": image_b64}}
      ]}],
      "generationConfig": {"responseMimeType": "application/json"}
    });

    let json_text =
        call_gemini_generate_content(&model, &api_key, &body, "extract_setlist_from_image")?;
    let parsed: OcrParseResult = serde_json::from_str(&json_text).map_err(|e| {
        let message = format!(
            "OCR JSON解析失敗: {e}. response={}",
            response_snippet(&json_text)
        );
        log_error("extract_setlist_from_image.parse_ocr_error", &message);
        message
    })?;

    let tracks = ocr_tracks_to_tracks(parsed.tracks);

    log_info(
        "extract_setlist_from_image.success",
        format!("track_count={}", tracks.len()),
    );
    Ok(OcrResult { tracks })
}

fn ocr_tracks_to_tracks(tracks: Vec<OcrTrack>) -> Vec<Track> {
    tracks
        .into_iter()
        .enumerate()
        .map(|(idx, track)| Track {
            number: idx + 1,
            artist: track.artist,
            title: track.title,
            bpm: track.bpm,
        })
        .collect::<Vec<_>>()
}

fn deserialize_optional_bpm<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(parse_bpm_value))
}

fn parse_bpm_value(value: serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(number) => number.as_f64().filter(|bpm| bpm.is_finite()),
        serde_json::Value::String(text) => parse_bpm_text(&text),
        _ => None,
    }
}

fn parse_bpm_text(text: &str) -> Option<f64> {
    let normalized = text
        .trim()
        .trim_end_matches(|character: char| character.is_ascii_alphabetic())
        .trim();
    normalized.parse::<f64>().ok().filter(|bpm| bpm.is_finite())
}

#[tauri::command]
fn enrich_tracks_with_gemini(
    api_key: String,
    model: String,
    tracks: Vec<Track>,
) -> Result<TrackEnrichmentResult, String> {
    log_info(
        "enrich_tracks_with_gemini.start",
        format!("model={model} track_count={}", tracks.len()),
    );

    let prompt = "You normalize OCR results for Japanese DJ setlist cards. For each track, infer the official song title and official artist name from the given OCR artist/title. Return ONLY JSON with key tracks. tracks must be an array of objects: {number, artist, title}. Preserve the input number. If you cannot confidently identify a track, return the original artist and title for that number.";
    let input_tracks = tracks
        .iter()
        .map(|track| {
            serde_json::json!({
                "number": track.number,
                "artist": track.artist,
                "title": track.title
            })
        })
        .collect::<Vec<_>>();
    let body = serde_json::json!({
      "contents": [{"parts": [
        {"text": prompt},
        {"text": serde_json::to_string(&serde_json::json!({ "tracks": input_tracks })).unwrap_or_default()}
      ]}],
      "generationConfig": {"responseMimeType": "application/json"}
    });

    let raw = call_gemini_generate_content(&model, &api_key, &body, "enrich_tracks_with_gemini")?;
    let parsed: GeminiTrackEnrichmentResponse = serde_json::from_str(&raw).map_err(|error| {
        let message = format!(
            "Gemini正式曲名JSON解析失敗: {error}. response={}",
            response_snippet(&raw)
        );
        log_error("enrich_tracks_with_gemini.parse_error", &message);
        message
    })?;

    let result = apply_gemini_track_enrichment(tracks, parsed);
    log_info(
        "enrich_tracks_with_gemini.success",
        format!(
            "track_count={} enriched_count={} failed_count={} skipped_count={}",
            result.tracks.len(),
            result.enriched_count,
            result.failed_count,
            result.skipped_count
        ),
    );

    Ok(result)
}

fn apply_gemini_track_enrichment(
    tracks: Vec<Track>,
    parsed: GeminiTrackEnrichmentResponse,
) -> TrackEnrichmentResult {
    let mut normalized_by_number = HashMap::new();
    let mut duplicate_numbers = HashSet::new();
    for normalized in parsed.tracks {
        let number = normalized.number;
        if normalized_by_number.insert(number, normalized).is_some() {
            duplicate_numbers.insert(number);
        }
    }
    let mut enriched_tracks = Vec::with_capacity(tracks.len());
    let mut enriched_count = 0;
    let mut failed_count = 0;
    let mut skipped_count = 0;
    let mut failures = Vec::new();

    for mut track in tracks {
        if track.title.trim().is_empty() {
            skipped_count += 1;
            failures.push(track_enrichment_failure(
                &track,
                "title_missing",
                "OCR結果に曲名がないため正式表記の推定をスキップしました。",
            ));
            enriched_tracks.push(track);
            continue;
        }

        if duplicate_numbers.contains(&track.number) {
            failed_count += 1;
            failures.push(track_enrichment_failure(
                &track,
                "duplicate_gemini_result",
                "Gemini応答に同じ曲番号の結果が複数ありました。",
            ));
            enriched_tracks.push(track);
            continue;
        }

        let Some(normalized) = normalized_by_number.remove(&track.number) else {
            failed_count += 1;
            failures.push(track_enrichment_failure(
                &track,
                "missing_gemini_result",
                "Gemini応答にこの曲番号の結果がありませんでした。",
            ));
            enriched_tracks.push(track);
            continue;
        };

        let next_artist = normalized.artist.trim();
        let next_title = normalized.title.trim();
        if next_title.is_empty() {
            failed_count += 1;
            failures.push(track_enrichment_failure(
                &track,
                "empty_gemini_title",
                "Gemini応答の正式曲名が空でした。",
            ));
            enriched_tracks.push(track);
            continue;
        }

        if track.title.trim() != next_title || track.artist.trim() != next_artist {
            enriched_count += 1;
        }
        track.title = next_title.to_string();
        track.artist = if next_artist.is_empty() {
            track.artist
        } else {
            next_artist.to_string()
        };
        enriched_tracks.push(track);
    }

    TrackEnrichmentResult {
        tracks: enriched_tracks,
        enriched_count,
        failed_count,
        skipped_count,
        failures,
    }
}

#[tauri::command]
fn save_png_files(target_path: String, images: Vec<PngPayload>) -> Result<(), String> {
    log_info(
        "save_png_files.start",
        format!("target_path_present=true image_count={}", images.len()),
    );
    if images.is_empty() {
        return Err("No PNG images to save.".to_string());
    }

    let target = PathBuf::from(target_path);
    validate_png_output_path(&target)?;
    let directory = target
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Invalid output path.".to_string())?;

    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("setlist");

    for (index, image) in images.iter().enumerate() {
        let output_path = if images.len() == 1 {
            target.clone()
        } else {
            directory.join(format!("{}_{:02}.png", stem, index + 1))
        };

        let bytes = decode_png_payload(image)?;
        fs::write(output_path, bytes).map_err(|error| format!("Failed to save PNG: {error}"))?;
    }

    log_info(
        "save_png_files.success",
        format!("image_count={}", images.len()),
    );
    Ok(())
}

fn read_xml(path: &str) -> Result<String, String> {
    validate_rekordbox_xml_path(path)?;
    fs::read_to_string(path).map_err(|error| {
        let message = format!("Error: input XML file not found: {error}");
        log_error("read_xml.error", format!("path_present=true error={error}"));
        message
    })
}

fn validate_rekordbox_xml_path(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_file() {
        return Err("rekordbox XMLファイルを選択してください。".to_string());
    }
    if !has_extension(path, &["xml"]) {
        return Err("rekordbox XMLファイルのみ読み込めます。".to_string());
    }
    Ok(())
}

fn validate_local_image_path(path: &str) -> Result<mime_guess::Mime, String> {
    let path = Path::new(path);
    if !path.is_file() {
        return Err("画像ファイルを選択してください。".to_string());
    }
    if !has_extension(path, &["png", "jpg", "jpeg", "webp"]) {
        return Err("PNG / JPEG / WebP 画像のみ読み込めます。".to_string());
    }
    Ok(mime_guess::from_path(path).first_or_octet_stream())
}

fn validate_png_output_path(path: &Path) -> Result<(), String> {
    if !has_extension(path, &["png"]) {
        return Err("PNGファイルとして保存してください。".to_string());
    }
    let Some(parent) = path.parent() else {
        return Err("Invalid output path.".to_string());
    };
    if !parent.is_dir() {
        return Err("保存先フォルダが見つかりません。".to_string());
    }
    Ok(())
}

fn decode_png_payload(image: &PngPayload) -> Result<Vec<u8>, String> {
    let payload = image
        .data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| format!("Invalid PNG payload: {}", image.file_name))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| format!("Invalid PNG payload: {}", image.file_name))?;
    if png_dimensions(&bytes).is_none() {
        return Err(format!("Invalid PNG payload: {}", image.file_name));
    }
    Ok(bytes)
}

fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            allowed
                .iter()
                .any(|allowed| value.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

fn parse_xml(xml: &str) -> Result<Document<'_>, String> {
    Document::parse(xml).map_err(|error| {
        let message = format!("Error: failed to parse rekordbox XML: {error}");
        log_error("parse_xml.error", &message);
        message
    })
}

fn extract_collection_tracks(document: &Document<'_>) -> HashMap<String, TrackData> {
    let mut tracks = HashMap::new();

    for node in document
        .descendants()
        .filter(|node| node.has_tag_name("TRACK"))
    {
        let Some(track_id) = node.attribute("TrackID") else {
            continue;
        };

        let artist = fallback_text(node.attribute("Artist"), "Unknown Artist");
        let title = fallback_text(node.attribute("Name"), "Unknown Title");
        let bpm = node
            .attribute("AverageBpm")
            .and_then(|value| value.parse::<f64>().ok());
        tracks.insert(track_id.to_string(), TrackData { artist, title, bpm });
    }

    tracks
}

fn extract_playlists(document: &Document<'_>) -> Vec<PlaylistData> {
    let mut result = Vec::new();
    for node in document
        .descendants()
        .filter(|node| node.has_tag_name("NODE"))
    {
        if node.attribute("Type") != Some("1") {
            continue;
        }

        let name = fallback_text(node.attribute("Name"), "Untitled Playlist");
        let keys = node
            .children()
            .filter(|child| child.has_tag_name("TRACK"))
            .filter_map(|track| track.attribute("Key").map(ToString::to_string))
            .collect::<Vec<_>>();

        if keys.is_empty() {
            continue;
        }

        result.push(PlaylistData {
            name,
            path: playlist_path(node),
            keys,
        });
    }

    result
}

fn playlist_path(node: Node<'_, '_>) -> Vec<String> {
    let mut path = Vec::new();
    let mut current = node.parent();

    while let Some(parent) = current {
        if parent.has_tag_name("NODE") {
            if let Some(name) = parent.attribute("Name") {
                path.push(name.to_string());
            }
        }
        current = parent.parent();
    }

    path.reverse();
    path
}

fn fallback_text(value: Option<&str>, fallback: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn local_playlist_key(path: &[String], name: &str) -> String {
    path.iter()
        .map(String::as_str)
        .chain(std::iter::once(name))
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

fn playlist_not_found_message(playlist_key: &str, playlists: &[PlaylistData]) -> String {
    let mut message = format!("Error: playlist not found: {playlist_key}");
    let requested_name = playlist_key.split('\u{1f}').last().unwrap_or(playlist_key);
    let mut candidates = playlists
        .iter()
        .filter(|playlist| {
            playlist.name.contains(requested_name)
                || requested_name.contains(&playlist.name)
                || same_prefix(&playlist.name, requested_name)
        })
        .take(3)
        .map(|playlist| local_playlist_key(&playlist.path, &playlist.name))
        .collect::<Vec<_>>();

    candidates.sort();
    candidates.dedup();

    if !candidates.is_empty() {
        message.push_str("\nDid you mean:");
        for candidate in candidates {
            message.push_str(&format!("\n- {candidate}"));
        }
    }

    message
}

#[allow(dead_code)]
fn response_snippet(body: &str) -> String {
    body.chars()
        .take(480)
        .collect::<String>()
        .replace(['\r', '\n'], " ")
}

fn track_enrichment_failure(
    track: &Track,
    reason: &str,
    detail: impl Into<String>,
) -> TrackEnrichmentFailure {
    TrackEnrichmentFailure {
        number: track.number,
        artist: track.artist.clone(),
        title: track.title.clone(),
        reason: reason.to_string(),
        detail: detail.into(),
    }
}

fn same_prefix(left: &str, right: &str) -> bool {
    let left = left.to_lowercase();
    let right = right.to_lowercase();
    left.chars()
        .zip(right.chars())
        .take_while(|(a, b)| a == b)
        .count()
        >= 4
}

#[tauri::command]
fn get_vrchat_login_status() -> Result<VrcLoginStatus, String> {
    let stored_cookie = match load_vrc_cookie_encrypted() {
        Ok(cookie) => cookie,
        Err(_) => {
            clear_vrc_cookie_file()?;
            return Ok(VrcLoginStatus {
                state: "relogin_required".to_string(),
            });
        }
    };
    if let Some(cookie) = stored_cookie {
        if validate_vrchat_auth_cookie(&cookie)? {
            return Ok(VrcLoginStatus {
                state: "logged_in".to_string(),
            });
        }
        clear_vrc_cookie_file()?;
        return Ok(VrcLoginStatus {
            state: "relogin_required".to_string(),
        });
    }

    Ok(VrcLoginStatus {
        state: "logged_out".to_string(),
    })
}

#[tauri::command]
fn reset_vrchat_login_state(
    pending_uploads: tauri::State<'_, PendingVrcUploadStore>,
) -> Result<(), String> {
    let mut pending = pending_uploads
        .lock()
        .map_err(|_| "VRChatログイン状態の管理に失敗しました。".to_string())?;
    pending.clear();
    drop(pending);
    clear_vrc_cookie_file()
}

#[tauri::command]
fn upload_vrchat_photo_gallery_with_saved_login(
    options: VrcSavedUploadOptions,
) -> Result<VrcUploadResult, String> {
    log_info(
        "upload_vrchat_photo_gallery_with_saved_login.start",
        format!(
            "png_data_url_present={}",
            !options.image.png_data_url.is_empty()
        ),
    );
    let stored_cookie = match load_vrc_cookie_encrypted() {
        Ok(cookie) => cookie,
        Err(_) => {
            clear_vrc_cookie_file()?;
            return Err(
                "保存済みのVRChatログイン状態が無効です。再度ログインしてください。".to_string(),
            );
        }
    };
    let Some(cookie) = stored_cookie else {
        return Err(
            "保存済みのVRChatログイン状態が無効です。再度ログインしてください。".to_string(),
        );
    };

    if !validate_vrchat_auth_cookie(&cookie)? {
        clear_vrc_cookie_file()?;
        return Err(
            "保存済みのVRChatログイン状態が無効です。再度ログインしてください。".to_string(),
        );
    }

    let png = prepare_vrchat_png(&options.image)?;
    let result = match upload_photo_gallery_image_to_vrchat(&cookie, png) {
        Ok(result) => result,
        Err(error) if is_vrchat_auth_rejected_error(&error) => {
            clear_vrc_cookie_file()?;
            return Err(
                "保存済みのVRChatログイン状態が無効です。再度ログインしてください。".to_string(),
            );
        }
        Err(error) => return Err(error),
    };
    log_info(
        "upload_vrchat_photo_gallery_with_saved_login.success",
        format!("gallery_id_present={}", result.gallery_id.is_some()),
    );
    Ok(result)
}

#[tauri::command]
fn begin_vrchat_photo_gallery_upload(
    options: VrcLoginStartOptions,
    pending_uploads: tauri::State<'_, PendingVrcUploadStore>,
) -> Result<VrcPendingEmailOtp, String> {
    log_info(
        "begin_vrchat_photo_gallery_upload.start",
        format!(
            "png_data_url_present={} username_present={} password_present={}",
            !options.image.png_data_url.is_empty(),
            !options.username.is_empty(),
            !options.password.is_empty()
        ),
    );
    let png = prepare_vrchat_png(&options.image)?;
    let auth_cookie = start_vrchat_email_otp_login(&options.username, &options.password)?;
    let request_id = new_pending_vrc_request_id();
    let expires_at_epoch_ms = current_epoch_ms() + VRCHAT_PENDING_LOGIN_TTL_SECS * 1000;

    let mut pending = pending_uploads
        .lock()
        .map_err(|_| "VRChatログイン状態の管理に失敗しました。".to_string())?;
    prune_expired_pending_vrc_uploads(&mut pending);
    pending.insert(
        request_id.clone(),
        PendingVrcUpload {
            auth_cookie,
            png,
            created_at: Instant::now(),
        },
    );

    log_info(
        "begin_vrchat_photo_gallery_upload.pending_email_otp",
        format!(
            "request_id_present={} expires_in_secs={}",
            !request_id.is_empty(),
            VRCHAT_PENDING_LOGIN_TTL_SECS
        ),
    );
    Ok(VrcPendingEmailOtp {
        request_id,
        expires_at_epoch_ms,
        status: "pending_email_otp".to_string(),
    })
}

#[tauri::command]
fn complete_vrchat_email_otp_and_upload(
    options: VrcOtpVerifyOptions,
    pending_uploads: tauri::State<'_, PendingVrcUploadStore>,
) -> Result<VrcUploadResult, String> {
    log_info(
        "complete_vrchat_email_otp_and_upload.start",
        format!(
            "request_id_present={} code_present={}",
            !options.request_id.is_empty(),
            !options.code.is_empty()
        ),
    );
    let mut pending = pending_uploads
        .lock()
        .map_err(|_| "VRChatログイン状態の管理に失敗しました。".to_string())?;
    prune_expired_pending_vrc_uploads(&mut pending);
    let Some(entry) = pending.remove(&options.request_id) else {
        return Err("VRChatのメール認証コード入力期限が切れました。もう一度ログインからやり直してください。".to_string());
    };
    if entry.created_at.elapsed() > Duration::from_secs(VRCHAT_PENDING_LOGIN_TTL_SECS) {
        return Err("VRChatのメール認証コード入力期限が切れました。もう一度ログインからやり直してください。".to_string());
    }
    drop(pending);

    if let Err(error) = verify_vrchat_email_otp(&entry.auth_cookie, &options.code) {
        if entry.created_at.elapsed() <= Duration::from_secs(VRCHAT_PENDING_LOGIN_TTL_SECS) {
            let mut pending = pending_uploads
                .lock()
                .map_err(|_| "VRChatログイン状態の管理に失敗しました。".to_string())?;
            pending.insert(options.request_id, entry);
        }
        return Err(error);
    }

    store_vrc_cookie_encrypted(&entry.auth_cookie)?;

    let result = match upload_photo_gallery_image_to_vrchat(&entry.auth_cookie, entry.png) {
        Ok(result) => result,
        Err(error) if is_vrchat_auth_rejected_error(&error) => {
            clear_vrc_cookie_file()?;
            return Err(
                "保存済みのVRChatログイン状態が無効です。再度ログインしてください。".to_string(),
            );
        }
        Err(error) => return Err(error),
    };
    log_info(
        "complete_vrchat_email_otp_and_upload.success",
        format!("gallery_id_present={}", result.gallery_id.is_some()),
    );
    Ok(result)
}

fn prepare_vrchat_png(options: &VrcImageOptions) -> Result<PreparedVrcPng, String> {
    prepare_vrchat_png_from_data_url(&options.png_data_url)
}

fn prepare_vrchat_png_from_data_url(png_data_url: &str) -> Result<PreparedVrcPng, String> {
    let payload = png_data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "生成画像の形式が不正です。".to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "生成画像の読み取りに失敗しました。".to_string())?;

    if bytes.is_empty() {
        return Err("生成画像が空です。".to_string());
    }

    validate_vrchat_photo_gallery_png(bytes)
}

fn validate_vrchat_photo_gallery_png(bytes: Vec<u8>) -> Result<PreparedVrcPng, String> {
    if bytes.len() >= VRCHAT_PHOTO_GALLERY_MAX_PNG_BYTES {
        return Err("Photo Galleryへ送るPNGは10MB未満にしてください。".to_string());
    }

    let (width, height) = png_dimensions(&bytes)
        .ok_or_else(|| "生成画像のPNGヘッダーを確認できませんでした。".to_string())?;

    if width <= VRCHAT_PHOTO_GALLERY_MIN_DIMENSION || height <= VRCHAT_PHOTO_GALLERY_MIN_DIMENSION {
        return Err("Photo Galleryへ送るPNGは64x64pxより大きい必要があります。".to_string());
    }

    if width >= VRCHAT_PHOTO_GALLERY_MAX_DIMENSION || height >= VRCHAT_PHOTO_GALLERY_MAX_DIMENSION {
        return Err("Photo Galleryへ送るPNGは2048x2048px未満にしてください。".to_string());
    }

    Ok(PreparedVrcPng {
        bytes,
        width,
        height,
    })
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[0..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }

    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

fn start_vrchat_email_otp_login(username: &str, password: &str) -> Result<String, String> {
    log_info(
        "start_vrchat_email_otp_login.start",
        format!(
            "username_present={} password_present={}",
            !username.is_empty(),
            !password.is_empty()
        ),
    );
    let client = Client::new();
    let response = client
        .get("https://api.vrchat.cloud/api/1/auth/user")
        .basic_auth(username, Some(password))
        .header("User-Agent", "SetoriGen/0.1")
        .send()
        .map_err(|_| {
            "VRChatログインに失敗しました。ユーザー名、パスワード、通信状態を確認してください。"
                .to_string()
        })?;
    let status = response.status();
    let auth_cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(extract_auth_cookie);
    let body = response.text().unwrap_or_default();

    if !status.is_success() {
        let message = format!("VRChatログイン失敗: HTTP {}", status);
        log_error("start_vrchat_email_otp_login.http_error", &message);
        return Err(
            "VRChatログインに失敗しました。ユーザー名、パスワード、通信状態を確認してください。"
                .to_string(),
        );
    }
    let auth_cookie =
        auth_cookie.ok_or_else(|| "auth cookieを取得できませんでした。".to_string())?;

    match classify_vrchat_two_factor_requirement(&body)? {
        VrchatTwoFactorRequirementKind::EmailOtpRequired => {
            log_info(
                "start_vrchat_email_otp_login.pending_email_otp",
                "auth_cookie_present=true",
            );
            Ok(auth_cookie)
        }
        VrchatTwoFactorRequirementKind::UnsupportedMethod => Err(
            "このVRChatアカウントの2段階認証方式はemailOtpではないため、SetoriGenでは対応できません。\nVRChatアカウントの2FA設定を確認してください。"
                .to_string(),
        ),
        VrchatTwoFactorRequirementKind::Missing => {
            Err("VRChatからemailOtpの2段階認証要求を確認できませんでした。".to_string())
        }
    }
}

fn extract_auth_cookie(set_cookie_value: &str) -> Option<String> {
    let cookie_pair = set_cookie_value.split(';').next()?.trim();
    let (name, value) = cookie_pair.split_once('=')?;
    if name.trim() != "auth" || value.is_empty() {
        return None;
    }
    Some(format!("auth={}", value))
}

enum VrchatTwoFactorRequirementKind {
    EmailOtpRequired,
    UnsupportedMethod,
    Missing,
}

fn classify_vrchat_two_factor_requirement(
    body: &str,
) -> Result<VrchatTwoFactorRequirementKind, String> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "VRChatの2段階認証要求を判定できませんでした。".to_string())?;
    let response: VrchatTwoFactorResponse = serde_json::from_value(parsed)
        .map_err(|_| "VRChatの2段階認証要求を判定できませんでした。".to_string())?;

    if response
        .requires_two_factor_auth
        .iter()
        .any(|item| item == "emailOtp")
    {
        return Ok(VrchatTwoFactorRequirementKind::EmailOtpRequired);
    }
    if response.requires_two_factor_auth.is_empty() {
        return Ok(VrchatTwoFactorRequirementKind::Missing);
    }
    Ok(VrchatTwoFactorRequirementKind::UnsupportedMethod)
}

fn verify_vrchat_email_otp(cookie: &str, code: &str) -> Result<(), String> {
    let client = Client::new();
    let response = client
        .post("https://api.vrchat.cloud/api/1/auth/twofactorauth/emailotp/verify")
        .header(reqwest::header::COOKIE, cookie)
        .header("User-Agent", "SetoriGen/0.1")
        .json(&serde_json::json!({ "code": code }))
        .send()
        .map_err(|_| "VRChatのメール認証コードを確認してください。失敗が続く場合は、最初からログインし直してください。".to_string())?;

    if !response.status().is_success() {
        let message = format!(
            "verify_vrchat_email_otp.http_error status={}",
            response.status()
        );
        log_error("verify_vrchat_email_otp.http_error", &message);
        return Err("VRChatのメール認証コードを確認してください。失敗が続く場合は、最初からログインし直してください。".to_string());
    }

    Ok(())
}

fn validate_vrchat_auth_cookie(cookie: &str) -> Result<bool, String> {
    let client = Client::new();
    let response = client
        .get("https://api.vrchat.cloud/api/1/auth/user")
        .header(reqwest::header::COOKIE, cookie)
        .header("User-Agent", "SetoriGen/0.1")
        .send()
        .map_err(|_| "保存済みのVRChatログイン状態を確認できませんでした。".to_string())?;
    let status = response.status();
    if status.is_success() {
        return Ok(true);
    }
    if status == StatusCode::UNAUTHORIZED {
        return Ok(false);
    }
    let message = format!("validate_vrchat_auth_cookie.http_error status={status}");
    log_error("validate_vrchat_auth_cookie.http_error", &message);
    Err("保存済みのVRChatログイン状態を確認できませんでした。".to_string())
}

fn upload_photo_gallery_image_to_vrchat(
    cookie: &str,
    png: PreparedVrcPng,
) -> Result<VrcUploadResult, String> {
    log_info(
        "upload_photo_gallery_image_to_vrchat.start",
        format!(
            "method=POST endpoint={} cookie_present={} png_bytes={} width={} height={}",
            VRCHAT_PHOTO_GALLERY_ENDPOINT,
            !cookie.is_empty(),
            png.bytes.len(),
            png.width,
            png.height
        ),
    );
    let client = Client::new();
    let unix_timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("timestampの生成に失敗しました: {e}"))?
        .as_secs();
    let boundary = format!("setorigen-{}", unix_timestamp);
    let body = build_vrchat_photo_gallery_multipart_body(&boundary, &png.bytes);

    let response = client
        .post(VRCHAT_PHOTO_GALLERY_ENDPOINT)
        .header(reqwest::header::COOKIE, cookie)
        .header("User-Agent", "SetoriGen/0.1")
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .map_err(|e| {
            log_error(
                "upload_photo_gallery_image_to_vrchat.send_error",
                format!(
                    "method=POST endpoint={} error={} png_bytes={} width={} height={}",
                    VRCHAT_PHOTO_GALLERY_ENDPOINT,
                    e,
                    png.bytes.len(),
                    png.width,
                    png.height
                ),
            );
            format!("Photo Galleryへのアップロードに失敗しました。ログイン状態、VRC+加入状態、画像サイズを確認してください。詳細: {e}")
        })?;

    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        let detail = format!(
            "method=POST endpoint={} status={} response_body={} png_bytes={} width={} height={}",
            VRCHAT_PHOTO_GALLERY_ENDPOINT,
            status,
            response_snippet(&text),
            png.bytes.len(),
            png.width,
            png.height
        );
        log_error("upload_photo_gallery_image_to_vrchat.http_error", &detail);
        return Err(format!(
            "Photo Galleryへのアップロードに失敗しました。ログイン状態、VRC+加入状態、画像サイズを確認してください。HTTP {} {}",
            status,
            response_snippet(&text)
        ));
    }

    let gallery_id = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()));
    log_info(
        "upload_photo_gallery_image_to_vrchat.success",
        format!("gallery_id_present={}", gallery_id.is_some()),
    );
    Ok(VrcUploadResult {
        gallery_id,
        status: "uploaded_to_photo_gallery".to_string(),
    })
}

fn is_vrchat_auth_rejected_error(error: &str) -> bool {
    error.contains("HTTP 401")
}

fn build_vrchat_photo_gallery_multipart_body(boundary: &str, png_bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"setlist.png\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(png_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

fn store_vrc_cookie_encrypted(cookie: &str) -> Result<(), String> {
    log_info(
        "store_vrc_cookie_encrypted.start",
        format!("cookie_present={}", !cookie.is_empty()),
    );
    let base_dir = setorigen_data_dir()?;
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;
    let out_path = base_dir.join("vrchat_auth_cookie.bin");
    let encrypted = encrypt_cookie_platform(cookie.as_bytes())?;
    fs::write(&out_path, encrypted).map_err(|e| e.to_string())?;
    log_info("store_vrc_cookie_encrypted.success", "path_present=true");
    Ok(())
}

fn store_gemini_api_key_encrypted(api_key: &str) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return clear_gemini_api_key_file();
    }
    log_info(
        "store_gemini_api_key_encrypted.start",
        "api_key_present=true",
    );
    let base_dir = setorigen_data_dir()?;
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;
    let encrypted = encrypt_cookie_platform(api_key.trim().as_bytes())?;
    fs::write(gemini_api_key_path()?, encrypted).map_err(|e| e.to_string())?;
    log_info(
        "store_gemini_api_key_encrypted.success",
        "path_present=true",
    );
    Ok(())
}

fn load_gemini_api_key_encrypted() -> Result<Option<String>, String> {
    let path = gemini_api_key_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let encrypted = fs::read(&path).map_err(|e| e.to_string())?;
    let decrypted = decrypt_cookie_platform(&encrypted)?;
    let api_key = String::from_utf8(decrypted)
        .map_err(|_| "保存済みGemini APIキーの復号に失敗しました。".to_string())?;
    if api_key.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(api_key))
}

fn clear_gemini_api_key_file() -> Result<(), String> {
    let path = gemini_api_key_path()?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn load_vrc_cookie_encrypted() -> Result<Option<String>, String> {
    let path = vrchat_auth_cookie_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let encrypted = fs::read(&path).map_err(|e| e.to_string())?;
    let decrypted = decrypt_cookie_platform(&encrypted)?;
    let cookie = String::from_utf8(decrypted)
        .map_err(|_| "保存済みVRChat認証情報の復号に失敗しました。".to_string())?;
    if cookie.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(cookie))
}

fn clear_vrc_cookie_file() -> Result<(), String> {
    let path = vrchat_auth_cookie_path()?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn vrchat_auth_cookie_path() -> Result<PathBuf, String> {
    Ok(setorigen_data_dir()?.join("vrchat_auth_cookie.bin"))
}

fn gemini_api_key_path() -> Result<PathBuf, String> {
    Ok(setorigen_data_dir()?.join("gemini_api_key.bin"))
}

fn setorigen_data_dir() -> Result<PathBuf, String> {
    Ok(dirs::data_dir()
        .ok_or_else(|| "データ保存先が見つかりません。".to_string())?
        .join("SetoriGen"))
}

fn prune_expired_pending_vrc_uploads(pending: &mut HashMap<String, PendingVrcUpload>) {
    let ttl = Duration::from_secs(VRCHAT_PENDING_LOGIN_TTL_SECS);
    pending.retain(|_, entry| entry.created_at.elapsed() <= ttl);
}

fn new_pending_vrc_request_id() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect()
}

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
fn encrypt_cookie_platform(raw: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(hmem: isize) -> isize;
    }

    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: raw.len() as u32,
        pbData: raw.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut out_blob,
        )
    };
    if ok == 0 {
        return Err("DPAPI暗号化に失敗しました。".to_string());
    }
    let out =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out_blob.pbData as isize);
    }
    Ok(out)
}

#[cfg(windows)]
fn decrypt_cookie_platform(raw: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(hmem: isize) -> isize;
    }

    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: raw.len() as u32,
        pbData: raw.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut out_blob,
        )
    };
    if ok == 0 {
        return Err("保存済みVRChat認証情報の復号に失敗しました。".to_string());
    }
    let out =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out_blob.pbData as isize);
    }
    Ok(out)
}

#[cfg(not(windows))]
fn encrypt_cookie_platform(_raw: &[u8]) -> Result<Vec<u8>, String> {
    Err(
        "この環境ではVRChat auth cookieの安全な暗号化保存が未対応です。Windowsで実行してください。"
            .to_string(),
    )
}

#[cfg(not(windows))]
fn decrypt_cookie_platform(_raw: &[u8]) -> Result<Vec<u8>, String> {
    Err(
        "この環境ではVRChat auth cookieの安全な復号が未対応です。Windowsで実行してください。"
            .to_string(),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(HashMap::<String, PendingVrcUpload>::new()))
        .invoke_handler(tauri::generate_handler![
            list_rekordbox_playlists,
            get_playlist_tracks,
            read_image_as_data_url,
            save_png_files,
            get_saved_gemini_api_key_status,
            load_saved_gemini_api_key,
            store_gemini_api_key,
            clear_gemini_api_key,
            enrich_tracks_with_gemini,
            extract_setlist_from_image,
            get_vrchat_login_status,
            reset_vrchat_login_state,
            upload_vrchat_photo_gallery_with_saved_login,
            begin_vrchat_photo_gallery_upload,
            complete_vrchat_email_otp_and_upload,
            write_app_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_XML: &str = r#"
    <DJ_PLAYLISTS>
      <COLLECTION Entries="2">
        <TRACK TrackID="1" Name="First Track" Artist="Artist A" AverageBpm="170.05" />
        <TRACK TrackID="2" Name="" Artist="" />
      </COLLECTION>
      <PLAYLISTS>
        <NODE Type="0" Name="ROOT">
          <NODE Type="1" Name="2026-04-26 VRC DJ Set">
            <TRACK Key="1" />
            <TRACK Key="2" />
          </NODE>
        </NODE>
      </PLAYLISTS>
    </DJ_PLAYLISTS>
    "#;

    const DUPLICATE_NAME_XML: &str = r#"
    <DJ_PLAYLISTS>
      <COLLECTION Entries="2">
        <TRACK TrackID="1" Name="First Track" Artist="Artist A" />
        <TRACK TrackID="2" Name="Second Track" Artist="Artist B" />
      </COLLECTION>
      <PLAYLISTS>
        <NODE Type="0" Name="ROOT">
          <NODE Type="0" Name="Folder A">
            <NODE Type="1" Name="Same Name">
              <TRACK Key="1" />
            </NODE>
          </NODE>
          <NODE Type="0" Name="Folder B">
            <NODE Type="1" Name="Same Name">
              <TRACK Key="2" />
            </NODE>
          </NODE>
        </NODE>
      </PLAYLISTS>
    </DJ_PLAYLISTS>
    "#;

    fn track(number: usize, artist: &str, title: &str) -> Track {
        Track {
            number,
            artist: artist.to_string(),
            title: title.to_string(),
            bpm: None,
        }
    }

    fn track_with_bpm(number: usize, artist: &str, title: &str, bpm: f64) -> Track {
        Track {
            number,
            artist: artist.to_string(),
            title: title.to_string(),
            bpm: Some(bpm),
        }
    }

    fn gemini_track(number: usize, artist: &str, title: &str) -> GeminiTrackEnrichmentItem {
        GeminiTrackEnrichmentItem {
            number,
            artist: artist.to_string(),
            title: title.to_string(),
        }
    }

    #[test]
    fn redacts_secret_like_values_from_log_detail() {
        let detail = sanitize_log_detail(
            "url=https://example.test/path?key=abc123&x=1 Authorization: Bearer token123 Basic basic456 auth=vrc_auth_secret {\"apiKey\":\"gemini_secret\",\"password\":\"vrc_password\",\"emailOtp\":\"123456\",\"code\":\"654321\"}",
        );

        assert!(!detail.contains("abc123"));
        assert!(!detail.contains("token123"));
        assert!(!detail.contains("basic456"));
        assert!(!detail.contains("vrc_auth_secret"));
        assert!(!detail.contains("gemini_secret"));
        assert!(!detail.contains("vrc_password"));
        assert!(!detail.contains("123456"));
        assert!(!detail.contains("654321"));
        assert!(detail.contains("key=<redacted>"));
        assert!(detail.contains("Bearer <redacted>"));
        assert!(detail.contains("Basic <redacted>"));
        assert!(detail.contains("auth=<redacted>"));
        assert!(detail.contains("\"apiKey\":\"<redacted>\""));
        assert!(detail.contains("\"password\":\"<redacted>\""));
        assert!(detail.contains("\"emailOtp\":\"<redacted>\""));
        assert!(detail.contains("\"code\":\"<redacted>\""));
    }

    #[test]
    fn sanitizes_frontend_log_event_names() {
        assert_eq!(
            sanitize_log_event("ocr.import.error\r\nfake.event"),
            "ocr.import.error__fake.event"
        );
        assert_eq!(sanitize_log_event("   "), "app.event");
    }

    #[test]
    fn validates_public_path_extensions() {
        assert!(has_extension(Path::new("playlist.XML"), &["xml"]));
        assert!(has_extension(
            Path::new("background.JpEg"),
            &["jpg", "jpeg"]
        ));
        assert!(!has_extension(Path::new("notes.txt"), &["xml"]));
    }

    #[test]
    fn applies_gemini_track_enrichment_updates_official_values() {
        let result = apply_gemini_track_enrichment(
            vec![track(1, "normalizer halv", "Pixel Rebelz - Halv Remi")],
            GeminiTrackEnrichmentResponse {
                tracks: vec![gemini_track(
                    1,
                    "Normal1zer, Halv",
                    "Pixel Rebelz - Halv Remix",
                )],
            },
        );

        assert_eq!(result.enriched_count, 1);
        assert_eq!(result.failed_count, 0);
        assert_eq!(result.tracks[0].artist, "Normal1zer, Halv");
        assert_eq!(result.tracks[0].title, "Pixel Rebelz - Halv Remix");
    }

    #[test]
    fn parses_ocr_bpm_values_into_tracks() {
        let parsed: OcrParseResult = serde_json::from_str(
            r#"{
              "tracks": [
                {"artist":"Artist A","title":"Song A","bpm":128},
                {"artist":"Artist B","title":"Song B","bpm":"118.5 BPM"},
                {"artist":"Artist C","title":"Song C","bpm":null}
              ]
            }"#,
        )
        .unwrap();

        let tracks = ocr_tracks_to_tracks(parsed.tracks);

        assert_eq!(tracks[0].number, 1);
        assert_eq!(tracks[0].bpm, Some(128.0));
        assert_eq!(tracks[1].bpm, Some(118.5));
        assert_eq!(tracks[2].bpm, None);
    }

    #[test]
    fn preserves_bpm_when_gemini_enriches_title_and_artist() {
        let result = apply_gemini_track_enrichment(
            vec![track_with_bpm(
                1,
                "normalizer halv",
                "Pixel Rebelz - Halv Remi",
                128.5,
            )],
            GeminiTrackEnrichmentResponse {
                tracks: vec![gemini_track(
                    1,
                    "Normal1zer, Halv",
                    "Pixel Rebelz - Halv Remix",
                )],
            },
        );

        assert_eq!(result.enriched_count, 1);
        assert_eq!(result.tracks[0].artist, "Normal1zer, Halv");
        assert_eq!(result.tracks[0].title, "Pixel Rebelz - Halv Remix");
        assert_eq!(result.tracks[0].bpm, Some(128.5));
    }

    #[test]
    fn keeps_original_track_when_gemini_result_is_missing() {
        let result = apply_gemini_track_enrichment(
            vec![track(1, "Artist A", "Song A")],
            GeminiTrackEnrichmentResponse { tracks: vec![] },
        );

        assert_eq!(result.enriched_count, 0);
        assert_eq!(result.failed_count, 1);
        assert_eq!(result.failures[0].reason, "missing_gemini_result");
        assert_eq!(result.tracks[0].title, "Song A");
    }

    #[test]
    fn keeps_original_track_when_gemini_title_is_empty() {
        let result = apply_gemini_track_enrichment(
            vec![track(1, "Artist A", "Song A")],
            GeminiTrackEnrichmentResponse {
                tracks: vec![gemini_track(1, "Artist A", "")],
            },
        );

        assert_eq!(result.failed_count, 1);
        assert_eq!(result.failures[0].reason, "empty_gemini_title");
        assert_eq!(result.tracks[0].title, "Song A");
    }

    #[test]
    fn skips_gemini_enrichment_when_ocr_title_is_missing() {
        let result = apply_gemini_track_enrichment(
            vec![track(1, "Artist A", "")],
            GeminiTrackEnrichmentResponse {
                tracks: vec![gemini_track(1, "Official Artist", "Official Title")],
            },
        );

        assert_eq!(result.skipped_count, 1);
        assert_eq!(result.failures[0].reason, "title_missing");
        assert_eq!(result.tracks[0].title, "");
    }

    #[test]
    fn rejects_duplicate_gemini_numbers_without_overwriting_track() {
        let result = apply_gemini_track_enrichment(
            vec![track(1, "Artist A", "Song A")],
            GeminiTrackEnrichmentResponse {
                tracks: vec![
                    gemini_track(1, "Official Artist", "Official Title"),
                    gemini_track(1, "Other Artist", "Other Title"),
                ],
            },
        );

        assert_eq!(result.failed_count, 1);
        assert_eq!(result.failures[0].reason, "duplicate_gemini_result");
        assert_eq!(result.tracks[0].artist, "Artist A");
        assert_eq!(result.tracks[0].title, "Song A");
    }

    #[test]
    fn ignores_extra_gemini_numbers_without_failing() {
        let result = apply_gemini_track_enrichment(
            vec![track(1, "Artist A", "Song A")],
            GeminiTrackEnrichmentResponse {
                tracks: vec![
                    gemini_track(1, "Official Artist", "Official Title"),
                    gemini_track(99, "Extra Artist", "Extra Title"),
                ],
            },
        );

        assert_eq!(result.failed_count, 0);
        assert_eq!(result.enriched_count, 1);
        assert_eq!(result.tracks[0].artist, "Official Artist");
        assert_eq!(result.tracks[0].title, "Official Title");
    }

    #[test]
    fn classifies_email_otp_requirement() {
        let result =
            classify_vrchat_two_factor_requirement(r#"{"requiresTwoFactorAuth":["emailOtp"]}"#)
                .unwrap();

        assert!(matches!(
            result,
            VrchatTwoFactorRequirementKind::EmailOtpRequired
        ));
    }

    #[test]
    fn classifies_missing_two_factor_requirement_as_spec_error() {
        let result = classify_vrchat_two_factor_requirement(r#"{"id":"user"}"#).unwrap();

        assert!(matches!(result, VrchatTwoFactorRequirementKind::Missing));
    }

    #[test]
    fn classifies_unsupported_two_factor_requirement() {
        let result =
            classify_vrchat_two_factor_requirement(r#"{"requiresTwoFactorAuth":["totp","otp"]}"#)
                .unwrap();

        assert!(matches!(
            result,
            VrchatTwoFactorRequirementKind::UnsupportedMethod
        ));
    }

    fn png_data_url_with_dimensions(width: u32, height: u32) -> String {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD
                .encode(png_bytes_with_dimensions(width, height))
        )
    }

    fn png_bytes_with_dimensions(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes
    }

    #[test]
    fn decodes_png_data_url_for_vrchat_upload() {
        let data_url = png_data_url_with_dimensions(1920, 1080);
        let png = prepare_vrchat_png_from_data_url(&data_url).unwrap();

        assert!(!png.bytes.is_empty());
        assert_eq!(png.width, 1920);
        assert_eq!(png.height, 1080);
    }

    #[test]
    fn rejects_non_png_data_url_for_vrchat_upload() {
        let error = prepare_vrchat_png_from_data_url("invalid").unwrap_err();

        assert!(error.contains("形式"));
    }

    #[test]
    fn rejects_invalid_png_payload_for_export() {
        let payload = PngPayload {
            file_name: "setlist.png".to_string(),
            data_url: "data:image/png;base64,bm90IGEgcG5n".to_string(),
        };

        let error = decode_png_payload(&payload).unwrap_err();

        assert!(error.contains("Invalid PNG payload"));
    }

    #[test]
    fn rejects_empty_png_data_url_for_vrchat_upload() {
        let error = prepare_vrchat_png_from_data_url("data:image/png;base64,").unwrap_err();

        assert!(error.contains("空"));
    }

    #[test]
    fn rejects_png_that_is_too_large_for_photo_gallery() {
        let mut bytes = png_bytes_with_dimensions(1920, 1080);
        bytes.resize(VRCHAT_PHOTO_GALLERY_MAX_PNG_BYTES, 0);

        let error = validate_vrchat_photo_gallery_png(bytes).unwrap_err();

        assert!(error.contains("10MB"));
    }

    #[test]
    fn rejects_png_dimensions_outside_photo_gallery_limits() {
        let small_error =
            validate_vrchat_photo_gallery_png(png_bytes_with_dimensions(64, 1080)).unwrap_err();
        let large_error =
            validate_vrchat_photo_gallery_png(png_bytes_with_dimensions(2048, 1080)).unwrap_err();

        assert!(small_error.contains("64x64px"));
        assert!(large_error.contains("2048x2048px"));
    }

    #[test]
    fn builds_photo_gallery_multipart_body_with_file_field_only() {
        let body =
            build_vrchat_photo_gallery_multipart_body("setorigen-test", &[0x89, b'P', b'N', b'G']);
        let body_text = String::from_utf8_lossy(&body);

        assert!(body_text
            .contains("Content-Disposition: form-data; name=\"file\"; filename=\"setlist.png\""));
        assert!(body_text.contains("Content-Type: image/png"));
        assert!(!body_text.contains("name=\"image\""));
        assert!(!body_text.contains("name=\"timestamp\""));
    }

    #[test]
    fn extracts_playlists() {
        let document = Document::parse(SAMPLE_XML).unwrap();
        let playlists = extract_playlists(&document);
        assert_eq!(playlists.len(), 1);
        assert_eq!(playlists[0].name, "2026-04-26 VRC DJ Set");
        assert_eq!(playlists[0].track_count(), 2);
    }

    #[test]
    fn extracts_tracks_with_fallbacks() {
        let document = Document::parse(SAMPLE_XML).unwrap();
        let tracks = extract_collection_tracks(&document);
        assert_eq!(tracks["1"].artist, "Artist A");
        assert_eq!(tracks["1"].bpm, Some(170.05));
        assert_eq!(tracks["2"].artist, "Unknown Artist");
        assert_eq!(tracks["2"].title, "Unknown Title");
        assert_eq!(tracks["2"].bpm, None);
    }

    #[test]
    fn builds_unique_keys_for_duplicate_playlist_names() {
        let document = Document::parse(DUPLICATE_NAME_XML).unwrap();
        let playlists = extract_playlists(&document);
        let keys = playlists
            .iter()
            .map(|playlist| local_playlist_key(&playlist.path, &playlist.name))
            .collect::<Vec<_>>();

        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0], keys[1]);
    }

    impl PlaylistData {
        fn track_count(&self) -> usize {
            self.keys.len()
        }
    }
}
