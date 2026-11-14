import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { PEOPLE } from "@/lib/config";

/* Leaflet touches `window`, so the map only loads in the browser. */
const AdminMap = dynamic(() => import("./AdminMap"), {
  ssr: false,
  loading: () => <div className="h-[420px] w-full animate-pulse rounded-3xl bg-line" />,
});

interface Share {
  id: string;
  reason: "share" | "sos";
  started_at: string;
  ends_at: string;
  stopped_at: string | null;
  last_point_at: string | null;
  points?: number;
}

interface Point {
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  battery: number | null;
  recorded_at: string;
}

interface Data {
  active: Share | null;
  shares: Share[];
  selected: string | null;
  points: Point[];
}

type Phase = "checking" | "login" | "ready";

const POLL_MS = 15_000;

export default function AdminApp() {
  const [phase, setPhase] = useState<Phase>("checking");

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/auth")
      .then((r) => r.json())
      .then((j: { admin?: boolean }) => alive && setPhase(j.admin ? "ready" : "login"))
      .catch(() => alive && setPhase("login"));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="app-backdrop" />
      <main className="relative z-10 mx-auto min-h-dvh max-w-[980px] px-5 py-8">
        {phase === "checking" && (
          <div className="grid min-h-[70dvh] place-items-center">
            <span className="float text-5xl">🛰️</span>
          </div>
        )}
        {phase === "login" && <AdminLogin onIn={() => setPhase("ready")} />}
        {phase === "ready" && <Dashboard onLocked={() => setPhase("login")} />}
      </main>
    </>
  );
}

/* ---------------- Login ---------------- */

