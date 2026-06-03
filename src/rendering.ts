import type { BackgroundSettings, CardMetadata, GradientPreset, RenderPage, Track } from "./types";

export const CARD_SIZE = 1080;
export const WIDE_CARD_WIDTH = 1920;
export const WIDE_CARD_HEIGHT = 1080;
export const VRCHAT_SAFE_MARGIN_X = 200;
export const VRCHAT_SAFE_MARGIN_Y = 120;
export const TRACKS_PER_COLUMN = 8;
export const VISIBLE_TRACK_LIMIT = TRACKS_PER_COLUMN * 2;
const WIDE_TRACKS_PER_COLUMN = 10;
const WIDE_COLUMN_COUNT = 3;
const WIDE_VISIBLE_TRACK_LIMIT = WIDE_TRACKS_PER_COLUMN * WIDE_COLUMN_COUNT;

const CARD_INNER_RIGHT = 996;
const ACCENT = "#b77cff";
const LIST_START_Y = 445;
const ROW_HEIGHT = 70;
const TITLE_BPM_GAP = 16;
const WIDE_LEFT = 40;
const WIDE_RIGHT = WIDE_CARD_WIDTH - 40;
const WIDE_TOP = 66;
const WIDE_ACCENT = ACCENT;
const WIDE_LIST_START_Y = 360;
const WIDE_ROW_HEIGHT = 58;
const WIDE_COLUMN_GUTTER = 24;
const WIDE_COLUMN_SEPARATOR_TOP = WIDE_LIST_START_Y - 26;
const WIDE_COLUMN_SEPARATOR_BOTTOM = 918;
const WIDE_OMITTED_LABEL_Y = 938;

const gradients: Record<GradientPreset, [string, string, string]> = {
  "neon-purple": ["#1b063d", "#243ed8", "#ff3dab"],
  "cyber-blue": ["#020712", "#063a88", "#28e5ff"],
  "sunset-magenta": ["#22091f", "#b51f71", "#ff8f5a"],
  "dark-club": ["#03040a", "#111f3f", "#2d2b6f"]
};

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function createPages(tracks: Track[], totalTrackCount = tracks.length): RenderPage[] {
  return [
    {
      pageNumber: 1,
      pageCount: 1,
      tracks: tracks.slice(0, VISIBLE_TRACK_LIMIT),
      hasOmittedTracks: totalTrackCount > VISIBLE_TRACK_LIMIT,
      omittedTrackCount: Math.max(0, totalTrackCount - VISIBLE_TRACK_LIMIT),
      totalTrackCount
    }
  ];
}

