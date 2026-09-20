// ===== S3 兼容对象存储驱动（MinIO / 云 OSS / S3）=====
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl: presign } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.S3_BUCKET || 'ecom-uploads';
let client = null;

function getClient() {
  if (!client) {
    const { secret } = require('../../secrets');
    client = new S3Client({
      region: process.env.S3_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: secret('S3_ACCESS_KEY'),
        secretAccessKey: secret('S3_SECRET_KEY')
      }
    });
  }
  return client;
}

async function put(key, buffer, contentType) {
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer,
    ContentType: contentType || 'application/octet-stream'
  }));
  return { key };
}

async function del(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function getSignedUrl(key, ttl = 3600) {
  return presign(getClient(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: ttl });
}

// 启动时确保桶存在（不存在则创建）
async function ensureBucket() {
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (e) {
    try { await getClient().send(new CreateBucketCommand({ Bucket: BUCKET })); }
    catch (e2) { console.warn('[storage:s3] 建桶失败（可能已存在或无权限）:', e2.message); }
  }
}

function localPath() { throw new Error('s3 驱动无本地路径'); }
function isLocal() { return false; }

// 就绪探针：桶可访问
async function ping() {
  await getClient().send(new HeadBucketCommand({ Bucket: BUCKET }));
  return { ok: true, driver: 's3', bucket: BUCKET, endpoint: process.env.S3_ENDPOINT || null };
}

module.exports = { put, del, getSignedUrl, localPath, isLocal, ensureBucket, ping, BUCKET };
