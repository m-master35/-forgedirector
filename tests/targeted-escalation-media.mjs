import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  clampRequestedInterval,
  cleanupSegmentWorkspace,
  createSegmentWorkspace,
  extractMediaSegment,
  probeMedia,
  runMediaCommand,
} from '../backend/targeted-escalation-media.mjs';

const ffmpegPath = process.env.TARGETED_ESCALATION_FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.TARGETED_ESCALATION_FFPROBE_PATH || 'ffprobe';

assert.deepEqual(
  clampRequestedInterval({
    startSeconds: -2,
    endSeconds: 8,
    sourceDurationSeconds: 5,
  }),
  {
    startSeconds: 0,
    endSeconds: 5,
    durationSeconds: 5,
  },
);

assert.deepEqual(
  clampRequestedInterval({
    startSeconds: 4,
    endSeconds: 2,
    sourceDurationSeconds: 10,
  }),
  {
    startSeconds: 2,
    endSeconds: 4,
    durationSeconds: 2,
  },
);

assert.throws(
  () => clampRequestedInterval({ startSeconds: 1, endSeconds: 1.01 }),
  /at least 0.05 seconds/,
);

const workspace = await createSegmentWorkspace();

try {
  const sourcePath = path.join(workspace, 'source.mp4');
  await runMediaCommand(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=30',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:sample_rate=44100',
    '-t', '4',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    sourcePath,
  ], { timeoutMs: 60000 });

  const sourceProbe = await probeMedia(sourcePath, { ffprobePath });
  assert.ok(sourceProbe.durationSeconds >= 3.9 && sourceProbe.durationSeconds <= 4.1);
  assert.ok(sourceProbe.streams.some((stream) => stream.codecType === 'video'));
  assert.ok(sourceProbe.streams.some((stream) => stream.codecType === 'audio'));

  const accuratePath = path.join(workspace, 'accurate.mp4');
  const accurate = await extractMediaSegment({
    inputPath: sourcePath,
    outputPath: accuratePath,
    startSeconds: 1,
    endSeconds: 2.5,
    sourceDurationSeconds: sourceProbe.durationSeconds,
    mode: 'accurate-transcode',
    ffmpegPath,
    ffprobePath,
  });

  assert.equal(accurate.sourceStartSeconds, 1);
  assert.equal(accurate.sourceEndSeconds, 2.5);
  assert.equal(accurate.mappingPrecision, 'accurate_seek_transcode');
  assert.equal(accurate.actualSourceStartSeconds, 1);
  assert.ok(accurate.outputDurationSeconds >= 1.3 && accurate.outputDurationSeconds <= 1.7);
  assert.ok(accurate.outputBytes > 0);

  const shortPath = path.join(workspace, 'short.mp4');
  const short = await extractMediaSegment({
    inputPath: sourcePath,
    outputPath: shortPath,
    startSeconds: 0.5,
    endSeconds: 0.65,
    sourceDurationSeconds: sourceProbe.durationSeconds,
    mode: 'accurate-transcode',
    ffmpegPath,
    ffprobePath,
  });

  assert.ok(short.outputDurationSeconds > 0);
  assert.ok(short.outputDurationSeconds <= 0.35);

  const copyPath = path.join(workspace, 'copy.mp4');
  const copied = await extractMediaSegment({
    inputPath: sourcePath,
    outputPath: copyPath,
    startSeconds: 1,
    endSeconds: 2.5,
    sourceDurationSeconds: sourceProbe.durationSeconds,
    mode: 'stream-copy',
    ffmpegPath,
    ffprobePath,
  });

  assert.equal(copied.mappingPrecision, 'keyframe_approximate');
  assert.equal(copied.actualSourceStartSeconds, null);
  assert.ok(copied.outputBytes > 0);

  const malformedPath = path.join(workspace, 'malformed.mp4');
  await writeFile(malformedPath, 'not a video', 'utf8');

  await assert.rejects(
    extractMediaSegment({
      inputPath: malformedPath,
      outputPath: path.join(workspace, 'should-not-exist.mp4'),
      startSeconds: 0,
      endSeconds: 1,
      mode: 'accurate-transcode',
      ffmpegPath,
      ffprobePath,
    }),
    /Media command failed/,
  );
} finally {
  await cleanupSegmentWorkspace(workspace);
}

console.log('Targeted escalation media tests passed');
