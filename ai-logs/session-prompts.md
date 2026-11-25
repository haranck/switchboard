# AI session prompt and work record

The assessment attachment is copied verbatim next to this file as
`assessment-implementation-request.txt`. This file captures the direct chat
prompts and summarizes implementation/test work; it is not a platform-generated
raw export of hidden system or tool messages.

## Prompt 1

> I am working on a 2-hour technical assessment called **Switchboard – Shared Team Inbox**.
>
> I need you to act as my senior software engineering mentor. First, inspect my entire project and explain the current state before making any changes.
>
> ### 1. Understand the assessment
> Read these files in this exact order:
> 1. `START_HERE.md`
> 2. `BRIEF.md`
> 3. `PIGEON.md`
> Use these files as the source of truth. Do not invent requirements.
>
> Important restrictions:
> - Do NOT read `SUBMISSION.md` yet. It is intended for the final 10 minutes of the assessment.
> - `REFERENCE.pdf` is lookup-only. Do not read it from beginning to end.
> - Read `PAYBOX.md` and `BONUS_BILLING.md` only after the core requirements are completed.
>
> ### 2. Inspect my current project
> Check:
> - Existing folder and file structure.
> - `package.json` and available scripts.
> - `scaffold/server` and `scaffold/web`.
> - Existing backend source files.
> - Existing frontend source files.
> - Dependencies already installed or missing.
> - Environment configuration.
> - MongoDB and Redis configuration.
> - Docker containers and assessment services, if their status can be checked.
>
> ### 3. Tell me exactly what is already completed
> I have already:
> - Created the GitHub repository.
> - Copied the assessment starter files into the project.
> - Initialized Git and pushed the starter code.
> - Started the Docker assessment services using `npm run up`.
> - Successfully ran `npm run doctor`.
> Do not assume that the application backend or frontend has already been implemented.
>
> Tell me:
> - Is the backend server actually implemented?
> - Is the frontend implemented?
> - Are dependencies installed?
> - Is there an existing API?
> - Is MongoDB configured?
> - Is Redis configured?
> - Which assessment services are running?
> - What is still missing?
>
> ### 4. Create a clear implementation plan
> Compare the assessment requirements against the existing code. Give me a prioritized checklist divided into:
> **Phase 1 – Setup:** remaining installation/configuration and backend/frontend startup.
> **Phase 2 – Core backend:** endpoints, auth/authorization, models/relationships, webhooks, message storage/conversations, provider replies, and other brief requirements.
> **Phase 3 – Frontend:** screens, API integration, auth, inbox/conversations, and replies.
> **Phase 4 – Testing:** required commands, inbound/reply testing, and when to run `npm run check` and `npm run check:full`.
> **Phase 5 – Final submission:** mention only final actions; do not open `SUBMISSION.md`.
>
> ### 5. How I want you to work
> I am still learning, so explain simply, give one task at a time, provide exact commands and expected results, do not skip important steps, avoid unnecessary changes, follow the assessment exactly, and prioritize one stored inbound webhook and one successful reply before running `npm run check`.
>
> ### 6. First response
> Do not modify files or write implementation code yet. First give me current project status, whether backend/frontend need to be built, what is complete, what remains, the exact next command, then wait for confirmation.
>
> My URLs are `REDIS_URL=redis://localhost:6380` and `MONGODB_URI=mongodb://localhost:27018/assessment`.

## Prompt 2

> you do everything automaticallyu

## Prompt 3

> #attachment:Pasted text #1 read this and isntall all the dependencies needed and give me all plase
>
> REDIS_URL=redis://localhost:6380
> MONGODB_URI=mongodb://localhost:27018/assessment
>
> all ai logs like prompt should store in ai logs
>
> and why we need curent this folder backend and frontend should always there there is we need to reference so please make sure everything do perfectly

The attached implementation request is retained verbatim in
`assessment-implementation-request.txt`.

## Work and validation record

- Inspected the starter and assessment requirements before implementation;
  left `SUBMISSION.md`, the lookup-only PDF, and bonus documents unopened.
- Installed the existing scaffold dependencies and added `ws` plus
  `@types/ws` for the required WebSocket server.
- Implemented the API, authentication, webhook processing, persistent reply
  outbox, inbox UI, and Redis-backed real-time updates inside the existing
  scaffold folders.
- `npm --prefix scaffold/server run typecheck` passed.
- `npm --prefix scaffold/web run typecheck` and `npm --prefix scaffold/web run
  build` passed.
- Manual inbound webhook was stored; a manual reply reached Pigeon with
  `delivered` status and an idempotency key.
- `npm run check` passed level 1: 24/24.
- `npm run check -- --levels 5` passed level 5: 15/15.
- `npm run check:full` passed levels 1, 2, 3, and 5: 75/75.
