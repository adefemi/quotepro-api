import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "../config/env.js";

/** Directory containing `package.json` for the api package (…/api when built from src). */
function apiRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Resolves Firebase Admin credentials: inline env first, then JSON file on disk.
 */
export function resolveFirebaseServiceAccountJson(): string | undefined {
  const inline = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) {
    return inline;
  }

  const relativeOrName = env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() ?? "firebase.json";
  const absolutePath = isAbsolute(relativeOrName)
    ? relativeOrName
    : join(apiRootDir(), relativeOrName);

  if (!existsSync(absolutePath)) {
    return undefined;
  }

  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}
