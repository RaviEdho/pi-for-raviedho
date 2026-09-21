# pi-for-raviedho

Personalized Pi extension package providing the **Google Antigravity** provider with full OAuth authentication and Cloud Code Assist streaming support.

## Features

- **OAuth 2.0 Integration**: Authenticate via `/login google-antigravity` using Google OAuth (browser callback on port 51121 with manual prompt fallback for remote/headless setups).
- **Automated Cloud Code Assist Project Discovery**: Automatically detects or provisions the Antigravity free tier (`cloudaicompanionProject`) via Cloud Code Assist (`daily-cloudcode-pa.googleapis.com`).
- **Full Model Support**:
  - `gemini-3.1-pro` (Default)
  - `gemini-3-pro`
  - `gemini-3.5-flash`
  - `gemini-2.5-flash`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6`
  - `claude-sonnet-4-5`
  - `claude-opus-4-5`
  - `gpt-oss-120b`
- **Tool Calling**: Full support for tool calling with schema normalization for Claude models.
- **Thinking & Reasoning Support**: Discrete effort-tier routing and thinking budget configuration.

## Usage

### 1. Install Extension Globally

```bash
pi install .
```

Verify installed packages:

```bash
pi list
```

### 2. Login via OAuth

```bash
# In an interactive Pi session:
/login google-antigravity
```

Credentials and tokens are stored in `~/.pi/agent/auth.json` and refreshed automatically.

### 3. Running with Antigravity Models

```bash
# Interactive mode with default Antigravity model
pi --model google-antigravity/gemini-3.1-pro

# Using Claude Sonnet 4.6
pi --model google-antigravity/claude-sonnet-4-6

# Non-interactive query
pi --model google-antigravity/gemini-2.5-flash -p "Summarize git status"
```

## Development

```bash
# Typecheck TypeScript files
npm run typecheck

# Test directly without installing
pi -e ./pi-for-raviedho/index.ts --model google-antigravity/gemini-2.5-flash -p "hello"
```
