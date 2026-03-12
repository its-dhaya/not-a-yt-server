# not-a-yt-server — Backend

Node.js/Express backend for the not-a-yt YouTube Shorts generator.
Handles script generation, stock footage search, TTS voiceover, subtitle generation, and FFmpeg video rendering.

---

## Tech Stack

- **Node.js** + **Express**
- **Groq API** — LLM script generation (llama-3.1-8b-instant)
- **Pexels API** + **Pixabay API** — stock footage search
- **edge-tts** (Python) — neural text-to-speech
- **Whisper** (Python/OpenAI) — subtitle generation
- **FFmpeg** — video stitching, subtitle burn-in, audio mixing
- **Supabase** — JWT auth + server-side API key storage
- **Helmet** + **express-rate-limit** — security

---

## Prerequisites

Install all of these before running the server:

### System dependencies

| Tool             | Install                          |
| ---------------- | -------------------------------- |
| **Node.js** v18+ | https://nodejs.org               |
| **Python** 3.8+  | https://python.org               |
| **FFmpeg**       | https://ffmpeg.org/download.html |

> **FFmpeg must be in your system PATH.** Test with `ffmpeg -version` in terminal.

### Python packages

```bash
pip install edge-tts openai-whisper
```

Test they work:

```bash
python -m edge_tts --version
python -m whisper --help
```

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/its-dhaya/not-a-yt-server.git
cd not-a-yt-server
```

### 2. Install Node dependencies

```bash
npm install
```

### 3. Set up environment variables

Create a `.env` file in the root of the server folder:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
FRONTEND_URL=http://localhost:5173
PORT=3000
```

Get your Supabase values from:
**Supabase Dashboard → Project Settings → API**

- `SUPABASE_URL` → Project URL
- `SUPABASE_SERVICE_ROLE_KEY` → service_role key (not the anon key)

> ⚠️ Never commit `.env` to git. The service role key has full database access.

### 4. Add background music

Place a file named `bg.mp3` in the root of the server folder.
This is mixed in at low volume as background music during rendering.
Any royalty-free MP3 works — keep it under 5MB.

### 5. Run the server

```bash
node server.js
```

Server starts on `http://localhost:3000`

---

## Project Structure

```
not-a-yt-server/
├── jobs/          # Auto-created. Each render gets its own UUID folder here
├── bg.mp3         # Background music (you must add this)
├── server.js      # Main server file
├── .env           # Environment variables (you must create this)
├── .gitignore
└── package.json
```

---

## API Endpoints

All protected routes require a Supabase Bearer token in the `Authorization` header.
The server fetches API keys from Supabase server-side — **keys are never sent from the browser**.

### `GET /progress`

Server-Sent Events stream for real-time render progress updates.
No auth required.

### `POST /generate-script`

Generates a 10-scene facts script using Groq LLM.

**Auth required:** Yes
**Rate limit:** 20 requests/hour per IP

Request:

```json
{ "topic": "Ancient Rome" }
```

Response:

```json
{
  "script": ["Scene 1 text...", "Scene 2 text..."],
  "keywords": ["colosseum rome", "roman forum", "...]
}
```

### `POST /get-clips`

Searches Pexels and Pixabay for stock footage clips matching each keyword.

**Auth required:** Yes

Request:

```json
{
  "script": ["line 1", "line 2"],
  "keywords": ["keyword 1", "keyword 2"]
}
```

Response:

```json
{
  "scenes": [
    {
      "text": "line 1",
      "clips": [{ "preview": "https://...", "source": "pexels" }]
    }
  ]
}
```

### `POST /generate-video`

Full render pipeline: TTS → download clips → resize → subtitles → stitch → mix audio.

**Auth required:** Yes
**Rate limit:** 5 renders/hour per IP

Request:

```json
{
  "script": ["line 1", "line 2", "...10 lines"],
  "videoUrls": ["https://clip1.mp4", "https://clip2.mp4", "...10 urls"],
  "voice": "en-US-JennyNeural"
}
```

Response:

