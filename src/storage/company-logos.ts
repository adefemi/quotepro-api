import { randomUUID } from "node:crypto";
import path from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { env } from "../config/env.js";

const allowedMimeTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

const maxLogoBytes = 2 * 1024 * 1024;

export class LogoUploadConfigError extends Error {
  constructor() {
    super("S3 logo upload is not configured.");
  }
}

export class LogoUploadValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type CompanyLogoFile = {
  buffer: Buffer;
  filename?: string;
  mimetype?: string;
};

function getS3Client() {
  if (!env.S3_REGION || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new LogoUploadConfigError();
  }

  return new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: Boolean(env.S3_ENDPOINT),
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

function publicLogoUrl(key: string) {
  if (env.S3_PUBLIC_BASE_URL) {
    return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
  }

  return `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
}

function logoExtension(file: CompanyLogoFile) {
  const mimeExtension = file.mimetype ? allowedMimeTypes.get(file.mimetype) : null;
  if (mimeExtension) {
    return mimeExtension;
  }

  const fileExtension = path.extname(file.filename ?? "").replace(".", "").toLowerCase();
  if ([...allowedMimeTypes.values()].includes(fileExtension)) {
    return fileExtension;
  }

  return null;
}

export async function uploadCompanyLogoToS3(input: {
  providerId: string;
  companyId: string;
  file: CompanyLogoFile;
}) {
  const extension = logoExtension(input.file);
  if (!extension || !input.file.mimetype || !allowedMimeTypes.has(input.file.mimetype)) {
    throw new LogoUploadValidationError("Logo must be a JPEG, PNG, or WebP image.");
  }

  if (input.file.buffer.length === 0) {
    throw new LogoUploadValidationError("Logo file is empty.");
  }

  if (input.file.buffer.length > maxLogoBytes) {
    throw new LogoUploadValidationError("Logo must be 2MB or smaller.");
  }

  const key = `providers/${input.providerId}/companies/${input.companyId}/logo-${randomUUID()}.${extension}`;
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: input.file.buffer,
      ContentType: input.file.mimetype,
    }),
  );

  return publicLogoUrl(key);
}
