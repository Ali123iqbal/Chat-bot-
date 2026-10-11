// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberChat } from "@/components/MemberChat";

const okStatus = { memberCount: 15, lastSuccessfulRefresh: "2026-09-30T10:00:00.000Z", lastRefreshError: null };
const reply = (text: string, extra: object = {}) => ({ conversationId: "c1", reply: { kind: "answer", text, ...extra } });
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(onChat: Handler, status: Handler = () => res(200, okStatus)) {
  const fn = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith("/status") ? Promise.resolve(status(String(url), init)) : Promise.resolve(onChat(String(url), init)),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}
const chatCalls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls.filter(([u]) => String(u).includes("/chat"));

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("MemberChat", () => {
  it("shows the empty state with starter questions and dataset status", async () => {
    mockFetch(() => res(200, reply("x")));
    render(<MemberChat />);
    expect(screen.getByText("Ask about accepted members.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Who can stay until 5 pm?" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("dataset-status")).toHaveTextContent("15 accepted members · refreshed"));
  });

  it("sends a question with auth headers, shows a loading state, then renders rows", async () => {
    let release!: (r: Response) => void;
    const fn = mockFetch(() => new Promise<Response>((r) => { release = r; }) as unknown as Response);
    const user = userEvent.setup();
    render(<MemberChat getAuthHeaders={() => ({ authorization: "Bearer tok" })} />);
    await user.type(screen.getByLabelText("Ask a question about members"), "Find Sara Malik");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Searching member records…");
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    const [, init] = chatCalls(fn)[0]!;
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    await act(async () => release(res(200, reply("Yes. Sara Malik is in HR.", { rows: [{ title: "Sara Malik", subtitle: "20231-10003 · HR", detail: "Commute: shuttle" }] }))));
    expect(await screen.findByText("Yes. Sara Malik is in HR.")).toBeInTheDocument();
    expect(screen.getByText("20231-10003 · HR")).toBeInTheDocument();
    expect(screen.queryByText("Searching member records…")).not.toBeInTheDocument();
  });

  it("keeps the conversation id for follow-ups", async () => {
    const fn = mockFetch(() => res(200, reply("ok")));
    const user = userEvent.setup();
    render(<MemberChat />);
    const box = screen.getByLabelText("Ask a question about members");
    await user.type(box, "first{Enter}");
    await screen.findByText("ok");
    await user.type(box, "What about Tuesday?{Enter}");
    await waitFor(() => expect(chatCalls(fn)).toHaveLength(2));
    expect(JSON.parse(String(chatCalls(fn)[1]![1]!.body))).toMatchObject({ conversationId: "c1", message: "What about Tuesday?" });
  });

  it("renders server errors distinctly and retries", async () => {
    let n = 0;
    mockFetch(() => (n++ === 0 ? res(503, { error: "data_unavailable" }) : res(200, reply("Back again"))));
    const user = userEvent.setup();
    render(<MemberChat />);
    await user.type(screen.getByLabelText("Ask a question about members"), "hello{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("member data isn't available");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Back again")).toBeInTheDocument();
  });

  it("shows a timeout state when the request takes too long", async () => {
    vi.useFakeTimers();
    mockFetch((_u, init) => new Promise<Response>((_res, rej) => {
      init!.signal!.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
    }) as unknown as Response);
    render(<MemberChat timeoutMs={5000} />);
    fireEvent.change(screen.getByLabelText("Ask a question about members"), { target: { value: "slow one" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(screen.getByRole("alert")).toHaveTextContent("took too long");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("calls onUnauthorized on 401", async () => {
    mockFetch(() => res(401, { error: "unauthorized" }));
    const onUnauthorized = vi.fn();
    const user = userEvent.setup();
    render(<MemberChat onUnauthorized={onUnauthorized} />);
    await user.type(screen.getByLabelText("Ask a question about members"), "hi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("not authorized");
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("clear conversation empties the view and ends the server conversation", async () => {
    const fn = mockFetch((_u, init) => (init?.method === "DELETE" ? res(204) : res(200, reply("answer one"))));
    const user = userEvent.setup();
    render(<MemberChat />);
    await user.type(screen.getByLabelText("Ask a question about members"), "hi{Enter}");
    await screen.findByText("answer one");
    await user.click(screen.getByRole("button", { name: "Clear conversation" }));
    expect(screen.queryByText("answer one")).not.toBeInTheDocument();
    expect(screen.getByText("Ask about accepted members.")).toBeInTheDocument();
    const del = fn.mock.calls.find(([, i]) => i?.method === "DELETE")!;
    expect(String(del[0])).toContain("conversationId=c1");
    // next question starts fresh
    await user.type(screen.getByLabelText("Ask a question about members"), "again{Enter}");
    await waitFor(() => expect(chatCalls(fn).filter(([, i]) => i?.method === "POST")).toHaveLength(2));
    expect(JSON.parse(String(chatCalls(fn).filter(([, i]) => i?.method === "POST")[1]![1]!.body)).conversationId).toBeUndefined();
  });

  it("warns when the latest refresh failed, and handles an unavailable status", async () => {
    mockFetch(() => res(200, reply("x")), () => res(200, { ...okStatus, lastRefreshError: { at: "2026-10-01T08:00:00.000Z", summary: ["Line 3: bad"] } }));
    const { unmount } = render(<MemberChat />);
    expect(await screen.findByText(/latest refresh failed/)).toBeInTheDocument();
    unmount();
    mockFetch(() => res(200, reply("x")), () => res(503, {}));
    render(<MemberChat />);
    await waitFor(() => expect(screen.getByTestId("dataset-status")).toHaveTextContent("Dataset status unavailable."));
  });

  it("does not send blank or over-length input", async () => {
    const fn = mockFetch(() => res(200, reply("x")));
    const user = userEvent.setup();
    render(<MemberChat />);
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    await user.type(screen.getByLabelText("Ask a question about members"), "   {Enter}");
    expect(chatCalls(fn)).toHaveLength(0);
    expect(screen.getByLabelText("Ask a question about members")).toHaveAttribute("maxlength", "500");
  });

  it("renders spreadsheet text as plain text, never as HTML", async () => {
    mockFetch(() => res(200, reply("ok", { rows: [{ title: "<img src=x onerror=alert(1)>", subtitle: "20231-1 · HR", detail: "<b>bold</b>" }] })));
    const user = userEvent.setup();
    const { container } = render(<MemberChat />);
    await user.type(screen.getByLabelText("Ask a question about members"), "x{Enter}");
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".dmc-row-detail b")).toBeNull();
  });
});
