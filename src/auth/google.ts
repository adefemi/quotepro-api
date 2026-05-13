import { OAuth2Client, type LoginTicket, type TokenPayload } from "google-auth-library";

import { googleOAuthClientIds } from "../config/env.js";

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  pictureUrl?: string;
}

export class GoogleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthConfigError";
  }
}

export class GoogleAuthVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthVerificationError";
  }
}

export interface GoogleVerifierOptions {
  clientIds?: string[];
  client?: Pick<OAuth2Client, "verifyIdToken">;
}

export async function verifyGoogleIdToken(
  idToken: string,
  options: GoogleVerifierOptions = {},
): Promise<GoogleProfile> {
  const clientIds = options.clientIds ?? googleOAuthClientIds;

  if (clientIds.length === 0) {
    throw new GoogleAuthConfigError("GOOGLE_OAUTH_CLIENT_IDS is not configured.");
  }

  if (!idToken || typeof idToken !== "string") {
    throw new GoogleAuthVerificationError("Missing Google ID token.");
  }

  const client = options.client ?? new OAuth2Client();

  let ticket: LoginTicket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: clientIds,
    });
  } catch (error) {
    throw new GoogleAuthVerificationError(
      error instanceof Error ? error.message : "Failed to verify Google ID token.",
    );
  }

  const payload = ticket.getPayload();
  if (!payload) {
    throw new GoogleAuthVerificationError("Google ID token has no payload.");
  }

  return mapPayloadToProfile(payload);
}

function mapPayloadToProfile(payload: TokenPayload): GoogleProfile {
  if (!payload.sub) {
    throw new GoogleAuthVerificationError("Google ID token is missing the subject claim.");
  }

  if (!payload.email) {
    throw new GoogleAuthVerificationError("Google ID token is missing the email claim.");
  }

  if (payload.email_verified !== true) {
    throw new GoogleAuthVerificationError("Google account email is not verified.");
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified,
    name: (payload.name ?? payload.given_name ?? "").trim(),
    pictureUrl: payload.picture ?? undefined,
  };
}
