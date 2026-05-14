import admin from "firebase-admin";

import type { NotificationPushPayload } from "../domain.js";

import { resolveFirebaseServiceAccountJson } from "./firebase-credentials.js";

export function isFirebaseConfigured(): boolean {
  const raw = resolveFirebaseServiceAccountJson()?.trim();
  return Boolean(raw);
}

function ensureApp(): boolean {
  if (admin.apps.length > 0) {
    return true;
  }

  const raw = resolveFirebaseServiceAccountJson()?.trim();
  if (!raw) {
    return false;
  }

  try {
    const serviceAccount = JSON.parse(raw) as admin.ServiceAccount;
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return true;
  } catch {
    return false;
  }
}

export async function sendMulticastNotification(tokens: string[], target: NotificationPushPayload): Promise<void> {
  if (tokens.length === 0 || !ensureApp()) {
    return;
  }

  const messaging = admin.messaging();
  await messaging.sendEachForMulticast({
    tokens,
    notification: { title: target.title, body: target.body },
    data: {
      quoteId: target.quoteId,
      kind: target.kind,
      notificationId: target.notificationId,
      title: target.title,
      body: target.body,
    },
    android: {
      priority: "high",
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
  });
}