export function formatBpm(bpm: number | null): string {
  if (bpm === null || Number.isNaN(bpm)) {
    return "";
  }

  const rounded = Math.round((bpm + Number.EPSILON) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} BPM`;
}

export async function renderCardToCanvas(
  canvas: HTMLCanvasElement,
  page: RenderPage,
  metadata: CardMetadata,
  background: BackgroundSettings
): Promise<void> {
  canvas.width = CARD_SIZE;
  canvas.height = CARD_SIZE;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas is not available.");
  }

  await drawBackground(ctx, background);
  drawHeader(ctx, metadata);
  drawSetlist(ctx, page);
}

export async function renderWideCardToCanvas(
  canvas: HTMLCanvasElement,
  tracks: Track[],
  totalTrackCount: number,
  metadata: CardMetadata,
  background: BackgroundSettings
): Promise<void> {
  canvas.width = WIDE_CARD_WIDTH;
  canvas.height = WIDE_CARD_HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas is not available.");
  }

  await drawBackground(ctx, background, WIDE_CARD_WIDTH, WIDE_CARD_HEIGHT);
  drawWideHeader(ctx, metadata);
  const visibleTracks = tracks.slice(0, WIDE_VISIBLE_TRACK_LIMIT);
  drawWideSetlist(ctx, visibleTracks, Math.max(0, totalTrackCount - visibleTracks.length));
  drawWideFooter(ctx, metadata);
}

export async function renderVrchatExportCardToCanvas(
  canvas: HTMLCanvasElement,
  tracks: Track[],
  totalTrackCount: number,
  metadata: CardMetadata,
  background: BackgroundSettings
): Promise<void> {
  canvas.width = WIDE_CARD_WIDTH;
  canvas.height = WIDE_CARD_HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas is not available.");
  }

  await drawBackground(ctx, background, WIDE_CARD_WIDTH, WIDE_CARD_HEIGHT);

  const safeWidth = WIDE_CARD_WIDTH - VRCHAT_SAFE_MARGIN_X * 2;
  const safeHeight = WIDE_CARD_HEIGHT - VRCHAT_SAFE_MARGIN_Y * 2;
  const scale = Math.min(safeWidth / WIDE_CARD_WIDTH, safeHeight / WIDE_CARD_HEIGHT);
  const contentWidth = WIDE_CARD_WIDTH * scale;
  const contentHeight = WIDE_CARD_HEIGHT * scale;
  const contentX = (WIDE_CARD_WIDTH - contentWidth) / 2;
  const contentY = (WIDE_CARD_HEIGHT - contentHeight) / 2;

  ctx.save();
  ctx.translate(contentX, contentY);
  ctx.scale(scale, scale);
  drawWideHeader(ctx, metadata);
  const visibleTracks = tracks.slice(0, WIDE_VISIBLE_TRACK_LIMIT);
  drawWideSetlist(ctx, visibleTracks, Math.max(0, totalTrackCount - visibleTracks.length));
  drawWideFooter(ctx, metadata);
  ctx.restore();
}

async function drawBackground(
  ctx: CanvasRenderingContext2D,
  background: BackgroundSettings,
  width = CARD_SIZE,
  height = CARD_SIZE
): Promise<void> {
  if (background.mode === "image" && background.imageDataUrl) {
    try {
      const image = await loadImage(background.imageDataUrl);
      const scale = Math.max(width / image.width, height / image.height);
      const imageWidth = image.width * scale;
      const imageHeight = image.height * scale;
      ctx.drawImage(image, (ctx.canvas.width - imageWidth) / 2, (ctx.canvas.height - imageHeight) / 2, imageWidth, imageHeight);
      ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      drawDarkOverlay(ctx, ctx.canvas.width, ctx.canvas.height);
      return;
    } catch {
      drawPosterBackground(ctx, width, height);
      return;
    }
  }

  if (background.mode === "solid") {
    drawSolidBackground(ctx, background.color, width, height);
    return;
  }

  drawGradientBackground(ctx, background.gradientPreset || "neon-purple", width, height);
}

function drawGradientBackground(ctx: CanvasRenderingContext2D, preset: GradientPreset, width = CARD_SIZE, height = CARD_SIZE): void {
  const [start, mid, end] = gradients[preset] ?? gradients["neon-purple"];
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, start);
  gradient.addColorStop(0.55, mid);
  gradient.addColorStop(1, end);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * 0.76, height * 0.22, 40, width * 0.76, height * 0.22, Math.max(width, height) * 0.58);
  glow.addColorStop(0, "rgba(255,255,255,0.18)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  drawDarkOverlay(ctx, width, height);
}

function drawSolidBackground(ctx: CanvasRenderingContext2D, color: string, width = CARD_SIZE, height = CARD_SIZE): void {
  ctx.fillStyle = color || "#111111";
  ctx.fillRect(0, 0, width, height);
  drawDarkOverlay(ctx, width, height);
}

function drawPosterBackground(ctx: CanvasRenderingContext2D, width = CARD_SIZE, height = CARD_SIZE): void {
  drawGradientBackground(ctx, "neon-purple", width, height);
}

function drawDarkOverlay(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.beginPath();
  ctx.moveTo(width * 0.86, 0);
  ctx.lineTo(width, 0);
  ctx.lineTo(width, height);
  ctx.lineTo(width * 0.56, height);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(183, 124, 255, 0.045)";
  ctx.beginPath();
  ctx.moveTo(width * 0.88, 0);
  ctx.lineTo(width, 0);
  ctx.lineTo(width, height);
  ctx.lineTo(width * 0.68, height);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHeader(ctx: CanvasRenderingContext2D, metadata: CardMetadata): void {
  const left = 62;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (metadata.message.trim()) {
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.font = monoFont(23, 400);
    ctx.fillText(truncateText(ctx, metadata.message.trim(), 570), left, 56);
  }

  ctx.fillStyle = "#ffffff";
  const titleLines = titleLinesFor(metadata.eventName || "EVENT NAME");
  titleLines.forEach((line, index) => {
    fitTextLeft(ctx, line, left, 130 + index * 106, 720, 94, 54, 900, titleFont);
  });

  const metaY = 338;
  drawCalendarIcon(ctx, left + 2, metaY - 15);
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  ctx.font = font(24, 400);
  ctx.fillText(metadata.date || "YYYY/MM/DD", left + 50, metaY);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText("|", left + 238, metaY);
  const playedByX = left + 280;
  const playedBy = "Played by ";
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText(playedBy, playedByX, metaY);
  ctx.fillStyle = ACCENT;
  ctx.fillText(metadata.vrcName || "VRC Name", playedByX + ctx.measureText(playedBy).width, metaY);

  ctx.strokeStyle = "rgba(183,124,255,0.72)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(60, 392);
  ctx.lineTo(1030, 392);
  ctx.stroke();
}

function drawSetlist(ctx: CanvasRenderingContext2D, page: RenderPage): void {
  const rowCount = Math.min(TRACKS_PER_COLUMN, page.tracks.length);
  const columns = [
    { lineStart: 62, numberX: 100, textX: 128, rightEdge: 512 },
    { lineStart: 568, numberX: 600, textX: 648, rightEdge: 1000 }
  ];
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  drawColumnSeparator(ctx, 540);

  page.tracks.forEach((track, index) => {
    const columnIndex = index < TRACKS_PER_COLUMN ? 0 : 1;
    const column = columns[columnIndex];
    const rowIndex = index % TRACKS_PER_COLUMN;
    const y = LIST_START_Y + rowIndex * ROW_HEIGHT;
    const hasArtist = track.artist.trim().length > 0;
    const bpm = formatBpm(track.bpm);
    const trackNumber = track.number.toString().padStart(2, "0");
    ctx.font = font(18, 700);
    const bpmWidth = bpm ? ctx.measureText(bpm).width : 0;
    const availableWidth = column.rightEdge - column.textX - bpmWidth - (bpm ? TITLE_BPM_GAP : 0);
    ctx.font = font(22, 800);
    const title = truncateText(ctx, track.title, availableWidth);
    const titleY = hasArtist ? y - 10 : y;
    const bpmY = hasArtist ? y - 16 : titleY;

    drawRowRule(ctx, column.lineStart, column.rightEdge, y + 36);

    ctx.textAlign = "right";
    ctx.fillStyle = ACCENT;
    ctx.font = monoFont(30, 500);
    ctx.fillText(trackNumber, column.numberX, y);
    ctx.textAlign = "left";

    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(title, column.textX, titleY);

    if (hasArtist) {
      ctx.font = font(18, 600);
      ctx.fillStyle = "rgba(255,255,255,0.68)";
      const artist = truncateText(ctx, track.artist.trim(), column.rightEdge - column.textX);
      ctx.fillText(artist, column.textX, y + 20);
    }

    if (bpm) {
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.68)";
      ctx.font = font(18, 700);
      ctx.fillText(bpm, column.rightEdge, bpmY);
      ctx.textAlign = "left";
    }
  });

  if (page.hasOmittedTracks) {
    const y = LIST_START_Y + rowCount * ROW_HEIGHT + 6;
    const rightColumnCenterX = (columns[1].textX + columns[1].rightEdge) / 2;
    ctx.fillStyle = "rgba(255,255,255,0.68)";
    ctx.font = font(22, 700);
    ctx.textAlign = "center";
    ctx.fillText(`and ${page.omittedTrackCount} more tracks...`, rightColumnCenterX, y);
    ctx.textAlign = "left";
  }

  if (page.pageCount > 1) {
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.58)";
    ctx.font = font(20, 700);
    ctx.fillText(`Page ${page.pageNumber} / ${page.pageCount}`, columns[1].rightEdge, 944);
    ctx.textAlign = "left";
  }

  drawFooterDecorations(ctx);
}

function drawWideHeader(ctx: CanvasRenderingContext2D, metadata: CardMetadata): void {
  const rightLimit = WIDE_RIGHT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  if (metadata.message.trim()) {
    ctx.fillStyle = "rgba(255,255,255,0.84)";
    ctx.font = monoFont(28, 400);
    ctx.fillText(truncateText(ctx, metadata.message.trim(), rightLimit - WIDE_LEFT), WIDE_LEFT, WIDE_TOP);
  }

  ctx.fillStyle = "#ffffff";
  fitTextLeft(ctx, metadata.eventName || "EVENT NAME", WIDE_LEFT, 152, rightLimit - WIDE_LEFT, 90, 58, 900, titleFont);

  const metaY = 246;
  drawCalendarIcon(ctx, WIDE_LEFT + 2, metaY - 15);
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  ctx.font = font(30, 400);
  ctx.fillText(metadata.date || "YYYY/MM/DD", WIDE_LEFT + 50, metaY);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText("|", WIDE_LEFT + 275, metaY);
  const playedByX = WIDE_LEFT + 320;
  const playedBy = "Played by ";
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText(playedBy, playedByX, metaY);
  ctx.fillStyle = WIDE_ACCENT;
  ctx.fillText(truncateText(ctx, metadata.vrcName || "VRC Name", rightLimit - playedByX - ctx.measureText(playedBy).width), playedByX + ctx.measureText(playedBy).width, metaY);

  ctx.strokeStyle = "rgba(183,124,255,0.72)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(WIDE_LEFT, 306);
  ctx.lineTo(WIDE_RIGHT, 306);
  ctx.stroke();
}

function drawWideSetlist(ctx: CanvasRenderingContext2D, tracks: Track[], omittedTrackCount: number): void {
  const columnWidth = (WIDE_RIGHT - WIDE_LEFT - WIDE_COLUMN_GUTTER * (WIDE_COLUMN_COUNT - 1)) / WIDE_COLUMN_COUNT;
  const columns = Array.from({ length: WIDE_COLUMN_COUNT }, (_, index) => {
    const left = WIDE_LEFT + index * (columnWidth + WIDE_COLUMN_GUTTER);
    return {
      centerX: left + columnWidth / 2,
      numberX: left + 28,
      left,
      rightEdge: left + columnWidth,
      textX: left + 46
    };
  });
  const titleSize = Math.floor(WIDE_ROW_HEIGHT * 0.45);
  const artistSize = Math.floor(WIDE_ROW_HEIGHT * 0.31);
  const bpmSize = Math.floor(WIDE_ROW_HEIGHT * 0.29);

  columns.slice(0, -1).forEach((column) => {
    drawVerticalSeparator(
      ctx,
      column.rightEdge + WIDE_COLUMN_GUTTER / 2,
      WIDE_COLUMN_SEPARATOR_TOP,
      WIDE_COLUMN_SEPARATOR_BOTTOM
    );
  });

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  tracks.forEach((track, index) => {
    const columnIndex = Math.floor(index / WIDE_TRACKS_PER_COLUMN);
    const rowIndex = index % WIDE_TRACKS_PER_COLUMN;
    const column = columns[columnIndex];
    const y = WIDE_LIST_START_Y + rowIndex * WIDE_ROW_HEIGHT;
    const hasArtist = track.artist.trim().length > 0;
    const trackNumber = track.number.toString().padStart(2, "0");
    const bpm = formatBpm(track.bpm);
    const bpmWidth = bpm ? 88 : 0;
    const titleMaxWidth = column.rightEdge - column.textX - bpmWidth - (bpm ? 18 : 0);
    const baseTitleY = y - WIDE_ROW_HEIGHT * 0.17;
    const artistY = y + WIDE_ROW_HEIGHT * 0.29;
    const titleY = hasArtist ? baseTitleY : y;

    drawRowRule(ctx, column.left, column.rightEdge, y + WIDE_ROW_HEIGHT / 2 - 2);

    ctx.textAlign = "right";
    ctx.fillStyle = WIDE_ACCENT;
    ctx.font = monoFont(Math.min(28, titleSize), 500);
    ctx.fillText(trackNumber, column.numberX, y);
    ctx.textAlign = "left";

    ctx.fillStyle = "rgba(255,255,255,0.93)";
    ctx.font = font(titleSize, 800);
    ctx.fillText(truncateText(ctx, track.title, titleMaxWidth), column.textX, titleY);

    if (hasArtist) {
      ctx.fillStyle = "rgba(255,255,255,0.68)";
      ctx.font = font(artistSize, 600);
      ctx.fillText(truncateText(ctx, track.artist.trim(), column.rightEdge - column.textX), column.textX, artistY);
    }

    if (bpm) {
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.68)";
      ctx.font = font(bpmSize, 700);
      ctx.fillText(truncateText(ctx, bpm, bpmWidth), column.rightEdge, titleY);
      ctx.textAlign = "left";
    }
  });

  if (omittedTrackCount > 0) {
    const x = columns[columns.length - 1]?.centerX ?? (WIDE_LEFT + WIDE_RIGHT) / 2;
    ctx.fillStyle = "rgba(255,255,255,0.68)";
    ctx.font = font(24, 700);
    ctx.textAlign = "center";
    ctx.fillText(`and ${omittedTrackCount} more tracks...`, x, WIDE_OMITTED_LABEL_Y);
    ctx.textAlign = "left";
  }
}

function drawWideFooter(ctx: CanvasRenderingContext2D, metadata: CardMetadata): void {
  ctx.strokeStyle = "rgba(183,124,255,0.7)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(WIDE_LEFT, 1000);
  ctx.lineTo(WIDE_LEFT + 720, 1000);
  ctx.stroke();

  drawSparkle(ctx, WIDE_LEFT + 10, 1032);
}

function drawColumnSeparator(ctx: CanvasRenderingContext2D, x: number): void {
  drawVerticalSeparator(ctx, x, LIST_START_Y - 28, 960);
}

function drawVerticalSeparator(ctx: CanvasRenderingContext2D, x: number, startY: number, endY: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.68)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, startY);
  ctx.lineTo(x, endY);
  ctx.stroke();
  ctx.restore();
}

function drawRowRule(ctx: CanvasRenderingContext2D, startX: number, endX: number, y: number): void {
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(startX, y);
  ctx.lineTo(endX, y);
  ctx.stroke();
}

function drawFooterDecorations(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = "rgba(183,124,255,0.7)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(56, 990);
  ctx.lineTo(692, 990);
  ctx.stroke();

  drawSparkle(ctx, 66, 1030);
  ctx.strokeStyle = "rgba(183,124,255,0.82)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 118; i += 1) {
    const x = 96 + i * 1.8;
    const height = i % 5 === 0 ? 22 : i % 3 === 0 ? 18 : 13;
    ctx.beginPath();
    ctx.moveTo(x, 1020);
    ctx.lineTo(x, 1020 + height);
    ctx.stroke();
  }
}

function drawCalendarIcon(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = "rgba(183,124,255,0.16)";
  ctx.lineWidth = 2;
  roundedRect(ctx, x, y, 30, 27, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x + 6, y - 4, 4, 8);
  ctx.fillRect(x + 20, y - 4, 4, 8);
  ctx.fillRect(x + 6, y + 10, 4, 4);
  ctx.fillRect(x + 14, y + 10, 4, 4);
  ctx.fillRect(x + 22, y + 10, 4, 4);
  ctx.fillRect(x + 6, y + 18, 4, 4);
  ctx.fillRect(x + 14, y + 18, 4, 4);
  ctx.fillRect(x + 22, y + 18, 4, 4);
  ctx.restore();
}

function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.moveTo(x, y - 11);
  ctx.quadraticCurveTo(x + 4, y - 4, x + 12, y);
  ctx.quadraticCurveTo(x + 4, y + 4, x, y + 12);
  ctx.quadraticCurveTo(x - 4, y + 4, x - 12, y);
  ctx.quadraticCurveTo(x - 4, y - 4, x, y - 11);
  ctx.fill();
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached) {
    return cached;
  }

  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
  imageCache.set(src, request);
  return request;
}

function fitTextLeft(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  weight: number,
  fontFamily: (size: number, weight: number) => string = font
): void {
  let size = maxSize;
  ctx.textAlign = "left";
  while (size > minSize) {
    ctx.font = fontFamily(size, weight);
    if (ctx.measureText(text).width <= maxWidth) {
      ctx.fillText(text, x, y);
      return;
    }
    size -= 2;
  }

  ctx.font = fontFamily(minSize, weight);
  ctx.fillText(truncateText(ctx, text, maxWidth), x, y);
}

function titleLinesFor(text: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 2) {
    return [text.trim() || "EVENT NAME"];
  }
  return [words[0], words.slice(1).join(" ")];
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  const ellipsis = "...";
  let result = text;
  while (result.length > 0 && ctx.measureText(`${result}${ellipsis}`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}${ellipsis}`;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function font(size: number, weight: number): string {
  return `${weight} ${size}px "Yu Gothic", "Meiryo", "Noto Sans JP", system-ui, sans-serif`;
}

function titleFont(size: number, weight: number): string {
  return `${weight} ${size}px Impact, "Arial Narrow", "Yu Gothic", "Meiryo", sans-serif`;
}

function monoFont(size: number, weight: number): string {
  return `${weight} ${size}px "Arial Narrow", "Yu Gothic", "Meiryo", monospace`;
}
