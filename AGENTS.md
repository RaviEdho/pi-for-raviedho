# AGENTS.md

Guidance and instructions for AI agents working in this repository.

## Repository Overview

`pi-for-raviedho` is a personal extension suite for the [Pi](https://github.com/earendil-works/pi) coding agent. It bundles custom providers, tools, quota monitors, and model filtering logic into an installable Pi package.

### Key Capabilities
- **Multi-Account Manager & Balancer (`accounts/`)**: Multi-account store (`accounts.json`), session affinity hashing, weekly reset pace optimization, automatic sync from Pi (`auth.json`), automatic token refresh, and transparent 429 rate limit failover across accounts during streaming turns.
- **Google Antigravity Provider (`antigravity/`)**: Custom provider integrating with Google Cloud Code Assist (`daily-cloudcode-pa.googleapis.com`) using OAuth 2.0 with automatic project discovery / onboarding (`cloudaicompanionProject`).
- **Charm Hyper Provider (`hyper/`)**: Custom provider connecting to Charm Hyper (`https://hyper.charm.land/v1`) with device code OAuth flow (`/login hyper`), API key authentication (`HYPER_API_KEY`), live dynamic model discovery (`/v1/provider`), reasoning effort level translation, and multi-account load balancing.
- **OpenAI Codex Plan Filter (`codex-filter/`)**: Dynamic tier detection from OAuth token JWT claims (`chatgpt_plan_type`). Fetches the live model catalog from OpenAI and drops unsupported models from `/model` and `pi --list-models` via `@earendil-works/pi-ai`'s native `filterModels` hook.
- **Provider Quota & Usage Monitor (`usage/`)**: Live multi-account quota tracking, percentage consumption bars, and reset countdowns across configured providers via the `/usage` command.

---

## Directory Layout

```text
pi-for-raviedho/
├── accounts/
│   ├── balancer.ts             # AccountBalancer: session affinity, 429 cooldown, token refresh
│   ├── index.ts                # Account subsystem public exports
│   ├── store.ts                # AccountStore: persistence, auth.json sync
│   ├── types.ts                # AccountCredential and store schemas
│   └── wrapper.ts              # executeWithMultiAccountFailover: stream wrapper with 429 rotation
├── antigravity/
│   ├── constants.ts            # Wire profiles, OAuth endpoints, Google client configuration
│   ├── models.ts               # Dynamic model catalog discovery & collapsing from Google
│   ├── oauth.ts                # OAuth 2.0 PKCE flow, loopback server, and token refresh
│   ├── stream.ts               # Cloud Code Assist SSE streaming client & schema transformation
│   └── types.ts                # Cloud Code Assist protocol schemas
├── codex-filter/
│   ├── catalog.ts              # Live catalog fetching from OpenAI & disk caching
│   ├── index.ts                # Provider wrapper with filterModels hook
│   ├── plan.ts                 # JWT claim parsing for chatgpt_plan_type & chatgpt_account_id
│   └── types.ts                # Catalog & cache types
├── hyper/
│   ├── constants.ts            # Base URLs, API endpoints, User-Agent, timeouts
│   ├── models.ts               # Dynamic model catalog discovery & fallback mapping from Hyper
│   ├── oauth.ts                # OAuth 2.0 Device Flow login, loopback poll, and token exchange
│   ├── stream.ts               # Streaming client via OpenAI Chat Completions compatibility
│   └── types.ts                # Hyper device auth, token, and model schemas
├── usage/
│   ├── antigravity.ts          # Cloud Code Assist quota bucket scraper
│   ├── codex.ts                # OpenAI Codex /wham/usage quota scraper
│   ├── format.ts               # Terminal & ASCII progress bar formatting
│   ├── hyper.ts                # Charm Hyper /v1/credits quota scraper
│   ├── index.ts                # /usage command registration (TUI overlay + CLI fallback)
│   └── types.ts                # Quota report structures
├── index.ts                    # Root extension entry point
├── package.json                # Pi manifest, package metadata, peerDependencies
├── tsconfig.json               # NodeNext TypeScript configuration
└── README.md                   # User documentation
```

---

## Development Principles & Rules

1. **Root-Level Package Structure**:
   - `index.ts` lives at the repository root. Do not wrap files in redundant nested directories (e.g. avoid `pi-for-raviedho/pi-for-raviedho/`).
   - `package.json` declares `"pi": { "extensions": ["./index.ts"] }`.

2. **Module Imports & NodeNext**:
   - `tsconfig.json` uses `"moduleResolution": "NodeNext"`.
   - **All relative imports within TypeScript source files MUST use the `.js` extension** (e.g. `import { foo } from "./bar.js";`).

3. **Pi Core Dependencies**:
   - `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `@earendil-works/pi-agent-core` are host-provided dependencies.
   - Always declare them under `peerDependencies` with `"*"` and under `devDependencies`. Do NOT list them under `dependencies` to prevent duplicating packages during `pi install`.

4. **Zero Hardcoded Model Names**:
   - Model discovery must be dynamic whenever possible.
   - For Antigravity: query Google's `fetchAvailableModels` endpoint.
   - For Charm Hyper: query `https://hyper.charm.land/v1/provider`.
   - For OpenAI Codex: query `https://chatgpt.com/backend-api/codex/models?client_version=1.0.0` and cross-reference `available_in_plans`.

5. **Type Safety**:
   - Always run `npm run typecheck` before committing.

---

## Testing Workflow

### 1. Verification Commands
```bash
# Typecheck TypeScript files
npm run typecheck

# Test extension directly without installing
pi -e ./index.ts --model google-antigravity/gemini-2.5-flash -p "say hello"

# Install globally to test local build
pi install .

# Verify active models
pi --list-models

# Test commands
pi -p "/usage"
```

---

## Release & Distribution Workflow

This package is distributed directly via **GitHub** (`pi install git:github.com/RaviEdho/pi-for-raviedho`).

### Step-by-Step Release Process

1. **Ensure Working Directory is Clean**:
   ```bash
   git status
   npm run typecheck
   ```

2. **Bump the Version**:
   Use `npm version` to update `package.json`, create a commit, and create a git tag:
   ```bash
   # Bug fixes / small updates:
   npm version patch

   # New features / new models:
   npm version minor

   # Breaking changes:
   npm version major
   ```

3. **Push Commits and Tags**:
   ```bash
   git push --follow-tags
   ```

4. **Create GitHub Release**:
   ```bash
   gh release create vX.Y.Z --generate-notes
   ```
