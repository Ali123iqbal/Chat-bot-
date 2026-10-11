"use client";

import { useState } from "react";
import { MemberChat } from "@/components/MemberChat";

/** Demo shell. In the real app, drop <MemberChat /> in and pass your own getAuthHeaders. */
export default function Page() {
  const [token, setToken] = useState("");
  const [signedIn, setSignedIn] = useState(false);

  if (!signedIn) {
    return (
      <main style={{ maxWidth: 420, margin: "10vh auto", padding: 16, font: "15px/1.5 system-ui, sans-serif" }}>
        <h1 style={{ fontSize: "1.25rem" }}>DIGICON member lookup</h1>
        <p>Enter your leadership access token. It stays in this tab only.</p>
        <label htmlFor="token">Access token</label>
        <input
          id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)}
          style={{ display: "block", width: "100%", padding: 8, margin: "4px 0 12px" }}
        />
        <button type="button" disabled={token.length < 16} onClick={() => setSignedIn(true)}>Open chat</button>
      </main>
    );
  }
  return (
    <main style={{ padding: 16, height: "100vh" }}>
      <MemberChat
        getAuthHeaders={() => ({ authorization: `Bearer ${token}` })}
        onUnauthorized={() => { setSignedIn(false); }}
      />
    </main>
  );
}
