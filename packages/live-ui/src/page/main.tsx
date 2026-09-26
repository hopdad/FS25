// Entry point of the phone page the bridge serves. Bundled by scripts/build-page.ts into
// generated/page.ts; React imports resolve to preact/compat there.

import { render } from "preact";
import { LiveDashboard } from "../components/LiveDashboard";
import { useLive } from "../useLive";

const TOKEN_KEY = "farmlink.token";

/** The pairing token from the link (`?t=`), remembered for visits without it. */
function readToken(): string | null {
  const fromLink = new URLSearchParams(location.search).get("t");
  try {
    if (fromLink) {
      localStorage.setItem(TOKEN_KEY, fromLink);
      return fromLink;
    }
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return fromLink;
  }
}

function Connected({ token }: { token: string }) {
  const live = useLive(token);
  return <LiveDashboard {...live} />;
}

function NoToken() {
  return (
    <main>
      <section className="card">
        <h2>Open the link from the bridge</h2>
        <p>
          This page needs the pairing code in its link. Scan the QR code in the FarmLink bridge
          window on your computer, or type the whole address it shows.
        </p>
      </section>
    </main>
  );
}

const token = readToken();
const root = document.getElementById("root");
if (root) render(token ? <Connected token={token} /> : <NoToken />, root);
