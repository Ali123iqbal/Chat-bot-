# DIGICON Member Chatbot

A read-only chatbot for authorized DIGICON leadership. It answers questions about **accepted members** (department, class schedule, commute, ability to stay late) from a CSV file. It is built with TypeScript, React and a Next.js-compatible API, and is structured so it can be dropped into a larger application later.

Version 1 uses structured searches and factual response templates. **No AI model is connected**, so there are no AI keys, no AI costs, and no member data leaves your server.

---

## 1. Quick start (Windows or any OS)

Requirements: Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run it locally:

1. Create `.env.local` in the project root (next to `package.json`):

   ```dotenv
   DIGICON_LEADERSHIP_TOKENS=digicon-demo-token-2026:faah
   ```

   Format is `token:userName`. Tokens must be at least 16 characters. Separate several people with commas: `tokenOne-1234567890:faah,tokenTwo-1234567890:sara`.

2. Load the fictional sample data (once):

   ```bash
   npm run refresh -- fixtures/members.csv
   ```

3. Start the app (restart it whenever you change `.env.local`):

   ```bash
   npm run dev
   ```

4. Open http://localhost:3000, enter the token (the part before the colon) and click **Open chat**.

Never commit `.env.local`, and never put real secrets in `.env.example`.

---

## 2. Project structure

```
src/
  components/MemberChat.tsx    Reusable React chat component (+ MemberChat.css)
  app/page.tsx                 Demo page with a token field
  app/api/chat/route.ts        POST (ask) and DELETE (clear conversation)
  app/api/status/route.ts      GET dataset status
  lib/
    types.ts                   Member, schedule and result types
    data/
      import.ts                CSV -> validated members (all-or-nothing)
      csv.ts                   Small CSV parser
      schedule.ts              Schedule cell parsing and slot state rules
      lateStay.ts              Late-stay time parsing and verdicts
      departments.ts           Official names and aliases
      source.ts                MemberSource interface, CSV connector, refresh tool
    search/index.ts            Allow-listed, validated search functions
    ai/adapter.ts              Optional AI adapter interface (OFF by default) + validation + monthly cap
    chat/
      intent.ts                Question -> intent (rule-based parser)
      engine.ts                Intent -> factual reply (templates)
      sessions.ts              Per-user conversations with idle timeout
    server/
      handlers.ts              Request handlers (framework-neutral Request/Response)
      auth.ts                  AuthAdapter interface + dev token adapter
      limits.ts                Size limits and rate limiter
scripts/refresh.ts             Maintainer CSV refresh (outside the chat API)
fixtures/members.csv           Fictional sample data
tests/                         Automated tests
```

The four parts the brief asks to keep separate map to: chat UI (`components/`), validated search functions (`lib/search/`), data connector (`lib/data/source.ts`), and the optional AI adapter (`lib/ai/adapter.ts`, switched off, see section 9).

---

## 3. Member data (CSV template)

The source contains accepted members only. Header names are matched ignoring case, spaces and punctuation.

| Column | Required | Notes |
|---|---|---|
| `student_id` | yes | Kept as text. Must match the ID pattern (default `^\d{5}-\d{5}$`, e.g. `20231-33987`). Duplicates are rejected. |
| `full_name` | yes | |
| `department` | yes | Official name or an alias (see below). Stored as the official name. |
| `commute` | yes (may be blank) | Free text, shown as recorded. |
| `late_stay_original` | yes (may be blank) | The member's original wording, kept exactly. |
| `late_stay_until` | no | Interpreted time, only when unambiguous: `17:00` or `5 pm`. A bare `5` is rejected as ambiguous. |
| `late_stay_conditions` | no | e.g. `with advance notice`. Any value makes the answer conditional. |
| `schedule_mon_wed` | yes | Monday/Wednesday, slots 1-4 |
| `schedule_tue_thu` | yes | Tuesday/Thursday, slots 1-4 |
| `schedule_sat` | yes | Saturday, slots 1-3 |
| `schedule_sun` | yes | Sunday, slots 1-3 |
| `timetable_semester` | no | |
| `updated_at` | no | |

