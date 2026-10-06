// Opt-in macOS integration check. Run against the exact owned dev window after
// showing /test/fixtures/native-overlay-probe.html in CEF. WK-only screenshots
// and native visible/Ready flags cannot catch a browser behind an opaque layer.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const { values } = parseArgs({ options: {
  pid: { type: 'string' },
  window: { type: 'string' },
  bounds: { type: 'string' },
  output: { type: 'string' },
} });
const pid = Number(values.pid);
const windowId = Number(values.window);
const bounds = values.bounds?.split(',').map(Number);
if (!Number.isSafeInteger(pid) || pid <= 0
    || !Number.isSafeInteger(windowId) || windowId <= 0
    || bounds?.length !== 4 || !bounds.every(Number.isFinite)
    || bounds[0] < 0 || bounds[1] < 0 || bounds[2] <= 0 || bounds[3] <= 0
    || !values.output) {
  throw new Error('Usage: node test/check-native-overlay-compositor.mjs --pid PID --window ID --bounds x,y,width,height --output /absolute/receipt.json');
}
const output = resolve(values.output);
const screenshot = output.replace(/\.json$/, '') + '.png';
await mkdir(dirname(output), { recursive: true });
const capture = JSON.parse(execFileSync('cua-driver', ['get_window_state', JSON.stringify({
  pid, window_id: windowId, include_accessibility_tree: false,
  max_dimension: 1568, screenshot_out_file: screenshot,
})], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }));
if (capture.pid !== pid || capture.window_id !== windowId
    || !capture.screenshot_frame_valid || capture.screenshot_file_path !== screenshot) {
  throw new Error('Native capture did not verify the requested window/pixel frame');
}
const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const [x, y, width, height] = bounds;
const host = capture.window_bounds;
if (x + width > host.width + 1 || y + height > host.height + 1) {
  throw new Error(`CEF bounds ${bounds} are outside the captured window ${host.width}x${host.height}`);
}
const sx = info.width / host.width;
const sy = info.height / host.height;
const left = Math.ceil((x + 2) * sx);
const top = Math.ceil((y + 2) * sy);
const right = Math.floor((x + width - 2) * sx);
const bottom = Math.floor((y + height - 2) * sy);
const step = Math.max(2, Math.floor(Math.min(right - left, bottom - top) / 120));
let samples = 0;
let cefPixels = 0;
let controlPixels = 0;
for (let py = top; py < bottom; py += step) {
  for (let px = left; px < right; px += step) {
    const offset = (py * info.width + px) * info.channels;
    const [r, g, b] = data.subarray(offset, offset + 3);
    // Fixed fixture background #154d65; also recognize it through the modal
    // scrim. Gray/white parent backing cannot satisfy these channel ratios.
    if (r < 35 && g > 15 && b > 20
        && g > r * 1.8 && b > g * 1.15 && b < g * 1.6) cefPixels++;
    if (g > 20 && g > r * 1.08 && g > b * 1.04) controlPixels++;
    samples++;
  }
}
const fraction = samples ? cefPixels / samples : 0;
const controlFraction = samples ? controlPixels / samples : 0;
const receipt = {
  capturedAt: new Date().toISOString(), pid, windowId, bounds,
  // A background-only backing-store capture is insufficient: require the
  // fixture's green browser controls too. Keep the window visible to capture
  // Chromium's composited content rather than an off-Space cached background.
  cefFixturePixelsVisible: fraction >= 0.08 && controlFraction >= 0.015,
  cefPixelFraction: fraction, cefControlPixelFraction: controlFraction, samples,
  screenshot, frameValid: capture.screenshot_frame_valid,
  frameFreshness: capture.background_input?.observation?.frame_freshness ?? 'unknown',
  scope: 'Native compositor pixels for the fixed local CEF page; no pointer or keyboard acceptance claim',
};
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
if (!receipt.cefFixturePixelsVisible) process.exitCode = 1;
