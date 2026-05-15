# Production-Grade RAG Backend

A scalable **Retrieval-Augmented Generation** backend built with Node.js, Express, MongoDB Atlas Vector Search, LangChain, OpenAI, and Google Drive integration.

---

## Architecture Overview

```
Google Drive Folder (PDFs)
        │
        ▼
  drive.service.js   ← List & download PDFs
        │
        ▼
  pdf.service.js     ← Extract text per-page (pdf-parse)
        │
        ▼
  chunk.service.js   ← Split into 800-char overlapping chunks (LangChain)
        │
        ▼
  embedding.service.js ← Batch embed (text-embedding-3-small, 5/batch)
        │
        ▼
  MongoDB Atlas      ← Store embeddings permanently
        │
  (Query time)
        │
  User Question ──► embed ──► Atlas Vector Search (top 5) ──► GPT-4o-mini ──► Answer
```

---

## Folder Structure

```
server/
├── src/
│   ├── config/
│   │   ├── db.js              ← MongoDB Atlas connection (retry logic)
│   │   ├── openai.js          ← OpenAI singleton client
│   │   └── googleDrive.js     ← Google Drive JWT auth
│   ├── models/
│   │   ├── File.model.js      ← Tracks Drive PDFs + processing state
│   │   └── Embedding.model.js ← Stores 1536-dim vectors + chunk text
│   ├── services/
│   │   ├── drive.service.js      ← List & stream-download Drive PDFs
│   │   ├── pdf.service.js        ← In-memory PDF text extraction
│   │   ├── chunk.service.js      ← LangChain RecursiveCharacterTextSplitter
│   │   ├── embedding.service.js  ← Batch OpenAI embeddings + deduplication
│   │   ├── vectorSearch.service.js ← $vectorSearch aggregation pipeline
│   │   ├── rag.service.js        ← Full RAG pipeline (embed→search→GPT)
│   │   └── sync.service.js       ← Drive↔DB sync orchestrator
│   ├── cron/
│   │   └── driveSync.cron.js  ← node-cron scheduler (every 10 min)
│   ├── routes/
│   │   └── rag.routes.js
│   ├── controllers/
│   │   └── rag.controller.js
│   ├── utils/
│   │   ├── batch.util.js      ← chunkArray, processBatches, retry
│   │   ├── token.util.js      ← Token estimation & cost calculation
│   │   └── logger.util.js     ← Winston structured logger
│   └── app.js
├── server.js
├── package.json
├── .env.example
└── .gitignore
```

---

## Quick Start

### 1 — Install dependencies

```bash
cd server
npm install
```

### 2 — Configure environment

```bash
cp .env.example .env
# Edit .env with your real credentials (see Variables section below)
```

### 3 — Create MongoDB Atlas Vector Search Index

In the Atlas UI → **Search Indexes** → **Create Search Index** → **JSON Editor**:

