import type { NextApiRequest, NextApiResponse } from "next";
import { PEOPLE } from "@/lib/config";
import { mailConfig, mailError, sendMail } from "@/server/jarvis/mail";
import { reverseGeocode } from "@/server/jarvis/tools";
import { requireSession, sameOrigin } from "@/server/session";

export const config = { api: { bodyParser: { sizeLimit: "16kb" } } };

/**
 * Help mode (Android app): when she says she doesn't feel safe, her phone sends
 * "start" straight away, "update" when she moves, and "safe" when she turns it off.
 * Each one emails Anubhav with her location and a Maps link.
 */

// Behind the passcode, but cap it anyway. Generous: this must not drop a real emergency.
const sent: number[] = [];
const MAX_PER_HOUR = 60;

type Event = "start" | "update" | "safe";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const ist = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!sameOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  if (!requireSession(req, res)) return;

  if (!mailConfig().ready) {
    return res.status(503).json({ error: "Email isn't set up yet (GMAIL_USER / GMAIL_APP_PASSWORD)." });
  }

  const now = Date.now();
  while (sent.length && now - sent[0] > 3_600_000) sent.shift();
  if (sent.length >= MAX_PER_HOUR) return res.status(429).json({ error: "Too many alerts in the last hour." });

  const body = req.body ?? {};
  const event: Event = body.event === "update" || body.event === "safe" ? body.event : "start";
  const source =
    body.source === "jarvis" ? "Jarvis" : body.source === "shortcut" ? "the power-button shortcut (phone may be in her pocket)" : "the Help button";
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "";
  const locError = typeof body.locationError === "string" ? body.locationError.slice(0, 140) : "";
  const battery =
    typeof body.battery === "number" && body.battery >= 0 && body.battery <= 1 ? Math.round(body.battery * 100) : undefined;
  const startedAt = typeof body.startedAt === "string" && !Number.isNaN(Date.parse(body.startedAt)) ? new Date(body.startedAt) : null;

  let address: string | undefined;
  let mapsUrl: string | undefined;
  let accuracy: number | undefined;
  const loc = body.location;
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lng) <= 180) {
    mapsUrl = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
    accuracy = Number.isFinite(loc.accuracy) ? Math.round(loc.accuracy) : undefined;
    address = await reverseGeocode(loc.lat, loc.lng);
  }

  const { her, him } = PEOPLE;
  const head = {
    start: { color: "#d7263d", title: `🚨 ${her} doesn't feel safe`, sub: `She started Help mode from ${source}. Call her now.` },
    update: { color: "#d7263d", title: `📍 ${her} has moved`, sub: "Help mode is still on. This is her latest location." },
    safe: { color: "#2f9e6e", title: `✅ ${her} says she's safe`, sub: "She turned Help mode off." },
  }[event];

  const locationHtml = mapsUrl
    ? `${address ? `<p style="margin:0 0 6px;font-size:16px">${esc(address)}</p>` : ""}
       ${accuracy !== undefined ? `<p style="margin:0 0 14px;font-size:13px;color:#806878">Accurate to about ${accuracy} m</p>` : ""}
       <a href="${mapsUrl}" style="display:inline-block;background:${head.color};color:#fff;padding:13px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px">Open her location in Maps</a>`
    : `<p style="margin:0;font-size:15px">Her phone couldn't share a location${locError ? ` (${esc(locError)})` : ""}. Call her and ask where she is.</p>`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto;background:#fff5ef;border-radius:24px;padding:28px;color:#2e1a2b">
    <p style="margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${head.color};font-weight:700">Help mode · ${esc(her)}</p>
    <h1 style="margin:8px 0 4px;font-size:26px">${head.title}</h1>
    <p style="margin:0 0 16px;color:#806878">${esc(head.sub)}</p>
    ${reason ? `<p style="margin:0 0 16px;font-size:16px"><b>What she said:</b> “${esc(reason)}”</p>` : ""}
    <div style="background:#fff;border-radius:18px;padding:18px">
      <h3 style="margin:0 0 8px;font-size:15px">📍 Where she is</h3>
      ${locationHtml}
    </div>
    ${
      event !== "safe"
        ? `<p style="margin:18px 0 0;font-size:15px">If you can't reach her and think she's in danger, call <b>112</b> and give them this location.</p>`
        : ""
    }
    <p style="margin:22px 0 0;font-size:13px;color:#806878">
      ${esc(ist(new Date()))} IST${startedAt && event !== "start" ? ` · Help mode started ${esc(ist(startedAt))}` : ""}${battery !== undefined ? ` · Battery ${battery}%` : ""}
    </p>
  </div>`;

  const text = [
    head.title.replace(/^\S+\s/, ""),
    head.sub,
    reason ? `What she said: ${reason}` : "",
    address ? `Where: ${address}` : "",
    mapsUrl ? `Map: ${mapsUrl}` : `No location${locError ? ` (${locError})` : ""}. Call her.`,
    event !== "safe" ? "Can't reach her? Call 112 with this location." : "",
    battery !== undefined ? `Battery: ${battery}%` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const subject = {
    start: `🚨 HELP: ${her} doesn't feel safe${address ? ` (near ${address.split(",").slice(0, 2).join(",")})` : ""}`,
    update: `📍 ${her}'s location update (Help mode on)`,
    safe: `✅ ${her} is safe now`,
  }[event];

  try {
    await sendMail({ subject, html, text });
    sent.push(now);
    res.json({ ok: true, address, mapsUrl, to: him });
  } catch (e) {
    res.status(502).json({ error: mailError(e) });
  }
}
