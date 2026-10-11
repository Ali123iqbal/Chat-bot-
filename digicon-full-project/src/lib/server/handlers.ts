import { getInterpreter, validateIntent } from "../ai/adapter";
import { handleIntent, handleMessage, type ChatReply } from "../chat/engine";
import { getSessions } from "../chat/sessions";
import { getSource } from "../data/source";
import { getAuth, type AuthUser } from "./auth";
import { clientKey, getAuthFailLimiter, getLimiter, MAX_BODY_BYTES, MAX_MESSAGE_CHARS } from "./limits";

const json = (status: number, body: unknown, extra?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

/** Minimal operational log: route, status, duration. Never questions, answers or transcripts. */
function log(route: string, status: number, started: number) {
  console.info(JSON.stringify({ route, status, ms: Date.now() - started }));
}

/**
 * Server-side authorization for every route. Repeated failures from one client address
 * are throttled so tokens can't be guessed quickly.
 */
async function authorize(req: Request): Promise<{ user: AuthUser } | { response: Response }> {
  const fails = getAuthFailLimiter();
  const key = clientKey(req);
  if (!fails.peek(key)) return { response: json(429, { error: "too_many_failed_attempts" }, { "retry-after": "60" }) };
  const user = await getAuth().authenticate(req);
  if (!user) {
    fails.allow(key); // record the failure
    return { response: json(401, { error: "unauthorized" }) };
  }
  return { user };
}

/** POST /api/chat  { message: string, conversationId?: string } */
export async function postChat(req: Request): Promise<Response> {
  const t0 = Date.now();
  const done = (res: Response) => { log("POST /api/chat", res.status, t0); return res; };

  const auth = await authorize(req);
  if ("response" in auth) return done(auth.response);
  const user = auth.user;
  if (!getLimiter().allow(user.id)) return done(json(429, { error: "rate_limited" }, { "retry-after": "30" }));

  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return done(json(413, { error: "request_too_large" }));
  let body: { message?: unknown; conversationId?: unknown };
  try { body = JSON.parse(raw); } catch { return done(json(400, { error: "invalid_json" })); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_CHARS) return done(json(400, { error: "invalid_message", maxChars: MAX_MESSAGE_CHARS }));

  const sessions = getSessions();
  let conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  let state = conversationId ? sessions.get(conversationId, user.id) : null;
  if (!state) {
    // Unknown, expired, or someone else's conversation: indistinguishable to the caller.
    if (conversationId) return done(json(404, { error: "conversation_not_found" }));
    conversationId = sessions.start(user.id);
    state = sessions.get(conversationId, user.id)!;
  }

  let reply: ChatReply;
  try {
    const members = await getSource().getMembers();
    reply = handleMessage(state, message, members);
    if (reply.kind === "unknown") {
      // Optional AI fallback (off by default). Gets the question text only, never member data.
      // Its output is validated against the intent allow-list before anything runs.
      const intent = validateIntent(await getInterpreter().interpret(message).catch(() => null));
      if (intent) reply = handleIntent(state, intent, members);
    }
  } catch {
    // Service problem, deliberately different from "no match".
    return done(json(503, { error: "data_unavailable", message: "The member data isn't available right now. Try again shortly or contact the data maintainer." }));
  }
  return done(json(200, { conversationId, reply }));
}

/** DELETE /api/chat?conversationId=...  (clear one conversation) */
export async function deleteChat(req: Request): Promise<Response> {
  const t0 = Date.now();
  const auth = await authorize(req);
  if ("response" in auth) { log("DELETE /api/chat", auth.response.status, t0); return auth.response; }
  const id = new URL(req.url).searchParams.get("conversationId");
  if (id) getSessions().end(id, auth.user.id);
  log("DELETE /api/chat", 204, t0);
  return new Response(null, { status: 204 });
}

/**
 * DELETE /api/session  (logout hook)
 * Ends EVERY conversation of the signed-in user. Call it from your sign-out flow.
 */
export async function deleteSession(req: Request): Promise<Response> {
  const t0 = Date.now();
  const auth = await authorize(req);
  if ("response" in auth) { log("DELETE /api/session", auth.response.status, t0); return auth.response; }
  getSessions().endAllFor(auth.user.id);
  log("DELETE /api/session", 204, t0);
  return new Response(null, { status: 204 });
}

/** GET /api/status  -> last successful refresh time and any refresh failure */
export async function getStatus(req: Request): Promise<Response> {
  const t0 = Date.now();
  const auth = await authorize(req);
  if ("response" in auth) { log("GET /api/status", auth.response.status, t0); return auth.response; }
  try {
    const s = await getSource().getStatus();
    log("GET /api/status", 200, t0);
    return json(200, {
      memberCount: s.memberCount,
      lastSuccessfulRefresh: s.lastSuccessfulRefresh,
      lastRefreshError: s.lastRefreshError ? { at: s.lastRefreshError.at, summary: s.lastRefreshError.errors.slice(0, 3) } : null,
    });
  } catch {
    log("GET /api/status", 503, t0);
    return json(503, { error: "data_unavailable" });
  }
}