function AdminLogin({ onIn }: { onIn: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode: code.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as { admin?: boolean; error?: string };
      if (res.ok && j.admin) return onIn();
      setError(j.error ?? "That didn't work.");
      setCode("");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-[80dvh] place-items-center">
      <form onSubmit={submit} className="card w-full max-w-[400px] p-7 text-center">
        <p className="text-5xl">🛰️</p>
        <h1 className="mt-3 font-display text-2xl font-semibold">Admin</h1>
        <p className="mt-1 text-sm text-ink-soft">Enter the admin passcode.</p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="date-input mt-5 text-center tracking-[0.5em]"
          aria-label="Admin passcode"
          placeholder="••••"
        />
        {error && <p className="mt-2 text-sm font-semibold text-berry">{error}</p>}
        <button type="submit" disabled={busy} className="btn btn-primary mt-5 w-full disabled:opacity-60">
          {busy ? "Checking…" : "Open admin"}
        </button>
      </form>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */

function Dashboard({ onLocked }: { onLocked: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [want, setWant] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [follow, setFollow] = useState(true);
  // "Now" for the "2 min ago" labels; ticks with the poll so render stays pure.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    async (share: string | null) => {
      try {
        const res = await fetch(`/api/admin/location${share ? `?share=${encodeURIComponent(share)}` : ""}`);
        if (res.status === 401) return onLocked();
        const j = (await res.json()) as Data & { error?: string };
        if (!res.ok) throw new Error(j.error ?? `Error ${res.status}`);
        setData(j);
        setError("");
        setNow(Date.now());
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [onLocked],
  );

  // Load now, then keep it fresh (also re-renders the "2 min ago" labels).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicking off the initial async load
    void load(want);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(want);
      setNow(Date.now());
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load, want]);

  const signOut = async () => {
    await fetch("/api/admin/auth", { method: "DELETE" }).catch(() => {});
    onLocked();
  };

  const remove = async (s: Share) => {
    if (!confirm(`Delete the location history from ${fmtDateTime(s.started_at)}? This can't be undone.`)) return;
    await fetch(`/api/admin/location?share=${encodeURIComponent(s.id)}`, { method: "DELETE" });
    if (want === s.id) setWant(null);
    void load(want === s.id ? null : want);
  };

  const active = data?.active ?? null;
  const selected = data?.shares.find((s) => s.id === data.selected) ?? null;
  const points = data?.points ?? [];
  const last = points[points.length - 1];
  const viewingLive = Boolean(active && selected && active.id === selected.id);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="font-display text-3xl font-semibold">{PEOPLE.her}&apos;s location</h1>
        </div>
        <button className="btn btn-ghost" onClick={signOut}>
          Sign out
        </button>
      </header>

      {error && <p className="card p-4 text-sm font-semibold text-berry">{error}</p>}

      <StatusCard active={active} last={viewingLive ? last : undefined} now={now} />

      {selected ? (
        <section className="card space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-display text-lg font-semibold">
                {selected.reason === "sos" ? "🚨 Help mode" : "📍 Shared location"} · {fmtDateTime(selected.started_at)}
              </p>
              <p className="text-sm text-ink-soft">
                {points.length} point{points.length === 1 ? "" : "s"}
                {last ? ` · latest ${fmtTime(last.recorded_at)}` : ""}
                {points.length >= 5000 ? " (showing the first 5,000)" : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {viewingLive && (
                <label className="chip cursor-pointer select-none" aria-pressed={follow}>
                  <input type="checkbox" className="sr-only" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                  Follow her
                </label>
              )}
              {last && (
                <a className="btn btn-primary" href={mapsLink(last)} target="_blank" rel="noreferrer">
                  Open in Google Maps
                </a>
              )}
            </div>
          </div>
          {points.length ? (
            <AdminMap points={points} shareId={selected.id} follow={viewingLive && follow} />
          ) : (
            <p className="rounded-3xl bg-bg p-8 text-center text-ink-soft">No points yet. Her phone sends one about every 30 seconds.</p>
          )}
        </section>
      ) : (
        data && <p className="card p-8 text-center text-ink-soft">{PEOPLE.her} hasn&apos;t shared her location yet.</p>
      )}

      {data && data.shares.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">History</h2>
          <ul className="card divide-y divide-line p-2">
            {data.shares.map((s) => {
              const on = s.id === data.selected;
              const live = active?.id === s.id;
              return (
                <li key={s.id} className={`flex flex-wrap items-center gap-3 rounded-2xl p-3 ${on ? "bg-accent-soft" : ""}`}>
                  <span className="text-2xl">{s.reason === "sos" ? "🚨" : "📍"}</span>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setWant(s.id)}>
                    <p className="font-semibold">
                      {fmtDateTime(s.started_at)} → {fmtTime(s.stopped_at ?? s.ends_at)}
                      {live && <span className="ml-2 rounded-full bg-mint-soft px-2 py-0.5 text-xs font-bold text-mint">LIVE</span>}
                    </p>
                    <p className="text-sm text-ink-soft">
                      {s.reason === "sos" ? "Help mode" : "She shared"} · {s.points ?? 0} points
                      {s.stopped_at && !live ? " · stopped by her" : ""}
                    </p>
                  </button>
                  <button className="btn btn-ghost text-sm" onClick={() => remove(s)} aria-label="Delete this history">
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function StatusCard({ active, last, now }: { active: Share | null; last?: Point; now: number }) {
  if (!active) {
    return (
      <div className="card flex items-center gap-4 p-5">
        <span className="h-3 w-3 rounded-full bg-ink-soft/40" />
        <div>
          <p className="font-display text-lg font-semibold">Not sharing right now</p>
          <p className="text-sm text-ink-soft">When she shares her location (or starts Help mode), it shows up here live.</p>
        </div>
      </div>
    );
  }
  const sos = active.reason === "sos";
  const stale = last ? now - Date.parse(last.recorded_at) > 3 * 60_000 : true;
  return (
    <div className={`card flex flex-wrap items-center gap-4 p-5 ${sos ? "ring-2 ring-berry" : ""}`}>
      <span className="relative flex h-3 w-3">
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${sos ? "bg-berry" : "bg-mint"}`} />
        <span className={`relative inline-flex h-3 w-3 rounded-full ${sos ? "bg-berry" : "bg-mint"}`} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-display text-lg font-semibold">
          {sos ? `🚨 ${PEOPLE.her} is in Help mode` : `Sharing live until ${fmtTime(active.ends_at)}`}
        </p>
        <p className="text-sm text-ink-soft">
          {last
            ? `Last update ${ago(last.recorded_at, now)}${last.accuracy ? ` · ±${Math.round(last.accuracy)} m` : ""}${
                last.battery !== null ? ` · 🔋 ${Math.round(last.battery * 100)}%` : ""
              }${last.speed && last.speed > 1 ? ` · moving ${Math.round(last.speed * 3.6)} km/h` : ""}`
            : "Waiting for the first point from her phone…"}
        </p>
        {last && stale && (
          <p className="mt-1 text-sm font-semibold text-berry">
            No update for a few minutes: her phone may be offline or out of signal.
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------- Helpers ---------------- */

const mapsLink = (p: Point) => `https://www.google.com/maps?q=${p.lat},${p.lng}`;

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : fmtDateTime(iso);
}
