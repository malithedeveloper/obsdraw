import type { HeadObjectCommandOutput } from "@aws-sdk/client-s3";

export type R2ObjectStream = {
  stream: ReadableStream<Uint8Array>;
  contentLength?: number;
  contentType?: string;
  metadata?: Record<string, string>;
  etag?: string;
  contentRange?: string;
  acceptRanges?: string;
  lastModified?: Date;
};

export function r2Enabled(): boolean;
export function headObject(key: string): Promise<HeadObjectCommandOutput | null>;
export function putObject(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void>;
export function getObject(key: string, options?: { range?: string }): Promise<R2ObjectStream | null>;
export function readText(key: string): Promise<string | null>;
export function writeText(key: string, data: string | Buffer, contentType?: string): Promise<void>;