Other columns (for example CNIC, date of birth, phone, email) are **ignored and never loaded**. The refresh tool lists which columns it ignored.

**Departments:** Game Tech; Tech Development; HR; Marketing; Media & Production; Logistics; Creatives & Design; Events & Operations. Aliases such as "Media", "Dev", "Human Resources", "Events" are recognized in searches and in the CSV.

### Schedule cells

| Cell value | Meaning |
|---|---|
| (blank) | Not answered. Schedule is **unknown**. Never treated as "free". |
| `No classes` | Answered, no classes (`answered: true`, empty slot list) |
| `1,3` | Answered, classes in slots 1 and 3 |

A grouped answer applies to both named days (Monday/Wednesday, Tuesday/Thursday). Friday has no timetable group. Only confirmed no-class slots match a no-class search; members with unknown schedules are reported separately. Clock times are not invented. "No class" does not guarantee availability for society work, and replies say so.

### Late-stay answers

- The original wording is always kept and shown.
- A member counts as able to stay until a time only if `late_stay_until` is set, is at or after the requested time, **and** there are no conditions.
- "Until 5 pm with advance notice" is reported as **conditional**, never as an unconditional yes.
- Blank or unclear answers stay **unknown**.
- Conditions written without a time (for example "after exams") are kept and shown, but the answer still counts as unknown.

### Mixed applicant files

If the CSV has an acceptance-like column (for example `status`, `decision`, `applicant`), the importer **refuses the file** unless you set both `DIGICON_ACCEPT_COLUMN` and `DIGICON_ACCEPT_VALUE`. Rows that do not match the value are then dropped.

---

## 4. Refreshing the data

Version 1 uses a manual refresh by an authorized data maintainer. It is a command-line tool and is **not** part of the chatbot's read-only API.

```bash
npm run refresh -- path/to/members.csv
```

- The **whole file is validated first**. Errors are listed with line numbers (bad ID format, duplicate ID, unknown department, slot out of range, ambiguous time, missing columns).
- On failure, the **last valid dataset stays active** and the errors are recorded.
- On success, the dataset is replaced atomically. Members removed from the file disappear from future answers, and follow-up questions re-run against the new data.
- The chat header shows the member count, the last successful refresh time, and a warning if the latest refresh failed.

The active data lives in `data/active.csv` and `data/status.json` (git-ignored). A live Google Sheets or database connector can be added by implementing the `MemberSource` interface in `src/lib/data/source.ts`; agree the refresh interval before building it.

---

## 5. API reference

All routes require `Authorization: Bearer <token>`. Responses are JSON with `cache-control: no-store`.

### `POST /api/chat`

Request body (max 2,048 bytes):

```json
{ "message": "Which HR members have no classes on Monday, second slot?", "conversationId": "optional" }
```

- `message`: 1 to 500 characters.
- `conversationId`: omit on the first message. The server returns one; send it back for follow-ups such as "What about Tuesday?".

Success `200`:

```json
{
  "conversationId": "uuid",
  "reply": {
    "kind": "answer | clarify | no_match | unknown | error",
    "text": "…",
    "rows": [{ "title": "Name", "subtitle": "20231-10003 · HR", "detail": "optional" }],
    "note": "optional, e.g. paging hint",
    "suggestions": ["optional starter questions"]
  }
}
```

`kind` distinguishes the cases: `clarify` (which person do you mean?), `no_match` (searched, nothing found), `unknown` (question not understood), `error` (invalid search, e.g. a day with no timetable). Missing information (unknown schedule or late-stay) is stated inside the answer, never guessed.

