import {
  copyFile,
  mkdir,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    throw new Error(command + ' failed: ' + (stderr || error.message));
  }
}

export async function probeVideo(videoPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,codec_type,width,height,pix_fmt,r_frame_rate',
    '-show_entries', 'format=duration,size,bit_rate',
    '-of', 'json',
    videoPath,
  ]);
  const parsed = JSON.parse(stdout);
  return {
    durationSeconds: Number(parsed?.format?.duration || 0),
    sizeBytes: Number(parsed?.format?.size || 0),
    bitRate: Number(parsed?.format?.bit_rate || 0),
    streams: parsed?.streams || [],
  };
}

export async function extractOneFpsCandidates(videoPath, outputDirectory) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const pattern = join(outputDirectory, 'frame-%06d.jpg');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vf', 'fps=fps=1:start_time=0',
    '-q:v', '2',
    pattern,
  ]);

  let names = (await readdir(outputDirectory))
    .filter((name) => /^frame-\d{6}\.jpg$/.test(name))
    .sort();

  // ffmpeg's fps=1 filter can emit zero frames for a valid sub-second clip.
  // Retain the first decodable frame instead of manufacturing a zero-frame
  // selector input. Malformed media still fails the ffmpeg invocation.
  if (names.length === 0) {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      join(outputDirectory, 'frame-000001.jpg'),
    ]);
    names = (await readdir(outputDirectory))
      .filter((name) => /^frame-\d{6}\.jpg$/.test(name))
      .sort();
  }

  return names.map((name, index) => ({
    index,
    timestampSeconds: index,
    imagePath: resolve(outputDirectory, name),
  }));
}

export function proxyTimestampToSource(timestampSeconds, timestampMap = []) {
  if (!Array.isArray(timestampMap) || timestampMap.length === 0) return null;
  const timestamp = Number(timestampSeconds);
  if (!Number.isFinite(timestamp)) return null;
  const proxyIndex = Math.max(
    0,
    Math.min(timestampMap.length - 1, Math.round(timestamp)),
  );
  return Number(timestampMap[proxyIndex]?.sourceTimestampSeconds);
}

export async function buildProxyVideo(selectedFrames, outputPath) {
  if (!Array.isArray(selectedFrames) || selectedFrames.length === 0) {
    throw new Error('buildProxyVideo requires at least one selected frame');
  }

  const sequenceDirectory = outputPath + '.frames';
  await rm(sequenceDirectory, { recursive: true, force: true });
  await mkdir(sequenceDirectory, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  const timestampMap = [];
  for (let index = 0; index < selectedFrames.length; index += 1) {
    const frame = selectedFrames[index];
    if (!frame?.imagePath) {
      throw new Error('selected frame ' + index + ' is missing imagePath');
    }
    const destination = join(
      sequenceDirectory,
      'frame-' + String(index + 1).padStart(6, '0') + '.jpg',
    );
    await copyFile(frame.imagePath, destination);
    timestampMap.push({
      proxyTimestampSeconds: index,
      sourceFrameIndex: frame.index,
      sourceTimestampSeconds: frame.timestampSeconds,
    });
  }

  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', '1',
    '-i', join(sequenceDirectory, 'frame-%06d.jpg'),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ]);

  await writeFile(
    outputPath + '.timestamp-map.json',
    JSON.stringify(timestampMap, null, 2),
  );

  const probe = await probeVideo(outputPath);
  return {
    outputPath,
    timestampMap,
    probe,
  };
}

export function videoFormatFromPath(videoPath) {
  const extension = extname(videoPath).toLowerCase();
  if (extension === '.mp4') return 'mp4';
  if (extension === '.mov') return 'mov';
  if (extension === '.mkv') return 'mkv';
  if (extension === '.webm') return 'webm';
  throw new Error('Unsupported benchmark video extension: ' + extension);
}
