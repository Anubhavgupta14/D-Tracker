import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Admin mode (Anubhav): a separate passcode (ADMIN_PASSCODE) and a separate,
 * differently-signed cookie. Her session can never open admin pages, and the
 * admin cookie can't be used as her session. Changing ADMIN_PASSCODE signs the
 * admin out everywhere.
 */

const COOKIE = "dt_admin";
const MAX_AGE_S = 30 * 24 * 60 * 60;

function secret(): string {
  const pass = process.env.ADMIN_PASSCODE;
  if (!pass) throw new Error("ADMIN_PASSCODE missing in .env");
  // The passcode alone is short, so the signature must also depend on a real secret.
  const base = process.env.SESSION_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!base) throw new Error("SESSION_SECRET or SUPABASE_SECRET_KEY must be set");
  return `${base}|admin|${pass}`;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const adminConfigured = () => Boolean(process.env.ADMIN_PASSCODE);

export function adminPasscodeMatches(input: string): boolean {
  const pass = process.env.ADMIN_PASSCODE ?? "";
  return Boolean(pass) && safeEqual(sign(`pc:${input}`), sign(`pc:${pass}`));
}

export function isAdmin(req: NextApiRequest): boolean {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return false;
    const [v, iat, sig] = token.split(".");
    if (v !== "a1" || !iat || !sig) return false;
    if (!safeEqual(sig, sign(`a1.${iat}`))) return false;
    return Date.now() / 1000 - Number(iat) < MAX_AGE_S;
  } catch {
    return false;
  }
}

const secure = (req: NextApiRequest) =>
  req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";

export function startAdminSession(req: NextApiRequest, res: NextApiResponse) {
  const iat = Math.floor(Date.now() / 1000).toString();
  const token = `a1.${iat}.${sign(`a1.${iat}`)}`;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Strict${secure(req) ? "; Secure" : ""}`,
  );
}

export function endAdminSession(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure(req) ? "; Secure" : ""}`);
}

/** For admin API routes: true if allowed, otherwise sends 401. */
export function requireAdmin(req: NextApiRequest, res: NextApiResponse): boolean {
  if (isAdmin(req)) return true;
  res.status(401).json({ error: "admin-locked" });
  return false;
}

export const clientIp = (req: NextApiRequest) =>
  String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