Error responses:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_json`, `invalid_message` | Bad body or message length |
| 401 | `unauthorized` | Missing or wrong token |
| 404 | `conversation_not_found` | Unknown, expired, or someone else's conversation (indistinguishable on purpose) |
| 413 | `request_too_large` | Body over 2,048 bytes |
| 429 | `rate_limited` | More than 20 requests per minute per user (`retry-after` header) |
| 429 | `too_many_failed_attempts` | 10 failed sign-ins in a minute from one client address. Applies to every route (`retry-after` header) |
| 503 | `data_unavailable` | Data source unavailable. This is a service error, **not** "no match" |

### `DELETE /api/chat?conversationId=<id>`

Ends the conversation (used by "Clear conversation" and for logout). Returns `204`. Only the owner can end it.

### `DELETE /api/session`

Logout hook. Ends **every** conversation of the signed-in user. Call it from your sign-out flow. Returns `204`. Other users' conversations are untouched.

### `GET /api/status`

```json
{
  "memberCount": 15,
  "lastSuccessfulRefresh": "2026-10-09T05:57:55.546Z",
  "lastRefreshError": null
}
```

When the latest refresh failed, `lastRefreshError` is `{ "at": "…", "summary": ["first few errors"] }`.

### Supported questions

- "Is Ahmed in DIGICON?" / "Find student ID 20231-33987."
- "Who is in Media & Production?" / "How many members are in each department?"
- "Which HR members have no classes on Monday, second slot?" then "What about Tuesday?"
- "How does this member commute?" / "How does Sara Malik commute?"
- "Who can stay until 5 pm?" (a bare "5" asks for am/pm)
- "more" to page through long lists (10 per page; counts cover all matches)

When names overlap, the bot lists the candidates and asks which person is meant; reply with a student ID or full name.

---

## 6. Using the React component

```tsx
import { MemberChat } from "@/components/MemberChat";

<MemberChat
  apiBase="/api"
  getAuthHeaders={() => ({ authorization: `Bearer ${token}` })}
  onUnauthorized={() => signOut()}
  timeoutMs={15000}
/>
```

| Prop | Default | Purpose |
|---|---|---|
| `apiBase` | `/api` | Base path of the API |
| `getAuthHeaders` | none | Returns auth headers for every request |
| `onUnauthorized` | none | Called on a 401 so your app can sign the user out |
| `timeoutMs` | `15000` | Request timeout |
| `starters` | 4 sample questions | Questions shown in the empty state |

It includes loading, empty, error and timeout states (with Retry), a clear-conversation button, keyboard-accessible controls, an `aria-live` conversation log, visible focus, dark mode and reduced-motion support. Member data is always rendered as plain text, never HTML.

---

## 7. Access, privacy and safety

- **Authorization on every route**, checked on the server. The included `EnvTokenAuth` adapter fails closed (no tokens configured means nobody gets in). Replace it by implementing `AuthAdapter` (`authenticate(req) -> { id } | null`) and calling `setAuthForTests` or editing `getAuth()` in `src/lib/server/auth.ts`.
- **Conversations are bound to the signed-in user.** Another user gets the same `404` as for an unknown ID. Context expires after **30 minutes idle** (`DIGICON_IDLE_MINUTES`), on "Clear conversation", or when you call `DELETE /api/chat`. Call `DELETE /api/session` on logout to end all of a user's conversations at once.
- **No free-form queries.** Only allow-listed, validated search functions run. There is no SQL and no AI-generated query.
- **Spreadsheet cells are data, not instructions.** Nothing from the CSV is ever interpreted as a command; text like "ignore previous instructions" is just displayed as a recorded answer.
- **Sensitive columns** (CNIC, DOB, contact details) are never loaded.
- **Logs contain only** route, status and duration. Never questions, answers or transcripts.
- **Limits:** 500-character messages, 2,048-byte bodies, 20 requests/minute per user, 10 rows per page.
- **Token-guessing protection:** after 10 failed sign-ins in a minute from one client address (taken from `x-forwarded-for` or `x-real-ip`, otherwise one shared bucket), that address is blocked for the rest of the minute, even with a correct token. Make sure your proxy sets `x-forwarded-for` itself, since a client-supplied value can't be trusted.
- **Read-only:** the chat API never writes to the data source. Use read-only credentials for any future live connector.

---

## 8. Configuration

Set these in `.env.local` (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DIGICON_LEADERSHIP_TOKENS` | none (nobody authorized) | `token:userId,token2:userId2` |
| `DIGICON_DATA_DIR` | `./data` | Where `active.csv` and `status.json` live |
| `DIGICON_ID_PATTERN` | `^\d{5}-\d{5}$` | Student ID format (regex) |
| `DIGICON_ACCEPT_COLUMN` / `DIGICON_ACCEPT_VALUE` | empty | Acceptance filter, needed only if your CSV has such a column |
| `DIGICON_IDLE_MINUTES` | `30` | Conversation idle timeout |

