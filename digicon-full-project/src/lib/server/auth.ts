import { timingSafeEqual } from "node:crypto";

export interface AuthUser { id: string }

/** Replace with your real sign-in (NextAuth, SSO, ...) when integrating. */
export interface AuthAdapter {
  authenticate(req: Request): Promise<AuthUser | null>;
}

/**
 * Dev adapter: `Authorization: Bearer <token>`, tokens from DIGICON_LEADERSHIP_TOKENS="token:userId,...".
 * No tokens configured => nobody is authorized (fails closed).
 */
export class EnvTokenAuth implements AuthAdapter {
  constructor(private readonly raw: string | undefined = process.env.DIGICON_LEADERSHIP_TOKENS) {}

  async authenticate(req: Request): Promise<AuthUser | null> {
    const header = req.headers.get("authorization") ?? "";
    const m = header.match(/^Bearer\s+(\S{16,256})$/);
    if (!m) return null;
    const given = Buffer.from(m[1]!);
    for (const pair of (this.raw ?? "").split(",")) {
      const i = pair.indexOf(":");
      if (i < 1) continue;
      const token = Buffer.from(pair.slice(0, i).trim());
      const userId = pair.slice(i + 1).trim();
      if (userId && token.length === given.length && timingSafeEqual(token, given)) return { id: userId };
    }
    return null;
  }
}

let adapter: AuthAdapter | null = null;
export function getAuth(): AuthAdapter { return (adapter ??= new EnvTokenAuth()); }
export function setAuthForTests(a: AuthAdapter | null) { adapter = a; }
