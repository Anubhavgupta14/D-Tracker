import { randomUUID } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { PEOPLE } from "@/lib/config";
import { createShare, DbError, getActiveShare, getShare, insertPoints, updateShare, type PointRow } from "@/server/db";
import { mailConfig, sendMail } from "@/server/jarvis/mail";
import { requireSession, sameOrigin } from "@/server/session";

export const config = { api: { bodyParser: { sizeLimit: "128kb" } } };

/**
 * Live location from her phone. She starts a share for a set time (or Help mode
 * does), the phone sends points in batches, and it stops when time's up or she
 * stops it. Anubhav reads it on /admin.
 *
 * GET  → { share }  (the one running now, if any)
 * POST { action: "start", minutes, reason } → { share }
 * POST { action: "points", shareId, points: [...] }
 * POST { action: "stop", shareId }
 */

const MAX_MINUTES = 12 * 60;
/** Points may arrive a little after the end (batched / bad signal). */
const GRACE_MS = 5 * 60_000;

const num = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

function cleanPoints(raw: unknown, shareId: string): (PointRow & { share_id: string })[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const out: (PointRow & { share_id: string })[] = [];
  for (const p of raw.slice(0, 300)) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const lat = num(r.lat, -90, 90);
    const lng = num(r.lng, -180, 180);
    const at = typeof r.at === "number" ? r.at : NaN;
    if (lat === null || lng === null || !Number.isFinite(at) || at > now + 5 * 60_000) continue;
    out.push({
      share_id: shareId,
      lat,
      lng,
      accuracy: num(r.accuracy, 0, 100_000),
      speed: num(r.speed, 0, 500),
      battery: num(r.battery, 0, 1),
      recorded_at: new Date(at).toISOString(),
    });
  }
  return out;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (!sameOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  if (!requireSession(req, res)) return;

  try {
    if (req.method === "GET") return res.json({ share: await getActiveShare() });
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });

    const body = req.body ?? {};
    const action = body.action;

    if (action === "start") {
      const reason = body.reason === "sos" ? "sos" : "share";
      const minutes = reason === "sos" ? MAX_MINUTES : Math.round(num(body.minutes, 5, MAX_MINUTES) ?? 60);
      // One share at a time: a new one replaces whatever was running.
      const running = await getActiveShare();
      if (running) await updateShare(running.id, { stopped_at: new Date().toISOString() });

      const id = randomUUID();
      const endsAt = new Date(Date.now() + minutes * 60_000);
      await createShare({ id, reason, ends_at: endsAt.toISOString() });

      // Help mode already emails him; a normal share gets a heads-up with the link.
      if (reason === "share" && mailConfig().ready) {
        const proto = String(req.headers["x-forwarded-proto"] ?? "https").split(",")[0];
        const link = `${proto}://${req.headers.host}/admin`;
        const until = endsAt.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
        void sendMail({
          subject: `📍 ${PEOPLE.her} is sharing her live location until ${until}`,
          text: `${PEOPLE.her} is sharing her live location with you until ${until} IST.\nSee it here: ${link}`,
          html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto;background:#fff5ef;border-radius:24px;padding:28px;color:#2e1a2b">
            <h1 style="margin:0 0 6px;font-size:24px">📍 ${PEOPLE.her} is sharing her live location</h1>
            <p style="margin:0 0 18px;color:#806878">Until ${until} IST.</p>
            <a href="${link}" style="display:inline-block;background:#e5487a;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Open admin</a>
          </div>`,
        }).catch(() => {});
      }
      return res.json({ share: await getShare(id) });
    }

    const shareId = typeof body.shareId === "string" ? body.shareId.slice(0, 64) : "";
    const share = shareId ? await getShare(shareId) : null;
    if (!share) return res.status(404).json({ error: "No such share" });

    if (action === "stop") {
      if (!share.stopped_at) await updateShare(share.id, { stopped_at: new Date().toISOString() });
      return res.json({ ok: true });
    }

    if (action === "points") {
      const over = share.stopped_at || Date.now() > Date.parse(share.ends_at) + GRACE_MS;
      if (over) return res.status(410).json({ error: "This share has ended", ended: true });
      const rows = cleanPoints(body.points, share.id);
      await insertPoints(rows);
      if (rows.length) await updateShare(share.id, { last_point_at: rows[rows.length - 1].recorded_at });
      return res.json({ ok: true, saved: rows.length });
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    res.status(e instanceof DbError ? e.status : 500).json({ error: (e as Error).message });
  }
}
