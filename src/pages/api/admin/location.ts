import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdmin } from "@/server/admin";
import { DbError, deleteShare, getActiveShare, getPoints, listShares } from "@/server/db";
import { sameOrigin } from "@/server/session";

/**
 * Admin only.
 * GET ?share=<id> → { active, shares, selected, points }  (points of the chosen share; default: the live one, else the latest)
 * DELETE ?share=<id> → removes that share and its points
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (!sameOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  if (!requireAdmin(req, res)) return;

  const id = typeof req.query.share === "string" ? req.query.share.slice(0, 64) : "";
  try {
    if (req.method === "DELETE") {
      if (!id) return res.status(400).json({ error: "Which share?" });
      await deleteShare(id);
      return res.json({ ok: true });
    }
    if (req.method !== "GET") return res.status(405).json({ error: "GET or DELETE" });

    const [active, rows] = await Promise.all([getActiveShare(), listShares()]);
    const shares = rows.map(({ location_points, ...s }) => ({ ...s, points: location_points?.[0]?.count ?? 0 }));
    const selected = id || active?.id || shares[0]?.id || null;
    const points = selected ? await getPoints(selected) : [];
    res.json({ active, shares, selected, points });
  } catch (e) {
    res.status(e instanceof DbError ? e.status : 500).json({ error: (e as Error).message });
  }
}