- **Collection:** `embeddings`
- **Index name:** `vector_index`

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1536,
      "similarity": "cosine"
    }
  ]
}
```

> ⚠️ The server will return empty results until this index is active (takes ~1-3 minutes after creation).

### 4 — Set up Google Drive Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **IAM & Admin** → **Service Accounts**
2. Create a service account → **Keys** → **Add Key** → **JSON**
3. Download the JSON file
4. Copy `client_email` → `GOOGLE_CLIENT_EMAIL` in `.env`
5. Copy `private_key` → `GOOGLE_PRIVATE_KEY` in `.env` (keep the `\n` sequences)
6. Share your Google Drive **folder** with the service account email (Viewer role)
7. Copy the folder ID from the URL → `GOOGLE_DRIVE_FOLDER_ID` in `.env`

### 5 — Start the server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

On startup the server will:
1. Connect to MongoDB Atlas
2. Immediately trigger a Drive sync (after 5s)
3. Schedule recurring sync every 10 minutes

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `5000` | HTTP port |
| `MONGO_URI` | **Yes** | — | MongoDB Atlas connection string |
| `OPENAI_API_KEY` | **Yes** | — | OpenAI secret key |
| `OPENAI_CHAT_MODEL` | No | `gpt-4o-mini` | Chat completion model |
| `OPENAI_EMBEDDING_MODEL` | No | `text-embedding-3-small` | Embedding model |
| `GOOGLE_DRIVE_FOLDER_ID` | **Yes** | — | Drive folder to watch |
| `GOOGLE_CLIENT_EMAIL` | **Yes** | — | Service account email |
| `GOOGLE_PRIVATE_KEY` | **Yes** | — | Service account private key |
| `CRON_SCHEDULE` | No | `*/10 * * * *` | node-cron expression |
| `CHUNK_SIZE` | No | `800` | Characters per chunk |
| `CHUNK_OVERLAP` | No | `100` | Overlap between chunks |
| `EMBEDDING_BATCH_SIZE` | No | `5` | Chunks per OpenAI API call |

---

## API Reference

### `POST /api/rag/ask` — Ask a Question

**Request:**
```json
{
  "question": "What are the key terms of the agreement?",
  "fileId": "1abc...xyz",   // optional — restrict to one file
  "topK": 5                  // optional — chunks to retrieve (max 10)
}
```

**Response:**
```json
{
  "success": true,
  "question": "What are the key terms of the agreement?",
  "answer": "Based on the provided documents, the key terms include...",
  "sources": [
    {
      "fileName": "contract_2024.pdf",
      "googleFileId": "1abc...xyz",
      "pageNumber": 3,
      "chunkIndex": 12,
      "score": 0.9231
    }
  ],
  "meta": {
    "model": "gpt-4o-mini",
    "estimatedCostUSD": 0.000042,
    "retrievedChunks": 5
  }
}
```

---

### `POST /api/rag/sync` — Trigger Manual Sync

```bash
curl -X POST http://localhost:5000/api/rag/sync
```

**Response:**
```json
{
  "success": true,
  "message": "Sync completed",
  "summary": {
    "total": 8,
    "processed": 2,
    "skipped": 5,
    "failed": 1,
    "details": [...]
  }
}
```

---

### `GET /api/rag/files` — List Tracked Files

```
GET /api/rag/files?status=completed&page=1&limit=20
```

**Query params:** `status` (pending/processing/completed/failed), `page`, `limit`

---

### `GET /api/rag/files/:googleFileId/chunks` — View File Chunks

```
GET /api/rag/files/1abc...xyz/chunks?page=1&limit=50
```

---

### `DELETE /api/rag/files/:googleFileId` — Delete File & Embeddings

```bash
curl -X DELETE http://localhost:5000/api/rag/files/1abc...xyz
```

---

### `GET /api/rag/stats` — System Statistics

```json
{
  "success": true,
  "stats": {
    "files": {
      "total": 12,
      "completed": 10,
      "failed": 1,
      "byStatus": { "completed": 10, "failed": 1, "pending": 1 }
    },
    "embeddings": { "total": 2847 }
  }
}
```

---

### `GET /health` — Health Check

```json
{ "status": "ok", "timestamp": "2024-05-15T10:00:00.000Z" }
```

---

## Key Design Decisions

### Change Detection (Zero Redundant Embeddings)

The `sync.service.js` compares `driveModifiedTime` (ISO string from Drive API) against the value stored in the `File` document. If they match **and** the file status is `completed`, the entire PDF is skipped — no download, no PDF parse, no OpenAI calls.

### Chunk-Level Deduplication

Inside `embedding.service.js`, each chunk's SHA-256 hash is computed before any API call. A single MongoDB query checks which hashes already exist. Only genuinely new chunks consume OpenAI tokens.

### Batching Strategy

| Operation | Batch Size | Reason |
|---|---|---|
| Embedding API calls | 5 chunks | Balances throughput vs rate limits |
| MongoDB bulk insert | All at once | Single round-trip per file |
| Vector search candidates | 100 | ANN accuracy vs latency |

### Cost Optimisation

- **text-embedding-3-small**: $0.00002/1K tokens (cheapest OpenAI embedding model)
- **gpt-4o-mini**: $0.00015/$0.0006 per 1K in/out tokens
- **Top-5 chunks only** sent to GPT (not the full corpus)
- **max_tokens: 1024** caps output cost
- **temperature: 0.2** → shorter, more focused answers

---

## MongoDB Indexes Created

| Collection | Index | Purpose |
|---|---|---|
| `files` | `{ googleFileId: 1 }` unique | Fast file lookup by Drive ID |
| `files` | `{ googleFileId: 1, driveModifiedTime: 1 }` | Change detection |
| `files` | `{ status: 1, lastSyncedAt: -1 }` | Status filtering |
| `embeddings` | `{ fileId: 1, chunkIndex: 1 }` | Chunk ordering |
| `embeddings` | `{ googleFileId: 1, chunkHash: 1 }` | Deduplication |
| `embeddings` | **Atlas Vector Index** `vector_index` | Semantic search |

---

## Scaling Recommendations

| Concern | Recommendation |
|---|---|
| High query throughput | Add Redis cache for frequent questions (TTL 1 hour) |
| Large PDF volumes | Move sync to a separate worker process / Bull queue |
| Multi-tenant isolation | Add `tenantId` field to both collections + pre-filter in vector search |
| Embedding cost | Use `text-embedding-3-large` only for retrieval-critical content |
| Latency | Cache query embeddings by question hash (Redis) |
| Observability | Add OpenTelemetry tracing to all service methods |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Vector search returns 0 results | Atlas index not created / not yet active | Create `vector_index` in Atlas UI |
| `GOOGLE_PRIVATE_KEY` auth error | Escaped `\n` not replaced | Ensure `.env` value is quoted and `\n` replaced in config |
| `pdf-parse` throws on a file | Encrypted or image-only PDF | Pre-process with OCR (e.g. Tesseract) before uploading |
| Sync stuck in "processing" | Previous run crashed before completion | Manually set `status: "pending"` in DB or call DELETE then re-sync |
| OpenAI rate limit 429 | Too many batches too fast | Increase `delayMs` in `processBatches` call inside `embedding.service.js` |
