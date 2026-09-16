import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildProxyVideo,
  extractOneFpsCandidates,
  probeVideo,
  proxyTimestampToSource,
} from '../experiments/focus/media.mjs';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'fd-focus-media-'));

async function ffmpeg(args) {
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

try {
  const shortVideo = join(root, 'short.mp4');
  await ffmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=blue:s=160x90:d=0.25:r=24',
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    shortVideo,
  ]);

  const shortProbe = await probeVideo(shortVideo);
  assert.ok(shortProbe.durationSeconds > 0);
  const shortFrames = await extractOneFpsCandidates(shortVideo, join(root, 'short-frames'));
  assert.ok(shortFrames.length >= 1, 'sub-second video should retain at least one 1-FPS candidate');

  const twoSecondVideo = join(root, 'two-seconds.mp4');
  await ffmpeg([
    '-f', 'lavfi',
    '-i', 'testsrc=size=160x90:rate=24:duration=2',
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    twoSecondVideo,
  ]);
  const frames = await extractOneFpsCandidates(twoSecondVideo, join(root, 'two-frames'));
  assert.ok(frames.length >= 2);
  assert.equal(frames[0].timestampSeconds, 0);
  assert.equal(frames[1].timestampSeconds, 1);

  const proxyPath = join(root, 'proxy.mp4');
  const proxy = await buildProxyVideo(
    [frames[0], frames[frames.length - 1]],
    proxyPath,
  );
  assert.equal(proxy.timestampMap.length, 2);
  assert.equal(proxy.timestampMap[0].sourceTimestampSeconds, frames[0].timestampSeconds);
  assert.equal(
    proxyTimestampToSource(1, proxy.timestampMap),
    frames[frames.length - 1].timestampSeconds,
  );
  assert.ok(proxy.probe.durationSeconds > 0);

  await assert.rejects(
    () => buildProxyVideo([], join(root, 'empty.mp4')),
    /at least one selected frame/,
  );

  const longVideo = join(root, 'long.mp4');
  await ffmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=green:s=160x90:d=120:r=1',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    longVideo,
  ]);
  const longFrames = await extractOneFpsCandidates(longVideo, join(root, 'long-frames'));
  assert.ok(
    longFrames.length >= 119 && longFrames.length <= 121,
    '120-second video should produce approximately 120 one-FPS candidates',
  );

  const malformed = join(root, 'malformed.mp4');
  await writeFile(malformed, 'this is not a video');
  await assert.rejects(() => probeVideo(malformed), /ffprobe failed/);
  await assert.rejects(
    () => extractOneFpsCandidates(malformed, join(root, 'malformed-frames')),
    /ffmpeg failed/,
  );

  console.log('focus media tests passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
