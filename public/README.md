# CSMS API

Node/Express prototype API wrapping the real Postgres schema (5 schemas: FMS, MSR, Master, RMS, SCS — 35 tables, per `studio_results_20260914_1811.csv`).

## Setup
```
npm install
cp .env.example .env   # then fill in DATABASE_URL
npm start
```

## What's wired
- `POST /api/auth/session` — invitation-only login. Looks up `RMS.User_Profile.Seeker_Email` -> `CSMS_ID`. No match = 401 `NO_CSMS_ACCESS`. Stamps `User_Invitation.Login_DT` on first login.
- `GET /api/seekers`, `GET /api/seekers/:id` — MSR.Seeker + Category + Other_MasterList_Info + Platform_Engagement + all three satsang-type join tables.
- `GET /api/depts`, `GET /api/depts/:id/roles` — RMS.Seva_Dept tree + role holders.
- `GET /api/satsangs/upcoming`, `/attendees`, `/transfers` — real SCS tables, including Attendee_Transfer_Requests (had zero front-end presence before).
- `GET/POST /api/intake/*` — FMS.Form_Submission_Key_Details, promote/merge into MSR.Seeker via Seeker_ID_Generator.
- `GET /api/master/*` — countries, regions, categories, platforms.

## Known gaps — do not paper over these
1. **`x-csms-id` header auth is a prototype stand-in, not real security.** Anyone can set this header to any value right now. Before any real data touches this: verify a Firebase ID token server-side (`firebase-admin`) instead.
2. **No region column on `Seva_Dept`.** Seeker filtering uses `Country_ID` directly instead of dept -> region, because the schema you shared has no region link on `Seva_Dept`. If dept-based region scoping is required, that column/join is missing.
3. **Intake "match %" is not implemented as a score.** Only exact email/WhatsApp matching is real (see `intake.js` header comment). A fuzzy-match spec is needed before that UI can be honest.
4. **`Seeker_ID_Generator.Input_Type_ID` is hardcoded to `1`.** No lookup table for input types was provided — need the real value list.
5. **`Satsang_Event_Defn.Event_ST_DT_TIME` is `bigint`.** Assumed unix seconds in the upcoming-events query — confirm before trusting it.
6. **Stage (New/Semi-active/Active/Core) has no backing table.** Journey/Kanban is not wired — see chat for the open question on this.
