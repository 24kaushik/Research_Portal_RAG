# Research Desk

Research Commons is a shared scholarly catalog with retrieval-augmented chat. Anyone can discover, search, read, and ask questions across the public research corpus. Accounts provide researcher profiles and the ability to contribute or remove papers; contributed papers immediately become visible and searchable by everyone.

## Local services

MongoDB stores accounts, profiles, public paper metadata, and contribution ownership. Qdrant stores searchable passage vectors. Newly contributed PDF files are stored under `backend/uploads` by default. Existing legacy Qdrant papers were promoted into the public catalog from their indexed text; their original PDF files were not retained, so those entries open in the extracted-text reader.

Start Qdrant:

```bash
docker run --name research-qdrant -p 6333:6333 -v research-qdrant:/qdrant/storage qdrant/qdrant
```

MongoDB must be running at `mongodb://127.0.0.1:27017`. Copy `backend/.env.example` to `backend/.env`; set a long random `JWT_SECRET` and your `GROQ_API_KEY`. The MiniLM embedding model downloads from Hugging Face on first use and is cached locally; no hosted embedding key is used.

Install and start the API:

```bash
cd backend
npm install --legacy-peer-deps
npm run dev
```

In a second terminal, install and start the frontend:

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL to browse and search the shared catalog without signing in. Search combines paper metadata with Qdrant passage retrieval. The AI chat searches the entire public corpus and provides source links that open the corresponding paper in a new tab. To contribute, create an account and upload a PDF. Uploads are text-extracted, split into overlapping passages, embedded with `Xenova/all-MiniLM-L6-v2`, and indexed in Qdrant before the MongoDB paper record is committed. A failed ingestion cleans up partial vectors and the saved file. As with all RAG systems, answers can still miss relevant details; inspect the linked source pages for critical work.
