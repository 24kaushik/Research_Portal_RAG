import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import multer from "multer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { ChatGroq } from "@langchain/groq";
import { QdrantClient } from "@qdrant/js-client-rest";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Paper, User } from "./models.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const collection = process.env.QDRANT_COLLECTION ?? "research-papers";
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
const jwtSecret =
  process.env.JWT_SECRET ?? "local-development-secret-change-before-deploying";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});
const embeddings = new HuggingFaceTransformersEmbeddings({
  model: "Xenova/all-MiniLM-L6-v2",
  batchSize: 32,
});
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  apiKey: process.env.QDRANT_API_KEY || undefined,
});
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 900,
  chunkOverlap: 140,
});

type AuthRequest = Request & { userId: string };
type PaperPayload = {
  content?: string;
  ownerId?: string;
  paperId?: string;
  title?: string;
  page?: number;
  legacy?: boolean;
  metadata?: { source?: string; loc?: { pageNumber?: number }; page?: number };
};
type Citation = {
  reference: string;
  paperId: string;
  title: string;
  page: number;
  hasPdf: boolean;
};

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function issueToken(userId: string) {
  return jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "7d" });
}

function auth(request: Request, response: Response, next: NextFunction) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token)
    return response.status(401).json({ error: "Sign in to continue." });
  try {
    const payload = jwt.verify(token, jwtSecret) as jwt.JwtPayload;
    if (!payload.sub)
      return response.status(401).json({ error: "Invalid session." });
    (request as AuthRequest).userId = payload.sub;
    next();
  } catch {
    response
      .status(401)
      .json({ error: "Your session expired. Please sign in again." });
  }
}

function userView(user: InstanceType<typeof User>) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    institution: user.institution,
    bio: user.bio,
    researchInterests: user.researchInterests,
  };
}

async function ensureCollection() {
  const collections = await qdrant.getCollections();
  if (!collections.collections.some((item) => item.name === collection)) {
    await qdrant.createCollection(collection, {
      vectors: { size: 384, distance: "Cosine" },
    });
  }
}

async function deletePaperVectors(ownerId: string, paperId: string) {
  const collections = await qdrant.getCollections();
  if (!collections.collections.some((item) => item.name === collection)) return;
  await qdrant.delete(collection, {
    wait: true,
    filter: {
      must: [
        { key: "ownerId", match: { value: ownerId } },
        { key: "paperId", match: { value: paperId } },
      ],
    },
  });
}

let catalogMigration: Promise<void> | null = null;

async function ensurePublicCatalog() {
  if (!catalogMigration) {
    catalogMigration = migrateLegacyVectors().catch((error) => {
      catalogMigration = null;
      throw error;
    });
  }
  await catalogMigration;
}

