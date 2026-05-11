import type { Database } from "../db/pool.js";
import type { NotificationPushPayload } from "../domain.js";
import { listFcmTokensForProvider } from "../repository.js";

import { sendMulticastNotification } from "./fcm.js";

export async function dispatchQuotePush(db: Database, target: NotificationPushPayload): Promise<void> {
  const tokens = await listFcmTokensForProvider(db, target.providerId);

  if (tokens.length === 0) {
    return;
  }

  await sendMulticastNotification(tokens, target);
}
