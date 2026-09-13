import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertAssetId, videoFormatFromContentType } from './video-intelligence.mjs';

const s3 = new S3Client({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

const VIDEO_BUCKET = process.env.VIDEO_BUCKET || '';
const VIDEO_PREFIX = String(process.env.VIDEO_PREFIX || 'video-assets').replace(/^\/+|\/+$/g, '');
const ANALYSIS_CACHE_PREFIX = String(process.env.ANALYSIS_CACHE_PREFIX || 'analysis-cache').replace(/^\/+|\/+$/g, '');
const ANALYSIS_CACHE_TTL_SECONDS = Number(process.env.ANALYSIS_CACHE_TTL_SECONDS || 86400);
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 31457280);
const UPLOAD_URL_TTL_SECONDS = Number(process.env.UPLOAD_URL_TTL_SECONDS || 900);

function requireBucket() {
  if (!VIDEO_BUCKET) {
    const error = new Error('VIDEO_BUCKET is not configured.');
    error.statusCode = 503;
    throw error;
  }
  return VIDEO_BUCKET;
}

function assetKey(assetId) {
  return `${VIDEO_PREFIX}/${assertAssetId(assetId)}`;
}

export async function createVideoUpload({ assetId, contentType, sizeBytes }) {
  const bucket = requireBucket();
  const format = videoFormatFromContentType(contentType);
  if (!format) {
    const error = new Error('Unsupported video contentType. Use video/mp4, video/quicktime, video/x-matroska, or video/webm.');
    error.statusCode = 400;
    throw error;
  }

  const declaredSize = Number(sizeBytes);
  if (!Number.isInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_VIDEO_BYTES) {
    const error = new Error(`sizeBytes must be an integer between 1 and ${MAX_VIDEO_BYTES}.`);
    error.statusCode = 400;
    throw error;
  }

  const key = assetKey(assetId);
  const normalizedContentType = String(contentType).split(';')[0].trim().toLowerCase();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: normalizedContentType,
    ContentLength: declaredSize,
    Metadata: {
      purpose: 'forgedirector-video-analysis',
    },
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });

  return {
    assetId,
    uploadUrl,
    method: 'PUT',
    headers: {
      'content-type': normalizedContentType,
      'content-length': String(declaredSize),
    },
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    maxBytes: MAX_VIDEO_BYTES,
    format,
  };
}

export async function resolveVideoAsset(assetId) {
  const bucket = requireBucket();
  const key = assetKey(assetId);

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    const wrapped = new Error('Video asset was not found or is not ready yet.');
    wrapped.statusCode = 404;
    throw wrapped;
  }

  const sizeBytes = Number(head?.ContentLength || 0);
  if (!sizeBytes || sizeBytes > MAX_VIDEO_BYTES) {
    const error = new Error(`Video must be between 1 byte and ${MAX_VIDEO_BYTES} bytes.`);
    error.statusCode = 413;
    throw error;
  }

  const contentType = String(head?.ContentType || '').split(';')[0].trim().toLowerCase();
  const format = videoFormatFromContentType(contentType);
  if (!format) {
    const error = new Error('Uploaded asset has an unsupported video content type.');
    error.statusCode = 400;
    throw error;
  }

  const etag = String(head?.ETag || '').replace(/^"+|"+$/g, '').trim();

  return {
    assetId,
    bucket,
    key,
    uri: `s3://${bucket}/${key}`,
    sizeBytes,
    contentType,
    format,
    contentFingerprint: etag || null,
  };
}

export async function deleteVideoAsset(assetId) {
  const bucket = requireBucket();
  const key = assetKey(assetId);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    console.warn('ForgeDirector could not delete temporary video asset', {
      assetId,
      message: error?.message,
    });
  }
}


function analysisCacheKey(cacheKey) {
  const value = String(cacheKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    const error = new Error('analysis cache key must be a SHA-256 hex digest.');
    error.statusCode = 400;
    throw error;
  }
  return `${ANALYSIS_CACHE_PREFIX}/${value}.json`;
}

export async function readAnalysisCache(cacheKey) {
  const bucket = requireBucket();
  const key = analysisCacheKey(cacheKey);

  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));

    const lastModifiedMs = result?.LastModified instanceof Date
      ? result.LastModified.getTime()
      : 0;
    const ageSeconds = lastModifiedMs
      ? Math.max(0, Math.floor((Date.now() - lastModifiedMs) / 1000))
      : ANALYSIS_CACHE_TTL_SECONDS + 1;

    if (ageSeconds > ANALYSIS_CACHE_TTL_SECONDS) return null;

    const body = await result?.Body?.transformToString?.();
    if (!body) return null;

    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    return {
      value: parsed,
      ageSeconds,
    };
  } catch (error) {
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    const name = String(error?.name || '');
    if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return null;
    console.warn('ForgeDirector analysis cache read failed', {
      message: error?.message,
    });
    return null;
  }
}

export async function writeAnalysisCache(cacheKey, value) {
  const bucket = requireBucket();
  const key = analysisCacheKey(cacheKey);

  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
      CacheControl: 'private, max-age=0, no-store',
      Metadata: {
        purpose: 'forgedirector-analysis-cache',
      },
    }));
    return true;
  } catch (error) {
    console.warn('ForgeDirector analysis cache write failed', {
      message: error?.message,
    });
    return false;
  }
}