async function migrateLegacyVectors() {
  const collections = await qdrant.getCollections();
  if (!collections.collections.some((item) => item.name === collection)) return;
  let offset: string | number | Record<string, unknown> | undefined;
  const legacy = new Map<
    string,
    { ids: (string | number)[]; pages: number[] }
  >();
  do {
    const result = await qdrant.scroll(collection, {
      offset,
      limit: 256,
      with_payload: true,
      with_vector: false,
    });
    for (const point of result.points) {
      const payload = point.payload as unknown as PaperPayload;
      if (payload.paperId || !payload.content) continue;
      const source = payload.metadata?.source ?? payload.title;
      if (!source) continue;
      const group = legacy.get(source) ?? { ids: [], pages: [] };
      group.ids.push(point.id);
      group.pages.push(
        Number(
          payload.metadata?.loc?.pageNumber ??
            payload.metadata?.page ??
            payload.page ??
            1,
        ),
      );
      legacy.set(source, group);
    }
    offset = (result.next_page_offset ?? undefined) as typeof offset;
  } while (offset !== undefined);

  for (const [source, group] of legacy) {
    const title = source.replace(/\.pdf$/i, "").replace(/%0A/g, " ");
    const storageName = `legacy-${createHash("sha256").update(source).digest("hex")}.pdf`;
    const paper = await Paper.findOneAndUpdate(
      { legacySource: source },
      {
        $setOnInsert: {
          legacySource: source,
          storageName,
          title,
          originalName: source.replace(/%0A/g, " "),
          uploaderName: "Research Desk community",
          hasPdf: false,
          pageCount: Math.max(...group.pages),
          chunkCount: group.ids.length,
          fileSize: 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (!paper.storageName)
      await Paper.updateOne(
        {
          _id: paper._id,
          $or: [{ storageName: { $exists: false } }, { storageName: null }],
        },
        { $set: { storageName } },
      );
    await qdrant.setPayload(collection, {
      points: group.ids,
      payload: { paperId: String(paper._id), title, legacy: true },
      wait: true,
    });
  }
}

function paperView(paper: Record<string, any>) {
  return {
    id: String(paper._id),
    title: paper.title,
    originalName: paper.originalName,
    authors: paper.authors ?? [],
    abstract: paper.abstract ?? "",
    tags: paper.tags ?? [],
    year: paper.year,
    pageCount: paper.pageCount,
    chunkCount: paper.chunkCount,
    fileSize: paper.fileSize ?? 0,
    hasPdf: paper.hasPdf !== false,
    uploaderName: paper.uploaderName ?? "Research Desk community",
    createdAt: paper.createdAt,
  };
}

function cleanStrings(value: unknown, maxItems: number, maxLength: number) {
  if (Array.isArray(value))
    return value
      .map((item) => String(item).trim().slice(0, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim().slice(0, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  return [];
}

app.get("/api/health", (_request, response) =>
  response.json({
    ok: true,
    service: "research-desk",
    mongo: mongoose.connection.readyState === 1,
  }),
);

app.post("/api/auth/register", async (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  const email = String(request.body?.email ?? "")
    .trim()
    .toLowerCase();
  const password = String(request.body?.password ?? "");
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
    return response
      .status(400)
      .json({
        error:
          "Enter a name, valid email, and password with at least 8 characters.",
      });
  }
  try {
    const existing = await User.findOne({ email });
    if (existing)
      return response
        .status(409)
        .json({ error: "An account with this email already exists." });
    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
    });
    response
      .status(201)
      .json({ token: issueToken(String(user._id)), user: userView(user) });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: "Could not create your account." });
  }
});

app.post("/api/auth/login", async (request, response) => {
  const email = String(request.body?.email ?? "")
    .trim()
    .toLowerCase();
  const password = String(request.body?.password ?? "");
  try {
    const user = await User.findOne({ email }).select("+passwordHash");
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      return response
        .status(401)
        .json({ error: "Email or password is incorrect." });
    response.json({
      token: issueToken(String(user._id)),
      user: userView(user),
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: "Could not sign in." });
  }
});

app.get("/api/auth/me", auth, async (request, response) => {
  const user = await User.findById((request as AuthRequest).userId);
  if (!user) return response.status(404).json({ error: "Account not found." });
  response.json(userView(user));
});

app.patch("/api/profile", auth, async (request, response) => {
  const body = request.body ?? {};
  const update: Record<string, unknown> = {};
  if (body.name !== undefined)
    update.name = String(body.name).trim().slice(0, 80);
  if (body.institution !== undefined)
    update.institution = String(body.institution).trim().slice(0, 160);
  if (body.bio !== undefined)
    update.bio = String(body.bio).trim().slice(0, 1000);
  if (body.researchInterests !== undefined)
    update.researchInterests = cleanStrings(body.researchInterests, 20, 50);
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email))
      return response
        .status(400)
        .json({ error: "Enter a valid email address." });
    update.email = email;
  }
  try {
    const user = await User.findByIdAndUpdate(
      (request as AuthRequest).userId,
      update,
      { new: true, runValidators: true },
    );
    if (!user)
      return response.status(404).json({ error: "Account not found." });
    response.json(userView(user));
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      return response
        .status(409)
        .json({ error: "That email is already in use." });
    console.error(error);
    response.status(400).json({ error: "Could not update your profile." });
  }
});

