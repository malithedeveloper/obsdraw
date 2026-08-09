import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

let client;

function configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME,
  );
}

function bucketName() {
  const bucket = process.env.R2_BUCKET_NAME?.trim();
  if (!bucket) throw new Error("R2_BUCKET_NAME is required");
  return bucket;
}

function ensureClient() {
  if (client) return client;
  if (!configured()) throw new Error("Cloudflare R2 is not configured");
  const endpoint = process.env.R2_ENDPOINT?.trim() ||
    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  client = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

function isNotFound(error) {
  return error?.$metadata?.httpStatusCode === 404 ||
    error?.name === "NoSuchKey" ||
    error?.name === "NotFound";
}

export function r2Enabled() {
  return configured();
}

export async function headObject(key) {
  if (!configured()) return null;
  try {
    return await ensureClient().send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function putObject(key, body, contentType, cacheControl) {
  if (!configured()) throw new Error("Cloudflare R2 is not configured");
  await ensureClient().send(new PutObjectCommand({
    Bucket: bucketName(),
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

function bodyToWebStream(body) {
  if (!body) return null;
  if (body instanceof Readable) return Readable.toWeb(body);
  if (typeof body.transformToWebStream === "function") return body.transformToWebStream();
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const chunk = body instanceof Uint8Array ? body : new Uint8Array(body);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    return Readable.toWeb(Readable.from(body));
  }
  return null;
}

export async function getObject(key, { range } = {}) {
  if (!configured()) return null;
  const input = { Bucket: bucketName(), Key: key };
  if (range) input.Range = range;
  try {
    const result = await ensureClient().send(new GetObjectCommand(input));
    const stream = bodyToWebStream(result.Body);
    if (!stream) return null;
    return {
      stream,
      contentLength: result.ContentLength,
      contentType: result.ContentType,
      metadata: result.Metadata,
      etag: result.ETag,
      contentRange: result.ContentRange,
      acceptRanges: result.AcceptRanges,
      lastModified: result.LastModified,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function readText(key) {
  if (!configured()) return null;
  try {
    const result = await ensureClient().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
    if (!result.Body) return null;
    if (typeof result.Body.transformToString === "function") {
      return result.Body.transformToString("utf-8");
    }
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf-8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function writeText(key, data, contentType = "application/json") {
  await putObject(
    key,
    typeof data === "string" ? data : Buffer.from(data),
    contentType,
    "no-cache",
  );
}
