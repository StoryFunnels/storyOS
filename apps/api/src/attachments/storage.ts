import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../config/env';

/**
 * The storage seam (MN-029): local disk by default, any S3-compatible store
 * (MinIO, S3, R2) via env. Objects are content-addressed under
 * <record_id>/<attachment_id>/<kind>.
 */
export interface StorageDriver {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

class LocalDiskStorage implements StorageDriver {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const path = normalize(join(this.root, key));
    if (!path.startsWith(normalize(this.root))) throw new Error('invalid storage key');
    return path;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

class S3Storage implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const e = env();
    this.bucket = e.S3_BUCKET;
    this.client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials:
        e.S3_ACCESS_KEY && e.S3_SECRET_KEY
          ? { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY }
          : undefined,
    });
  }

  async put(key: string, data: Buffer, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mime }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return result.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let driver: StorageDriver | undefined;

export function getStorage(): StorageDriver {
  if (!driver) {
    driver = env().STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalDiskStorage(env().ATTACHMENTS_DIR);
  }
  return driver;
}
