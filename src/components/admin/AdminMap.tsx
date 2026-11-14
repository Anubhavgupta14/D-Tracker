import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { useEffect, useRef, useState } from "react";

export interface MapPoint {
  lat: number;
  lng: number;
  accuracy: number | null;
}

type LeafletModule = typeof Leaflet;

/**
 * Her trail on an OpenStreetMap map: the path, where it started, and where she is
 * (with an accuracy circle). Refits when a different share is shown; while live it
 * follows the newest point.
 */
export default function AdminMap({ points, shareId, follow }: { points: MapPoint[]; shareId: string | null; follow: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const fittedFor = useRef<string | null>(null);
  const [L, setL] = useState<LeafletModule | null>(null);

  useEffect(() => {
    let alive = true;
    void import("leaflet").then((mod) => {
      const lib = (mod as unknown as { default?: LeafletModule }).default ?? (mod as unknown as LeafletModule);
      if (alive) setL(lib);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!L || !el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([19.0, 73.0], 9);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      layer.current = null;
      fittedFor.current = null;
    };
  }, [L]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!L || !m || !g) return;
    g.clearLayers();
    if (!points.length) return;

    const path = points.map((p) => L.latLng(p.lat, p.lng));
    L.polyline(path, { color: "#e5487a", weight: 4, opacity: 0.75 }).addTo(g);
    L.circleMarker(path[0], { radius: 6, color: "#fff", weight: 2, fillColor: "#806878", fillOpacity: 1 })
      .bindTooltip("Start")
      .addTo(g);
    const last = points[points.length - 1];
    if (last.accuracy && last.accuracy < 2000) {
      L.circle(path[path.length - 1], { radius: last.accuracy, color: "#e5487a", weight: 1, fillOpacity: 0.12 }).addTo(g);
    }
    L.circleMarker(path[path.length - 1], { radius: 9, color: "#fff", weight: 3, fillColor: "#e5487a", fillOpacity: 1 })
      .bindTooltip("Latest")
      .addTo(g);

    if (fittedFor.current !== shareId) {
      fittedFor.current = shareId;
      if (path.length === 1) m.setView(path[0], 16);
      else m.fitBounds(L.latLngBounds(path), { padding: [32, 32], maxZoom: 17 });
    } else if (follow) {
      m.panTo(path[path.length - 1]);
    }
  }, [L, points, shareId, follow]);

  return <div ref={el} className="h-[420px] w-full overflow-hidden rounded-3xl bg-line" aria-label="Map of her location" />;
}
