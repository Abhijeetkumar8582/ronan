# Smart Profile Form (GPT Auto-Fill)

Modern 5-question form with:
- Name
- Email
- DOB (calendar/date picker)
- Gender (radio)
- Relationship status (radio)

It uses **gpt-4o-mini** on the backend to parse conversation text and auto-fill form fields.
It also supports **DRUID realtime autofill** from chatbot activity messages.

## Setup

1. Install dependencies:
   npm install

2. Create `.env` from `.env.example` and add:
   GPT_API_URL=https://druidservicegateway.comm.eu.druidplatform.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-06-01
   GPT_BEARER_TOKEN=your_gpt_token
   DRUID_CHAT_BEARER_TOKEN=optional_fallback_token

3. Run:
   npm start

4. Open:
   http://localhost:3000

## How It Works

- Chatbot activities are monitored and parsed in realtime.
- Server calls your configured GPT endpoint (`gpt-4o-mini`) to extract known fields as JSON.
- Form fields update automatically when values are detected.

## DRUID Realtime Autofill

1. Frontend captures DRUID bearer token and conversation id directly from live network requests (fetch/XHR).
2. Backend calls `AuthorizeAnonymousAsync` (or uses captured id) to resolve active conversation session.
3. It requests `https://directline.botframework.com/v3/directline/conversations/{conversationId}/activities`.
4. New activities are sent to GPT extraction logic.
5. The frontend applies returned values directly to form fields in realtime.
