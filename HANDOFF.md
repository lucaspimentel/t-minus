# HANDOFF.md — mbta-leave-by

For the next session (human or agent). Read DESIGN.md first; this file is the
operational state on top of it. Written 2026-09-29.

## What this is

Single-file static web app answering "when do I need to leave?" for a recurring
MBTA commute: 132 bus + Orange Line, both directions. Optimizes around bus
departures (the infrequent leg); treats the Orange Line as "frequent enough".
Config is data, not code, so other users can reuse the app later.

## Decisions made (do not relitigate without cause)

- Repo/name: `mbta-leave-by` (user chose; accepts the MBTA-specific prefix).
- Form factor: single `index.html`, no build step, no backend. Direct browser
  calls to `api-v3.mbta.com`; tiny local proxy only if CORS blocks direct calls.
- Persistence: `localStorage` per browser. Sharing = app URL + self-serve config.
- Optimization model: one "bottleneck" leg per commute drives `leave_by`; other
  legs are fixed offsets (transfer chaining of live Orange predictions is an
  optional refinement, not v1).
- Repo exists locally only at `~/source/lucaspimentel/mbta-leave-by`, branch
  `main`. No remote, no commits yet as of this writing; only DESIGN.md + this file.

## Open questions blocking the build (ask the user first)

1. Walk times: home → bus stop, bus stop → home, office → State station.
2. Hosting: local file vs GitHub Pages vs both.
3. API key: keyless first vs a settings field for a pasted key.
4. Refresh: manual only vs auto ~30s vs auto + countdown.
5. Extras: schedule fallback and/or service alerts, or minimal v1.

## Unverified assumptions (verify before relying on them)

All marked `[unverified]` in DESIGN.md. **The authoring session had no sandbox
network access; nothing below has been confirmed against the live API.**

- Stop IDs: `Main St @ South St` (route 132) needs lookup; Oak Grove =
  `place-ogmnl`, State = `place-state` (Orange Line) are memory-based GTFS ids.
- Direction ids: inbound 132 toward `Malden Center Station` = direction_id 0?
- CORS: does `api-v3.mbta.com` allow browser-origin calls? Test from a real
  browser or `curl -i -H "Origin: http://localhost"` and check
  `access-control-allow-origin`.
- Keyless rate limit headroom for ~30s polling.
- 132 headways (~20-30 min) and Orange headways (~5-10 min).

## Suggested next-session plan

1. Verify API basics with curl: route 132 exists; find the exact stop id for
   `Main St @ South St`; confirm direction ids and Orange Line ids. Update
   DESIGN.md to remove `[unverified]` marks.
2. CORS check (see above). If it fails, switch plan to local proxy early.
3. Get answers to the five open questions from the user.
4. Build v1 `index.html`: config schema per DESIGN.md, predictions fetch for the
   bottleneck leg, `leave_by` countdown, both-direction toggle, localStorage.
5. User smoke-tests against live data (agent sandbox may still lack network).

## Environment notes

- Working dir convention: repos live at `~/source/<owner>/<repo>`; this one at
  `~/source/lucaspimentel/mbta-leave-by`.
- Do not commit or push unless the user explicitly asks.
- GitHub account: user's personal account (`lucaspimentel`) if a remote is
  created; no org involvement.