app.get("/api/papers", async (request, response) => {
  try {
    await ensurePublicCatalog();
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(60, Math.max(1, Number(request.query.limit) || 24));
    const filters: Record<string, unknown> = {};
    const search = String(request.query.q ?? "")
      .trim()
      .slice(0, 120);
    const metadataQuery: Record<string, unknown> = {};
    if (search) {
      const terms = search.split(/\s+/).filter(Boolean).slice(0, 10);
      metadataQuery.$and = terms.map((term) => {
        const pattern = new RegExp(
          term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        );
        return {
          $or: [
            { title: pattern },
            { originalName: pattern },
            { authors: pattern },
            { abstract: pattern },
            { tags: pattern },
          ],
        };
      });
    }
    if (request.query.year) filters.year = Number(request.query.year);
    if (request.query.author)
      filters.authors = new RegExp(
        String(request.query.author)
          .slice(0, 80)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
    if (request.query.tag)
      filters.tags = new RegExp(
        String(request.query.tag)
          .slice(0, 50)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
    const sort: Record<string, 1 | -1> =
      request.query.sort === "oldest"
        ? { createdAt: 1 }
        : request.query.sort === "title"
          ? { title: 1 }
          : { createdAt: -1 };
    let papers: Array<Record<string, any>>;
    let total: number;
    if (search) {
      const exactMatches = await Paper.find({ ...filters, ...metadataQuery })
        .sort(sort)
        .limit(100)
        .lean();
      const vector = await embeddings.embedQuery(search);
      const matches = await qdrant.query(collection, {
        query: vector,
        limit: 100,
        with_payload: ["paperId"],
      });
      const rankedIds = [
        ...new Set(
          matches.points
            .map((point) =>
              String(
                (point.payload as { paperId?: string } | null)?.paperId ?? "",
              ),
            )
            .filter(mongoose.isValidObjectId),
        ),
      ];
      const vectorMatches = await Paper.find({
        ...filters,
        _id: { $in: rankedIds },
      }).lean();
      const vectorById = new Map(
        vectorMatches.map((paper) => [String(paper._id), paper]),
      );
      const merged = new Map<string, Record<string, any>>();
      for (const paper of exactMatches) merged.set(String(paper._id), paper);
      for (const id of rankedIds) {
        const paper = vectorById.get(id);
        if (paper) merged.set(id, paper);
      }
      const ordered = [...merged.values()];
      if (request.query.sort === "title")
        ordered.sort((a, b) => a.title.localeCompare(b.title));
      else if (request.query.sort === "oldest")
        ordered.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
      papers = ordered.slice((page - 1) * limit, page * limit);
      total = ordered.length;
    } else {
      [papers, total] = await Promise.all([
        Paper.find(filters)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Paper.countDocuments(filters),
      ]);
    }
    response.json({
      papers: papers.map(paperView),
      total,
      page,
      pages: Math.ceil(total / limit),
      limit,
    });
  } catch (error) {
    console.error("Public catalog search failed:", error);
    response
      .status(503)
      .json({
        error: "Could not load the research catalog. Check MongoDB and Qdrant.",
      });
  }
});

app.get("/api/my/papers", auth, async (request, response) => {
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 60));
  const owned = { ownerId: (request as AuthRequest).userId };
  const [papers, total] = await Promise.all([
    Paper.find(owned).sort({ createdAt: -1 }).limit(limit).lean(),
    Paper.countDocuments(owned),
  ]);
  response.json({
    papers: papers.map(paperView),
    total,
    page: 1,
    pages: Math.ceil(total / limit),
    limit,
  });
});

app.get("/api/papers/:paperId", async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.paperId))
    return response.status(400).json({ error: "Invalid paper id." });
  const paper = await Paper.findById(request.params.paperId).lean();
  if (!paper) return response.status(404).json({ error: "Paper not found." });
  response.json(paperView(paper));
});

