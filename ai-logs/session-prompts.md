# AI session prompt and work record

The assessment attachment is copied verbatim next to this file as
`assessment-implementation-request.txt`. This file captures the direct chat
prompts and summarizes implementation/test work; it is not a platform-generated
raw export of hidden system or tool messages.

## Prompt 1

I am working on a 2-hour technical assessment called **Switchboard – Shared Team Inbox**.

I need you to act as my senior software engineering mentor. First, inspect my entire project and explain the current state before making any changes.

### 1. Understand the assessment
Read these files in this exact order:

1. `START_HERE.md`
2. `BRIEF.md`
3. `PIGEON.md`

Use these files as the source of truth. Do not invent requirements.

Important restrictions:

- Do NOT read `SUBMISSION.md` yet. It is intended for the final 10 minutes of the assessment.
- `REFERENCE.pdf` is lookup-only. Do not read it from beginning to end.
- Read `PAYBOX.md` and `BONUS_BILLING.md` only after the core requirements are completed.

### 2. Inspect my current project
Check:

- Existing folder and file structure.
- `package.json` and available scripts.
- `scaffold/server` and `scaffold/web`.
- Existing backend source files.
- Existing frontend source files.
- Dependencies already installed or missing.
- Environment configuration.
- MongoDB and Redis configuration.
- Docker containers and assessment services, if their status can be checked.

### 3. Tell me exactly what is already completed
I have already:

- Created the GitHub repository.
- Copied the assessment starter files into the project.
- Initialized Git and pushed the starter code.
- Started the Docker assessment services using `npm run up`.
- Successfully ran `npm run doctor`.

Do not assume that the application backend or frontend has already been implemented.

Tell me:

- Is the backend server actually implemented?
- Is the frontend implemented?
- Are dependencies installed?
- Is there an existing API?
- Is MongoDB configured?
- Is Redis configured?
- Which assessment services are running?
- What is still missing?

### 4. Create a clear implementation plan
Compare the assessment requirements against the existing code.

Give me a prioritized checklist divided into:

**Phase 1 – Setup**

- Remaining installation and configuration.
- Backend and frontend startup.

**Phase 2 – Core backend**

- Required API endpoints.
- Authentication and authorization.
- Database models and relationships.
- Webhook handling.
- Message storage and conversation handling.
- Sending replies through the messaging provider.
- Any other backend requirements in `BRIEF.md` and `PIGEON.md`.

**Phase 3 – Frontend**

- Required screens.
- API integration.
- Authentication flow.
- Inbox and conversation functionality.
- Reply functionality.

**Phase 4 – Testing**

- Required commands from `START_HERE.md`.
- How to test inbound messages.
- How to test replies.
- When to run `npm run check` and `npm run check:full`.

**Phase 5 – Final submission**

- Mention only the final actions required.
- Do not open or read `SUBMISSION.md` yet.

### 5. Very important: How I want you to work
I am still learning, so:

- Explain everything in simple language.
- Give me one task at a time.
- Provide exact terminal commands I can copy and paste.
- Tell me which directory to run each command from.
- Show me the expected result after each command.
- Do not skip important steps.
- Do not create unnecessary files or change existing working configurations.
- Do not rewrite the whole project.
- Follow the assessment requirements exactly.
- Prioritize getting one inbound webhook stored and one reply successfully sent, then running `npm run check`, as instructed by the assessment.

### 6. Your first response
For now, DO NOT modify any files or write implementation code.

First give me:

1. Current project status.
2. Whether the backend server already exists or needs to be built.
3. Whether the frontend already exists or needs to be built.
4. What has been completed.
5. What remains to be done.
6. The exact next command I should run.

Wait for my confirmation before making changes.

This URL is available:

```text
REDIS_URL=redis://localhost:6380
MONGODB_URI=mongodb://localhost:27018/assessment
```

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
- Browser smoke test confirmed the signed-in inbox renders and a UI reply
  reaches `delivered`; cursor pagination returned two distinct conversations.
- `npm run check` passed level 1: 24/24.
- `npm run check -- --levels 5` passed level 5: 15/15.
- `npm run check:full` passed levels 1, 2, 3, and 5: 75/75.