```json
{
  "success": true,
  "jobId": "uuid-here"
}
```

### `GET /stream/:jobId`

Streams the rendered video for browser preview. No cleanup after.

### `GET /download/:jobId`

Triggers MP4 download. Deletes the job folder after download completes.

### `POST /preview-voice`

Generates a short audio preview for a given voice.
No auth required.

Request:

```json
{ "voice": "en-US-JennyNeural", "text": "Preview text here" }
```

Response: `audio/mpeg` binary stream

---

## Available TTS Voices

| ID                    | Name    | Accent | Gender |
| --------------------- | ------- | ------ | ------ |
| `en-US-JennyNeural`   | Jenny   | 🇺🇸 US  | Female |
| `en-US-GuyNeural`     | Guy     | 🇺🇸 US  | Male   |
| `en-GB-SoniaNeural`   | Sonia   | 🇬🇧 UK  | Female |
| `en-GB-RyanNeural`    | Ryan    | 🇬🇧 UK  | Male   |
| `en-AU-NatashaNeural` | Natasha | 🇦🇺 AU  | Female |
| `en-AU-WilliamNeural` | William | 🇦🇺 AU  | Male   |
| `en-IN-NeerjaNeural`  | Neerja  | 🇮🇳 IN  | Female |
| `en-IN-PrabhatNeural` | Prabhat | 🇮🇳 IN  | Male   |

---

## Render Pipeline

When `/generate-video` is called, the server runs these steps in order:

```
1. Write script to script.txt
2. edge-tts → voice.mp3 (TTS voiceover)
3. ffprobe → get audio duration
4. Download all clip MP4s from Pexels/Pixabay
5. FFmpeg → resize each clip to 1080x1920 (9:16)
6. Whisper → voice.srt (auto subtitles from voiceover)
7. FFmpeg xfade → stitch all clips with fade transitions
8. FFmpeg → burn subtitles + mix bg.mp3 + voiceover → output.mp4
```

Each render runs in its own isolated folder under `jobs/<uuid>/` and is cleaned up after download.

---

## Rate Limits

| Endpoint           | Limit                   |
| ------------------ | ----------------------- |
| All routes         | 60 requests/min per IP  |
| `/generate-script` | 20 requests/hour per IP |
| `/generate-video`  | 5 renders/hour per IP   |

---

## Security

- **JWT verification** — every protected route verifies the Supabase Bearer token
- **Server-side keys** — Groq/Pexels/Pixabay keys fetched from Supabase, never from request body
- **Input sanitization** — topic strips shell metacharacters, script strips HTML tags
- **URL validation** — all video URLs validated as `http/https` before download
- **Helmet.js** — secure HTTP headers on all responses
- **CORS** — locked to `FRONTEND_URL` env variable only

---

## Common Issues

**`ffmpeg: command not found`**

- Install FFmpeg and make sure it's in your system PATH
- Test: `ffmpeg -version`

**`python: command not found`**

- Make sure Python is installed and in PATH
- On some systems use `python3` instead of `python`
- The server uses `python -m edge_tts` and `python -m whisper`

**`edge_tts not found`**

```bash
pip install edge-tts
```

**`whisper not found`**

```bash
pip install openai-whisper
```

Note: first run downloads the Whisper model (~140MB for base model)

**`bg.mp3 not found`**

- Add a `bg.mp3` file to the server root directory

**`API keys not found` error**

- User hasn't set up their API keys in the frontend yet
- Or the Supabase `api_keys` table doesn't exist — run the SQL from the frontend README

**Render times out**

- Rendering takes 2-5 minutes depending on machine
- If deploying to Railway/Render, configure timeout to at least 10 minutes

---

## Environment Variables Reference

| Variable                    | Description                                                 |
| --------------------------- | ----------------------------------------------------------- |
| `SUPABASE_URL`              | Supabase project URL                                        |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (full DB access)                  |
| `FRONTEND_URL`              | Frontend origin for CORS (default: `http://localhost:5173`) |
| `PORT`                      | Server port (default: `3000`)                               |