---

## 9. Optional AI adapter (switched off)

The brief allows an AI model to *interpret* questions without receiving the dataset. The adapter **interface is built and tested, but no provider is connected**, so by default (`NoopInterpreter`) nothing is sent anywhere and there is no cost.

How it works (`src/lib/ai/adapter.ts`):

1. The rule-based parser answers first. Only if it returns `unknown` does the server ask the interpreter.
2. The interpreter receives **only the question text**. Never member records, names or IDs from the dataset.
3. Its output is treated as untrusted and run through `validateIntent`, an allow-list of the existing intent types (departments, days, slots and times are checked, extra fields dropped). Anything else is discarded and the user sees the normal "can't answer" reply. The model can never trigger anything except the existing validated searches, and never produces SQL.
4. `CappedInterpreter` wraps any provider with a hard **monthly request cap**.

To enable a provider later:

1. Agree the provider and monthly budget first.
2. Implement `IntentInterpreter` (`interpret(question) -> Promise<unknown | null>`) on the server, with the provider key in a server-side environment variable.
3. Register it at startup with `setInterpreter(new CappedInterpreter(yourProvider, MONTHLY_CAP))`.
4. Document its **internet requirement**: the server must be able to reach the provider's API.

### Running costs

```
monthly cost = hosting/service costs
             + (input tokens   x input rate)
             + (output tokens  x output rate)
```

Use matching units, for example tokens in millions and rates per 1 million tokens.

- **Today (no AI):** the cost is hosting only.
- **With an AI provider:** illustrative example with made-up rates, not real prices: 2,000 questions a month, 600 input tokens and 80 output tokens each gives 1.2M input and 0.16M output tokens. At a hypothetical $1 per 1M input and $5 per 1M output, that is 1.2 x $1 + 0.16 x $5 = **$2.00** plus hosting. Replace the rates with your provider's current pricing before relying on any figure, and set the usage cap before enabling a paid provider.

---

## 10. Testing

```bash
npm run typecheck   # TypeScript errors
npm test            # all automated tests
npm run build       # production build
```

The tests cover: ID, name and department matching; grouped schedules; unknown vs no-class; ambiguous names; follow-ups; refresh and removal of members; failed refresh keeping the old data; unauthorized access; conversation isolation, idle expiry and logout; throttling of failed sign-ins; the AI adapter (off by default, allow-list validation, question-only input, monthly cap); request limits and rate limiting; metadata-only logging; malicious text in source data; and the UI states (loading, error with retry, timeout, unauthorized, clear conversation, plain-text rendering).

---

## 11. Known limitations

- The question parser is rule-based, so unusual phrasings may get an "I can't answer that" reply. Extend `src/lib/chat/intent.ts` or connect an AI provider through the adapter for wider coverage.
- Conversations, the rate limiter and the failed-sign-in counter are stored in memory. That is fine for one server instance; use a shared store (for example Redis) if you run several.
- The dev token adapter is for development. Plug in your real sign-in before production.
- The CSV column layout and schedule cell format are an agreed starting template. If your real form export differs, adjust the header names in `src/lib/data/import.ts`.