app.post(
  "/api/papers",
  auth,
  upload.single("file"),
  async (request, response) => {
    const file = request.file;
    if (!file)
      return response.status(400).json({ error: "Choose a PDF to upload." });
    if (
      file.mimetype !== "application/pdf" ||
      file.buffer.subarray(0, 5).toString() !== "%PDF-"
    )
      return response
        .status(415)
        .json({ error: "The selected file is not a valid PDF." });
    const userId = (request as AuthRequest).userId;
    const paperId = new mongoose.Types.ObjectId();
    const storageName = `${paperId}-${randomUUID()}.pdf`;
    const targetPath = path.join(uploadDir, storageName);
    try {
      await mkdir(uploadDir, { recursive: true });
      const loader = new PDFLoader(new Blob([new Uint8Array(file.buffer)]), {
        splitPages: true,
      });
      const pages = await loader.load();
      const chunks = await splitter.splitDocuments(pages);
      if (!chunks.length || chunks.every((chunk) => !chunk.pageContent.trim()))
        return response
          .status(422)
          .json({
            error:
              "No selectable text was found in this PDF. OCR scanned documents before uploading.",
          });
      const title =
        String(request.body?.title ?? file.originalname.replace(/\.pdf$/i, ""))
          .trim()
          .slice(0, 240) || "Untitled paper";
      const authors = cleanStrings(request.body?.authors, 30, 120);
      const tags = cleanStrings(request.body?.tags, 20, 50);
      const abstract = String(request.body?.abstract ?? "")
        .trim()
        .slice(0, 5000);
      const year = request.body?.year ? Number(request.body.year) : undefined;
      if (
        year !== undefined &&
        (!Number.isInteger(year) || year < 1000 || year > 3000)
      )
        return response
          .status(400)
          .json({ error: "Enter a valid publication year." });
      await mkdir(uploadDir, { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(targetPath, file.buffer, { flag: "wx" });
      await ensureCollection();

      const vectors = await embeddings.embedDocuments(
        chunks.map((chunk) => chunk.pageContent),
      );
      for (let offset = 0; offset < chunks.length; offset += 64) {
        const batch = chunks.slice(offset, offset + 64).map((chunk, index) => {
          const chunkIndex = offset + index;
          return {
            id: randomUUID(),
            vector: vectors[chunkIndex],
            payload: {
              content: chunk.pageContent,
              ownerId: userId,
              paperId: String(paperId),
              title,
              page: Number(
                chunk.metadata.loc?.pageNumber ??
                  chunk.metadata.page ??
                  chunkIndex + 1,
              ),
            } satisfies PaperPayload,
          };
        });
        await qdrant.upsert(collection, { wait: true, points: batch });
      }

      const uploader = await User.findById(userId).select("name");
      const paper = await Paper.create({
        _id: paperId,
        ownerId: userId,
        uploaderName: uploader?.name ?? "Research Desk community",
        hasPdf: true,
        title,
        originalName: file.originalname,
        authors,
        abstract,
        tags,
        year,
        pageCount: pages.length,
        chunkCount: chunks.length,
        fileSize: file.size,
        storageName,
      });
      response.status(201).json(paperView(paper.toObject()));
    } catch (error) {
      console.error("Paper ingestion failed:", error);
      await deletePaperVectors(userId, String(paperId)).catch((cleanupError) =>
        console.error("Vector cleanup failed:", cleanupError),
      );
      await unlink(targetPath).catch(() => undefined);
      response
        .status(503)
        .json({
          error:
            "Paper ingestion failed. Check MongoDB, Qdrant, and local model availability, then retry.",
        });
    }
  },
);

app.get("/api/papers/:paperId/pdf", async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.paperId))
    return response.status(400).json({ error: "Invalid paper id." });
  const paper = await Paper.findById(request.params.paperId);
  if (!paper) return response.status(404).json({ error: "Paper not found." });
  if (!paper.hasPdf || !paper.storageName)
    return response
      .status(404)
      .json({
        error:
          "The original PDF is unavailable; open the extracted-text reader instead.",
      });
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(paper.originalName)}`,
  );
  createReadStream(path.join(uploadDir, paper.storageName))
    .on("error", () => response.sendStatus(404))
    .pipe(response);
});

app.get("/api/papers/:paperId/text", async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.paperId))
    return response.status(400).json({ error: "Invalid paper id." });
  const paperId = String(request.params.paperId);
  const paper = await Paper.findById(request.params.paperId).lean();
  if (!paper) return response.status(404).json({ error: "Paper not found." });
  try {
    await ensurePublicCatalog();
    let offset: string | number | Record<string, unknown> | undefined;
    const passages: Array<{ page: number; content: string }> = [];
    do {
      const result = await qdrant.scroll(collection, {
        offset,
        limit: 256,
        with_payload: ["content", "metadata", "page"],
        with_vector: false,
        filter: { must: [{ key: "paperId", match: { value: paperId } }] },
      });
      for (const point of result.points) {
        const payload = point.payload as unknown as PaperPayload;
        passages.push({
          page: Number(
            payload.page ??
              payload.metadata?.loc?.pageNumber ??
              payload.metadata?.page ??
              1,
          ),
          content: payload.content ?? "",
        });
      }
      offset = (result.next_page_offset ?? undefined) as typeof offset;
    } while (offset !== undefined);
    passages.sort((a, b) => a.page - b.page);
    response.json({ passages });
  } catch (error) {
    console.error("Paper text retrieval failed:", error);
    response
      .status(503)
      .json({ error: "Could not load the extracted paper text." });
  }
});

app.delete("/api/papers/:paperId", auth, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.paperId))
    return response.status(400).json({ error: "Invalid paper id." });
  const userId = (request as AuthRequest).userId;
  const paper = await Paper.findOne({
    _id: request.params.paperId,
    ownerId: userId,
  });
  if (!paper) return response.status(404).json({ error: "Paper not found." });
  try {
    await deletePaperVectors(userId, String(paper._id));
    await unlink(path.join(uploadDir, paper.storageName)).catch(
      () => undefined,
    );
    await paper.deleteOne();
    response.json({ ok: true });
  } catch (error) {
    console.error(error);
    response
      .status(503)
      .json({ error: "Could not remove the paper from the library." });
  }
});

app.post("/api/chat", async (request, response) => {
  const question = String(request.body?.question ?? "")
    .trim()
    .slice(0, 4000);
  if (!question)
    return response.status(400).json({ error: "Question is required." });
  try {
    await ensureCollection();
    await ensurePublicCatalog();
    const queryVector = await embeddings.embedQuery(question);
    const result = await qdrant.query(collection, {
      query: queryVector,
      limit: 18,
      with_payload: true,
    });
    if (!result.points.length)
      return response
        .status(400)
        .json({ error: "The research catalog has no indexed papers yet." });
    const citations: Citation[] = [];
    const context = result.points
      .map((point, index) => {
        const payload = point.payload as unknown as PaperPayload;
        const citation = {
          reference: `[${index + 1}]`,
          paperId: payload.paperId ?? "",
          title: payload.title ?? payload.metadata?.source ?? "Research paper",
          page: Number(
            payload.page ??
              payload.metadata?.loc?.pageNumber ??
              payload.metadata?.page ??
              1,
          ),
          hasPdf: Boolean(payload.paperId && !payload.legacy),
        };
        citations.push(citation);
        return `${citation.reference} ${citation.title}, page ${citation.page}:\n${payload.content ?? ""}`;
      })
      .join("\n\n");
    const llm = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
      temperature: 0.1,
    });
    const resultMessage = await llm.invoke([
      new SystemMessage(
        "You are a careful scholarly search assistant. Answer from the supplied excerpts retrieved across the entire public research catalog. Explain uncertainty and gaps explicitly. Write polished Markdown. Cite claims with the exact reference labels supplied, such as [1] or [2]; do not fabricate references.",
      ),
      new HumanMessage(
        `Question: ${question}\n\nRetrieved excerpts from across the public research catalog:\n${context}`,
      ),
    ]);
    response.json({ answer: String(resultMessage.content), citations });
  } catch (error) {
    console.error("RAG query failed:", error);
    response
      .status(503)
      .json({
        error:
          "Could not search your library. Check Qdrant, Groq configuration, and the local embedding model.",
      });
  }
});

async function start() {
  if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET)
    throw new Error("JWT_SECRET is required in production.");
  await mkdir(uploadDir, { recursive: true });
  await mongoose.connect(
    process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/research-desk",
  );
  app.listen(port, () =>
    console.log(`Research Desk API listening on http://localhost:${port}`),
  );
}

start().catch((error) => {
  console.error("Could not start Research Desk API:", error);
  process.exit(1);
});
