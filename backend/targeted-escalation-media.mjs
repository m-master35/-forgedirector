import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function safeExecutable(value, fallback) {
  const executable = String(value || fallback || '').trim();
  if (!executable) throw new Error('A media executable path is required.');
  return executable;
}

export async function runMediaCommand(executable, args = [], {
  timeoutMs = 60000,
  maxOutputBytes = 1024 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > maxOutputBytes) return next.subarray(next.length - maxOutputBytes);
      return next;
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      const error = new Error(`Media command timed out after ${timeoutMs}ms.`);
      error.code = 'MEDIA_COMMAND_TIMEOUT';
      reject(error);
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdoutText = stdout.toString('utf8');
      const stderrText = stderr.toString('utf8');

      if (code !== 0) {
        const error = new Error(
          `Media command failed with exit code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}: ${stderrText.slice(-4000)}`,
        );
        error.code = 'MEDIA_COMMAND_FAILED';
        error.exitCode = code;
        error.signal = signal;
        error.stderr = stderrText;
        reject(error);
        return;
      }

      resolve({
        stdout: stdoutText,
        stderr: stderrText,
        exitCode: code,
      });
    });
  });
}

export async function probeMedia(filePath, {
  ffprobePath = process.env.TARGETED_ESCALATION_FFPROBE_PATH || 'ffprobe',
  timeoutMs = 30000,
} = {}) {
  const executable = safeExecutable(ffprobePath, 'ffprobe');
  const result = await runMediaCommand(executable, [
    '-v', 'error',
    '-show_entries', 'format=duration,start_time:stream=index,codec_type,duration,start_time',
    '-of', 'json',
    filePath,
  ], { timeoutMs });

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    const error = new Error('ffprobe returned invalid JSON.');
    error.code = 'MEDIA_PROBE_INVALID_JSON';
    throw error;
  }

  const formatDuration = finiteNumber(parsed?.format?.duration);
  const formatStart = finiteNumber(parsed?.format?.start_time);
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];

  return {
    durationSeconds: formatDuration === null ? null : roundMs(formatDuration),
    startTimeSeconds: formatStart === null ? null : roundMs(formatStart),
    streams: streams.map((stream) => ({
      index: finiteNumber(stream?.index),
      codecType: String(stream?.codec_type || ''),
      durationSeconds: finiteNumber(stream?.duration),
      startTimeSeconds: finiteNumber(stream?.start_time),
    })),
  };
}

export async function createSegmentWorkspace({
  prefix = 'forgedirector-targeted-escalation-',
} = {}) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupSegmentWorkspace(workspacePath) {
  if (!workspacePath) return;
  await rm(workspacePath, {
    recursive: true,
    force: true,
  });
}

export function clampRequestedInterval({
  startSeconds,
  endSeconds,
  sourceDurationSeconds = null,
  minimumDurationSeconds = 0.05,
}) {
  let start = finiteNumber(startSeconds);
  let end = finiteNumber(endSeconds);
  const sourceDuration = finiteNumber(sourceDurationSeconds);

  if (start === null || end === null) {
    const error = new Error('Segment startSeconds and endSeconds must be finite numbers.');
    error.code = 'INVALID_SEGMENT_INTERVAL';
    throw error;
  }

  if (start > end) [start, end] = [end, start];

  start = Math.max(0, start);
  end = Math.max(0, end);

  if (sourceDuration !== null && sourceDuration > 0) {
    start = Math.min(start, sourceDuration);
    end = Math.min(end, sourceDuration);
  }

  const duration = end - start;
  if (duration < minimumDurationSeconds) {
    const error = new Error(
      `Segment duration must be at least ${minimumDurationSeconds} seconds after clamping.`,
    );
    error.code = 'SEGMENT_TOO_SHORT';
    throw error;
  }

  return {
    startSeconds: roundMs(start),
    endSeconds: roundMs(end),
    durationSeconds: roundMs(duration),
  };
}

export async function extractMediaSegment({
  inputPath,
  outputPath,
  startSeconds,
  endSeconds,
  sourceDurationSeconds = null,
  mode = 'accurate-transcode',
  ffmpegPath = process.env.TARGETED_ESCALATION_FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.TARGETED_ESCALATION_FFPROBE_PATH || 'ffprobe',
  timeoutMs = 60000,
} = {}) {
  if (!inputPath || !outputPath) {
    const error = new Error('inputPath and outputPath are required.');
    error.code = 'INVALID_SEGMENT_PATH';
    throw error;
  }

  if (!['accurate-transcode', 'stream-copy'].includes(mode)) {
    const error = new Error('Segment mode must be accurate-transcode or stream-copy.');
    error.code = 'INVALID_SEGMENT_MODE';
    throw error;
  }

  const interval = clampRequestedInterval({
    startSeconds,
    endSeconds,
    sourceDurationSeconds,
  });

  const executable = safeExecutable(ffmpegPath, 'ffmpeg');
  const seek = String(interval.startSeconds);
  const duration = String(interval.durationSeconds);

  const common = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', seek,
    '-i', inputPath,
    '-t', duration,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
  ];

  const encoding = mode === 'accurate-transcode'
    ? [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '12',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero',
      ]
    : [
        '-c', 'copy',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero',
      ];

  await runMediaCommand(executable, [
    ...common,
    ...encoding,
    outputPath,
  ], { timeoutMs });

  const outputStat = await stat(outputPath);
  if (!outputStat.size) {
    const error = new Error('Segment extraction produced an empty file.');
    error.code = 'EMPTY_SEGMENT_OUTPUT';
    throw error;
  }

  const outputProbe = await probeMedia(outputPath, {
    ffprobePath,
    timeoutMs: Math.min(timeoutMs, 30000),
  });

  return {
    mode,
    sourceStartSeconds: interval.startSeconds,
    sourceEndSeconds: interval.endSeconds,
    requestedDurationSeconds: interval.durationSeconds,
    outputDurationSeconds: outputProbe.durationSeconds,
    actualSourceStartSeconds: mode === 'accurate-transcode' ? interval.startSeconds : null,
    actualSourceEndSeconds: mode === 'accurate-transcode' && outputProbe.durationSeconds !== null
      ? roundMs(interval.startSeconds + outputProbe.durationSeconds)
      : null,
    mappingPrecision: mode === 'accurate-transcode'
      ? 'accurate_seek_transcode'
      : 'keyframe_approximate',
    outputBytes: outputStat.size,
    outputPath,
    probe: outputProbe,
  };
}
