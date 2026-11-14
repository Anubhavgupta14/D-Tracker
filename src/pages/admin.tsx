import dynamic from "next/dynamic";
import Head from "next/head";

/* Client-only: it signs in, polls, and draws a map. */
const AdminApp = dynamic(() => import("@/components/admin/AdminApp"), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-dvh place-items-center">
      <span className="float text-5xl" aria-label="Loading">
        🛰️
      </span>
    </div>
  ),
});

export default function AdminPage() {
  return (
    <>
      <Head>
        <title>D-Tracker · Admin</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <AdminApp />
    </>
  );
}
