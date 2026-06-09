const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// R2 is S3-compatible — we use the AWS SDK pointed at Cloudflare's endpoint
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

/**
 * Upload a PDF buffer to R2.
 * Returns { key, url, filename }
 */
async function uploadPDF(buffer, originalName) {
  const ext = path.extname(originalName) || '.pdf';
  const key = `pdfs/${uuidv4()}${ext}`;

  await r2.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: 'application/pdf',
    // Make object publicly readable (requires bucket public access enabled)
    // If you use private bucket, remove this and use signed URLs instead
  }));

  const url = `${PUBLIC_URL}/${key}`;
  return { key, url, filename: originalName };
}

/**
 * Generate a presigned URL so the browser can upload directly to R2.
 * This bypasses Railway's proxy size limits entirely.
 * Returns { uploadUrl, key, publicUrl }
 */
async function getPresignedUploadUrl(filename, expiresInSeconds = 300) {
  const ext  = require('path').extname(filename) || '.pdf';
  const key  = `pdfs/${require('uuid').v4()}${ext}`;
  const cmd  = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    ContentType: 'application/pdf',
  });
  const uploadUrl  = await getSignedUrl(r2, cmd, { expiresIn: expiresInSeconds });
  const publicUrl  = `${PUBLIC_URL}/${key}`;
  return { uploadUrl, key, publicUrl };
}

/**
 * Delete a PDF from R2 by its key.
 */
async function deletePDF(key) {
  if (!key) return;
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Generate a temporary signed URL for private bucket access (optional).
 * Not used when bucket is public, but available as fallback.
 */
async function getSignedPDFUrl(key, expiresInSeconds = 3600) {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(r2, cmd, { expiresIn: expiresInSeconds });
}

module.exports = { uploadPDF, deletePDF, getSignedPDFUrl, getPresignedUploadUrl };
