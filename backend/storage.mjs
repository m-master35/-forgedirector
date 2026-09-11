import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertAssetId, videoFormatFromContentType } from './video-intelligence.mjs';

const s3 = new S3Client({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

const VIDEO_BUCKET = process.env.VIDEO_BUCKET || '';
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
  return `uploads/${assertAssetId(assetId)}`;
}

export async function createVideoUpload({ assetId, contentType }) {
  const bucket = requireBucket();
  const format = videoFormatFromContentType(contentType);
  if (!format) {
    const error = new Error('Unsupported video contentType. Use video/mp4, video/quicktime, video/x-matroska, or video/webm.');
    error.statusCode = 400;
    throw error;
  }

  const key = assetKey(assetId);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: String(contentType).split(';')[0].trim().toLowerCase(),
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });

  return {
    assetId,
    uploadUrl,
    method: 'PUT',
    headers: {
      'content-type': String(contentType).split(';')[0].trim().toLowerCase(),
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
  } catch (error) {
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

  return {
    assetId,
    bucket,
    key,
    uri: `s3://${bucket}/${key}`,
    sizeBytes,
    contentType,
    format,
  };
}
