import type { NextApiRequest, NextApiResponse } from "next";
import { PEOPLE } from "@/lib/config";
import {
  adminConfigured,
  adminPasscodeMatches,
  clientIp,
  endAdminSession,
  isAdmin,
  startAdminSession,
} from "@/server/admin";
import { DbError, recentAdminFailures, recordAdminFailure } from "@/server/db";
import { mailConfig, sendMail } from "@/server/jarvis/mail";
import { sameOrigin, tooManyAttempts } from "@/server/session";

/**
 * GET    → { admin: boolean }
 * POST   { passcode } → admin cookie if it matches ADMIN_PASSCODE
 * DELETE → sign out
 */

// A short passcode is only safe if guessing is slow everywhere, so failures are
// counted in the database (all server instances), not just in memory.
const WINDOW_MIN = 60;
const MAX_FAILURES = 10;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (!adminConfigured()) return res.status(500).json({ error: "ADMIN_PASSCODE isn't set on the server (.env)." });
  if (req.method === "GET") return res.json({ admin: isAdmin(req) });
  if (!sameOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  if (req.method === "DELETE") {
    endAdminSession(req, res);
    return res.json({ admin: false });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "GET, POST or DELETE" });

  if (tooManyAttempts(req)) return res.status(429).json({ error: "Too many tries. Wait a few minutes." });
  try {
    if ((await recentAdminFailures(WINDOW_MIN)) >= MAX_FAILURES) {
      return res.status(429).json({ error: "Admin login is paused after too many wrong passcodes. Try again in an hour." });
    }

    const passcode = String(req.body?.passcode ?? "").trim().slice(0, 100);
    if (!adminPasscodeMatches(passcode)) {
      await recordAdminFailure(clientIp(req));
      const failures = await recentAdminFailures(WINDOW_MIN);
      // Tell Anubhav if someone seems to be guessing.
      if (failures === 5 && mailConfig().ready) {
        void sendMail({
          subject: "⚠️ Wrong admin passcodes on D-Tracker",
          text: `5 wrong admin passcodes in the last hour (latest from ${clientIp(req)}). After ${MAX_FAILURES}, admin login pauses for an hour.`,
          html: `<p>5 wrong admin passcodes in the last hour (latest from ${clientIp(req)}).</p><p>After ${MAX_FAILURES}, admin login pauses for an hour. If this wasn't you, ${PEOPLE.him}, change ADMIN_PASSCODE.</p>`,
        }).catch(() => {});
      }
      return res.status(401).json({ error: "Wrong admin passcode." });
    }

    startAdminSession(req, res);
    res.json({ admin: true });
  } catch (e) {
    res.status(e instanceof DbError ? e.status : 500).json({ error: (e as Error).message });
  }
}
