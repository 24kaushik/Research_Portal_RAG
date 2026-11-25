import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

type User = {
  id: string;
  name: string;
  email: string;
  institution: string;
  bio: string;
  researchInterests: string[];
};
type Paper = {
  id: string;
  title: string;
  originalName: string;
  authors: string[];
  abstract: string;
  tags: string[];
  year?: number;
  pageCount: number;
  chunkCount: number;
  fileSize: number;
  hasPdf: boolean;
  uploaderName: string;
  createdAt: string;
};
type Citation = {
  reference: string;
  paperId: string;
  title: string;
  page: number;
  hasPdf: boolean;
};
type Message = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
};
type CatalogResult = {
  papers: Paper[];
  total: number;
  page: number;
  pages: number;
  limit: number;
};
type Session = { token: string; user: User };
type Passage = { page: number; content: string };
const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

async function request<T>(
  route: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${route}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "The request could not be completed.");
  }
  return response.json() as Promise<T>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem("research-desk-token") ?? "",
  );
  const [user, setUser] = useState<User | null>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("research-desk-user") ?? "null",
      ) as User | null;
    } catch {
      return null;
    }
  });
  const [tab, setTab] = useState<"discover" | "chat" | "contribute">(
    "discover",
  );
  const [papers, setPapers] = useState<Paper[]>([]);
  const [mine, setMine] = useState<Paper[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [author, setAuthor] = useState("");
  const [year, setYear] = useState("");
  const [sort, setSort] = useState("newest");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"auth" | "profile" | "upload" | null>(
    null,
  );
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [route, setRoute] = useState(window.location.pathname);
  const [paperDetail, setPaperDetail] = useState<Paper | null>(null);
  const [passages, setPassages] = useState<Passage[]>([]);
  const [readerLoading, setReaderLoading] = useState(true);
  const [pdfFailed, setPdfFailed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const viewerId = route.match(/^\/paper\/([a-f\d]{24})$/i)?.[1];

  useEffect(() => {
    const onRoute = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", onRoute);
    return () => window.removeEventListener("popstate", onRoute);
  }, []);

  useEffect(() => {
    if (!token) return;
    request<User>("/auth/me", {}, token)
      .then((profile) => {
        setUser(profile);
        localStorage.setItem("research-desk-user", JSON.stringify(profile));
      })
      .catch(() => signOut());
  }, [token]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        q: query,
        author,
        sort,
        page: String(page),
        limit: "18",
      });
      if (year) params.set("year", year);
      setLoadingCatalog(true);
      request<CatalogResult>(`/papers?${params}`)
        .then((result) => {
          setPapers(result.papers);
          setTotal(result.total);
        })
        .catch((error: unknown) =>
          setNotice(
            error instanceof Error ? error.message : "Could not load catalog.",
          ),
        )
        .finally(() => setLoadingCatalog(false));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query, author, year, sort, page]);

  useEffect(() => {
    if (!token || !user || tab !== "contribute") return;
    request<CatalogResult>("/my/papers?limit=60", {}, token)
      .then((result) => setMine(result.papers))
      .catch((error: unknown) =>
        setNotice(
          error instanceof Error
            ? error.message
            : "Could not load your submissions.",
        ),
      );
  }, [token, user, tab]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isThinking]);

  useEffect(() => {
    if (!viewerId) return;
    request<Paper>(`/papers/${viewerId}`)
      .then(async (paper) => {
        setPaperDetail(paper);
        if (!paper.hasPdf) {
          const text = await request<{ passages: Passage[] }>(
            `/papers/${viewerId}/text`,
          );
          setPassages(text.passages);
        }
      })
      .catch((error: unknown) =>
        setNotice(
          error instanceof Error ? error.message : "Could not open this paper.",
        ),
      )
      .finally(() => setReaderLoading(false));
  }, [viewerId]);

  function navigate(path: string) {
    window.history.pushState({}, "", path);
    setRoute(path);
    window.scrollTo(0, 0);
  }

  function signOut() {
    localStorage.removeItem("research-desk-token");
    localStorage.removeItem("research-desk-user");
    setToken("");
    setUser(null);
    setMine([]);
  }

  function acceptSession(session: Session) {
    localStorage.setItem("research-desk-token", session.token);
    localStorage.setItem("research-desk-user", JSON.stringify(session.user));
    setToken(session.token);
    setUser(session.user);
    setModal(null);
    setNotice(`Welcome, ${session.user.name}.`);
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = Object.fromEntries(
      new FormData(event.currentTarget).entries(),
    );
    try {
      const session = await request<Session>(
        authMode === "register" ? "/auth/register" : "/auth/login",
        { method: "POST", body: JSON.stringify(payload) },
      );
      acceptSession(session);
      setTab("discover");
    } catch (error: unknown) {
      setNotice(
        error instanceof Error ? error.message : "Could not authenticate.",
      );
    }
  }

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const data = new FormData(event.currentTarget);
    const payload = {
      name: data.get("name"),
      email: data.get("email"),
      institution: data.get("institution"),
      bio: data.get("bio"),
      researchInterests: String(data.get("researchInterests") ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };
    try {
      const profile = await request<User>(
        "/profile",
        { method: "PATCH", body: JSON.stringify(payload) },
        token,
      );
      setUser(profile);
      localStorage.setItem("research-desk-user", JSON.stringify(profile));
      setModal(null);
      setNotice("Profile saved.");
    } catch (error: unknown) {
      setNotice(
        error instanceof Error ? error.message : "Could not save your profile.",
      );
    }
  }

  async function submitPaper(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !fileInput.current?.files?.[0]) {
      setNotice("Sign in and choose a PDF before uploading.");
      return;
    }
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("file", fileInput.current.files[0]);
    setIsUploading(true);
    setNotice(
      "Extracting the paper, creating embeddings, and adding it to the shared catalog...",
    );
    try {
      const paper = await request<Paper>(
        "/papers",
        { method: "POST", body: form },
        token,
      );
      setModal(null);
      setQuery("");
      setAuthor("");
      setYear("");
      setPage(1);
      setTab("discover");
      formElement.reset();
      setNotice(`“${paper.title}” is indexed and available to everyone.`);
    } catch (error: unknown) {
      setNotice(
        error instanceof Error ? error.message : "Paper upload failed.",
      );
    } finally {
      setIsUploading(false);
    }
  }

  async function deletePaper(paper: Paper) {
    if (
      !token ||
      !window.confirm(
        `Remove “${paper.title}” and its indexed content from the public catalog?`,
      )
    )
      return;
    try {
      await request(`/papers/${paper.id}`, { method: "DELETE" }, token);
      setMine((current) => current.filter((entry) => entry.id !== paper.id));
      setNotice("Paper removed from the catalog.");
    } catch (error: unknown) {
      setNotice(
        error instanceof Error ? error.message : "Could not remove the paper.",
      );
    }
  }

  async function askLibrary(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || isThinking) return;
    setMessages((items) => [...items, { role: "user", content: text }]);
    setQuestion("");
    setIsThinking(true);
    try {
      const answer = await request<{ answer: string; citations: Citation[] }>(
        "/chat",
        { method: "POST", body: JSON.stringify({ question: text }) },
      );
      setMessages((items) => [
        ...items,
        {
          role: "assistant",
          content: answer.answer,
          citations: answer.citations,
        },
      ]);
    } catch (error: unknown) {
      setMessages((items) => [
        ...items,
        {
          role: "assistant",
          content:
            error instanceof Error
              ? error.message
              : "Could not search the catalog.",
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  }

  function requestContribution() {
    if (!token) {
      setAuthMode("register");
      setModal("auth");
      return;
    }
    setModal("upload");
  }

  if (viewerId)
    return (
      <PaperReader
        paper={paperDetail}
        passages={passages}
        loading={readerLoading}
        pdfFailed={pdfFailed}
        setPdfFailed={setPdfFailed}
        onBack={() => navigate("/")}
      />
    );

  return (
    <div className="portal">
      <header className="site-header">
        <button
          className="wordmark"
          onClick={() => {
            setTab("discover");
            navigate("/");
          }}
        >
          <span className="wordmark-icon">R</span>
          <span>
            RESEARCH <b>COMMONS</b>
          </span>
        </button>
        <nav className="main-nav" aria-label="Main navigation">
          <button
            className={tab === "discover" ? "selected" : ""}
            onClick={() => setTab("discover")}
          >
            Discover
          </button>
          <button
            className={tab === "chat" ? "selected" : ""}
            onClick={() => setTab("chat")}
          >
            AI research chat
          </button>
          {user && (
            <button
              className={tab === "contribute" ? "selected" : ""}
              onClick={() => setTab("contribute")}
            >
              My contributions
            </button>
          )}
        </nav>
        <div className="header-actions">
          {user ? (
            <>
              <button
                className="contribute-button"
                onClick={requestContribution}
              >
                ＋ Contribute paper
              </button>
              <button
                className="account-chip"
                onClick={() => setModal("profile")}
              >
                <span className="user-initial">
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                <span>{user.name.split(" ")[0]}</span>
              </button>
            </>
          ) : (
            <>
              <button
                className="text-action"
                onClick={() => {
                  setAuthMode("login");
                  setModal("auth");
                }}
              >
                Sign in
              </button>
              <button
                className="contribute-button"
                onClick={requestContribution}
              >
                ＋ Contribute paper
              </button>
            </>
          )}
        </div>
      </header>

      {tab === "discover" && (
        <main className="discover-page">
          <section className="catalog-hero">
            <div className="hero-copy">
              <span className="eyebrow">OPEN RESEARCH · SHARED KNOWLEDGE</span>
              <h1>
                Find the work
                <br />
                that moves yours forward.
              </h1>
              <p>
                Search a growing community catalog of research papers. Read the
                source, explore the connections, and ask questions across the
                literature.
              </p>
            </div>
            <div className="catalog-stat">
              <strong>{total.toLocaleString()}</strong>
              <span>papers in the catalog</span>
              <i>PUBLIC INDEX / UPDATED AS PAPERS ARE ADDED</i>
            </div>
          </section>
          <section className="search-section" aria-label="Search papers">
            <form
              className="search-box"
              onSubmit={(event) => {
                event.preventDefault();
                setPage(1);
              }}
            >
              <span className="search-glyph">⌕</span>
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search titles, authors, abstracts, or topics"
                aria-label="Search the paper catalog"
              />
              <kbd>↵</kbd>
            </form>
            <div className="filter-row">
              <label>
                AUTHOR
                <input
                  value={author}
                  onChange={(event) => {
                    setAuthor(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Any author"
                />
              </label>
              <label>
                YEAR
                <input
                  value={year}
                  onChange={(event) => {
                    setYear(event.target.value.replace(/\D/g, "").slice(0, 4));
                    setPage(1);
                  }}
                  placeholder="Any year"
                  inputMode="numeric"
                />
              </label>
              <label>
                SORT
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="newest">Recently added</option>
                  <option value="oldest">Oldest added</option>
                  <option value="title">Title A–Z</option>
                </select>
              </label>
              <span className="result-count">
                {loadingCatalog
                  ? "Searching…"
                  : `${total.toLocaleString()} results`}
              </span>
            </div>
          </section>
          <section className="results-section">
            <div className="results-heading">
              <h2>{query ? `Results for “${query}”` : "Research papers"}</h2>
              <span>PUBLIC CATALOG</span>
            </div>
            {loadingCatalog && !papers.length ? (
              <div className="catalog-state">Loading the research index…</div>
            ) : papers.length ? (
              <div className="paper-grid">
                {papers.map((paper, index) => (
                  <PaperCard key={paper.id} paper={paper} index={index} />
                ))}
              </div>
            ) : (
              <div className="catalog-state">
                <strong>No papers found.</strong>
                <span>Try a broader title, author, or topic search.</span>
              </div>
            )}
            {total > 18 && (
              <div className="pagination">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  ← Previous
                </button>
                <span>
                  Page {page} of {Math.ceil(total / 18)}
                </span>
                <button
                  disabled={page >= Math.ceil(total / 18)}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </section>
        </main>
      )}

      {tab === "chat" && (
        <main className="chat-page">
          <header className="chat-title">
            <div>
              <span className="eyebrow">RESEARCH COMMONS / AI</span>
              <h1>Ask across the literature.</h1>
              <p>
                Questions search the entire shared catalog, not just one paper.
              </p>
            </div>
            <span className="corpus-badge">
              <i></i> GLOBAL CORPUS · {total.toLocaleString()} PAPERS
            </span>
          </header>
          <section className="global-chat">
            <div className="chat-transcript">
              {!messages.length && (
                <div className="chat-welcome">
                  <span className="assistant-seal">✳</span>
                  <h2>What would you like to know?</h2>
                  <p>
                    Explore findings, compare methods, or trace an idea across
                    the collection. Source links take you back to the paper.
                  </p>
                  <div className="prompt-suggestions">
                    {[
                      "What themes appear across retrieval-augmented generation papers?",
                      "Compare the main approaches to long-context evaluation.",
                      "What limitations are repeatedly reported?",
                    ].map((prompt) => (
                      <button key={prompt} onClick={() => setQuestion(prompt)}>
                        {prompt}
                        <span>↗</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((message, index) => (
                <article
                  className={`chat-message ${message.role}`}
                  key={`${message.role}-${index}`}
                >
                  <div className="chat-speaker">
                    {message.role === "assistant"
                      ? "RESEARCH COMMONS AI"
                      : "YOU"}
                  </div>
                  {message.role === "assistant" ? (
                    <div className="markdown-body">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          a: ({ href, children }) => (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {linkCitationMarkers(
                          message.content,
                          message.citations ?? [],
                        )}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p>{message.content}</p>
                  )}
                  {message.citations?.length ? (
                    <div className="citation-list">
                      <span className="citation-heading">
                        SOURCES IN THE CATALOG
                      </span>
                      {message.citations.map((citation) => (
                        <a
                          key={citation.reference}
                          className="source-link"
                          href={`/paper/${citation.paperId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <b>{citation.reference}</b>
                          <span>{citation.title}</span>
                          <small>
                            p. {citation.page} ·{" "}
                            {citation.hasPdf
                              ? "Read paper ↗"
                              : "Extracted text ↗"}
                          </small>
                        </a>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
              {isThinking && (
                <div className="chat-message assistant">
                  <div className="chat-speaker">
                    SEARCHING THE SHARED CATALOG
                  </div>
                  <div className="thinking">
                    <i></i>
                    <i></i>
                    <i></i>
                  </div>
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <form className="global-composer" onSubmit={askLibrary}>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={2}
                placeholder="Ask a question across all research papers…"
                disabled={isThinking}
              />
              <div className="composer-tools">
                <span>Responses cite catalog sources · Ctrl / ⌘ + Enter</span>
                <button
                  type="submit"
                  disabled={isThinking || !question.trim()}
                  aria-label="Send question"
                >
                  ↑
                </button>
              </div>
            </form>
          </section>
        </main>
      )}

      {tab === "contribute" && user && (
        <main className="contributions-page">
          <div className="section-title">
            <div>
              <span className="eyebrow">COMMUNITY CONTRIBUTIONS</span>
              <h1>Your submissions.</h1>
              <p>Research you have added to the shared public catalog.</p>
            </div>
            <button className="contribute-button" onClick={requestContribution}>
              ＋ Add a paper
            </button>
          </div>
          {mine.length ? (
            <div className="paper-grid">
              {mine.map((paper, index) => (
                <PaperCard
                  key={paper.id}
                  paper={paper}
                  index={index}
                  onDelete={() => deletePaper(paper)}
                />
              ))}
            </div>
          ) : (
            <div className="catalog-state">
              <strong>No submissions yet.</strong>
              <span>
                Contributed papers become searchable and readable to everyone.
              </span>
              <button
                className="contribute-button"
                onClick={requestContribution}
              >
                ＋ Contribute your first paper
              </button>
            </div>
          )}
        </main>
      )}

      <footer className="site-footer">
        <span>RESEARCH COMMONS</span>
        <span>Shared scholarly discovery · Source-linked AI</span>
        <button onClick={requestContribution}>Contribute research</button>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {modal === "auth" && (
        <Modal
          title={
            authMode === "login" ? "Welcome back" : "Join Research Commons"
          }
          close={() => setModal(null)}
        >
          <form className="portal-form" onSubmit={submitAuth}>
            {authMode === "register" && (
              <label>
                Your name
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={80}
                  autoComplete="name"
                  placeholder="Full name"
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@university.edu"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                minLength={8}
                required
                autoComplete={
                  authMode === "register" ? "new-password" : "current-password"
                }
                placeholder="At least 8 characters"
              />
            </label>
            <button className="primary-button">
              {authMode === "login" ? "Sign in" : "Create account"}
              <span>→</span>
            </button>
            <p className="auth-switch">
              {authMode === "login"
                ? "New to Research Commons?"
                : "Already have an account?"}{" "}
              <button
                type="button"
                onClick={() =>
                  setAuthMode(authMode === "login" ? "register" : "login")
                }
              >
                {authMode === "login" ? "Create account" : "Sign in"}
              </button>
            </p>
          </form>
        </Modal>
      )}
      {modal === "profile" && user && (
        <Modal title="Your researcher profile" close={() => setModal(null)}>
          <form className="portal-form" onSubmit={submitProfile}>
            <label>
              Full name
              <input name="name" defaultValue={user.name} required />
            </label>
            <label>
              Email
              <input
                name="email"
                type="email"
                defaultValue={user.email}
                required
              />
            </label>
            <label>
              Institution
              <input
                name="institution"
                defaultValue={user.institution}
                placeholder="University or organization"
              />
            </label>
            <label>
              Research interests
              <input
                name="researchInterests"
                defaultValue={user.researchInterests.join(", ")}
                placeholder="NLP, neuroscience, climate"
              />
            </label>
            <label>
              Bio
              <textarea name="bio" defaultValue={user.bio} rows={3} />
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={signOut}
              >
                Sign out
              </button>
              <button className="primary-button">Save profile</button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "upload" && user && (
        <Modal
          title="Contribute a research paper"
          close={() => !isUploading && setModal(null)}
        >
          <form className="portal-form" onSubmit={submitPaper}>
            <label className="file-drop">
              <span className="file-mark">PDF</span>
              <strong>Select the paper PDF</strong>
              <small>
                Up to 40 MB · the paper and extracted searchable text will be
                public
              </small>
              <input
                ref={fileInput}
                name="file"
                type="file"
                accept="application/pdf,.pdf"
                required
              />
            </label>
            <label>
              Title
              <input
                name="title"
                placeholder="Defaults to the PDF filename"
                maxLength={240}
              />
            </label>
            <div className="form-grid">
              <label>
                Authors
                <input
                  name="authors"
                  placeholder="Comma-separated author names"
                />
              </label>
              <label>
                Publication year
                <input
                  name="year"
                  type="number"
                  min="1000"
                  max="3000"
                  placeholder="2025"
                />
              </label>
            </div>
            <label>
              Topics
              <input name="tags" placeholder="Comma-separated topics" />
            </label>
            <label>
              Abstract
              <textarea
                name="abstract"
                rows={4}
                maxLength={5000}
                placeholder="Add an abstract to improve discovery"
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={isUploading}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={isUploading}>
                {isUploading ? "Embedding and indexing…" : "Publish to catalog"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function linkCitationMarkers(answer: string, citations: Citation[]) {
  return answer.replace(
    /\[(\d+)\]|【(\d+)】/g,
    (marker, square: string | undefined, fullwidth: string | undefined) => {
      const reference = `[${square ?? fullwidth}]`;
      const citation = citations.find((item) => item.reference === reference);
      return citation ? `[${reference}](/paper/${citation.paperId})` : marker;
    },
  );
}

function PaperCard({
  paper,
  index,
  onDelete,
}: {
  paper: Paper;
  index: number;
  onDelete?: () => void;
}) {
  return (
    <article className="paper-card">
      <div className="paper-card-top">
        <span className={`paper-glyph tint-${index % 5}`}>PDF</span>
        <span className="paper-date">{paper.year ?? "YEAR NOT LISTED"}</span>
        {onDelete && (
          <button
            className="delete-paper"
            title="Remove your submission"
            onClick={onDelete}
          >
            ×
          </button>
        )}
      </div>
      <a
        className="paper-title"
        href={`/paper/${paper.id}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {paper.title}
      </a>
      <p className="paper-authors">
        {paper.authors.length ? paper.authors.join(", ") : paper.uploaderName}
      </p>
      <p className="paper-abstract">
        {paper.abstract ||
          `${paper.chunkCount} searchable passages · ${paper.pageCount} pages of ${paper.hasPdf ? "full paper" : "extracted legacy text"}.`}
      </p>
      <div className="paper-tags">
        {paper.tags.slice(0, 3).map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <div className="paper-card-bottom">
        <span>
          {paper.pageCount} pages
          {paper.fileSize ? ` · ${formatBytes(paper.fileSize)}` : ""}
        </span>
        <a
          href={`/paper/${paper.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {paper.hasPdf ? "Read paper ↗" : "Read extracted text ↗"}
        </a>
      </div>
    </article>
  );
}

function PaperReader({
  paper,
  passages,
  loading,
  pdfFailed,
  setPdfFailed,
  onBack,
}: {
  paper: Paper | null;
  passages: Passage[];
  loading: boolean;
  pdfFailed: boolean;
  setPdfFailed: (value: boolean) => void;
  onBack: () => void;
}) {
  return (
    <main className="reader">
      <header className="reader-bar">
        <button className="wordmark" onClick={onBack}>
          <span className="wordmark-icon">R</span>
          <span>
            RESEARCH <b>COMMONS</b>
          </span>
        </button>
        <span className="reader-location">PUBLIC PAPER READER</span>
        <button className="secondary-button" onClick={onBack}>
          ← Back to catalog
        </button>
      </header>
      {loading ? (
        <div className="reader-state">Loading paper…</div>
      ) : paper ? (
        <>
          <section className="reader-heading">
            <span className="eyebrow">
              {paper.year ? `${paper.year} · ` : ""}
              {paper.pageCount} PAGES · CONTRIBUTED BY{" "}
              {paper.uploaderName.toUpperCase()}
            </span>
            <h1>{paper.title}</h1>
            {paper.authors.length > 0 && <p>{paper.authors.join(", ")}</p>}
            {paper.abstract && (
              <div className="reader-abstract">{paper.abstract}</div>
            )}
          </section>
          {paper.hasPdf && !pdfFailed ? (
            <iframe
              className="paper-pdf"
              title={paper.title}
              src={`${API}/papers/${paper.id}/pdf`}
              onError={() => setPdfFailed(true)}
            />
          ) : (
            <article className="extracted-reader">
              {!paper.hasPdf && (
                <div className="reader-note">
                  Original PDF was not retained for this older catalog entry.
                  This reader displays the extracted passages available from the
                  index.
                </div>
              )}
              {passages.map((passage, index) => (
                <section
                  key={`${passage.page}-${index}`}
                  className="extracted-page"
                >
                  <div>PAGE {passage.page}</div>
                  <p>{passage.content}</p>
                </section>
              ))}
            </article>
          )}
        </>
      ) : (
        <div className="reader-state">
          Paper not found in the public catalog.
        </div>
      )}
    </main>
  );
}

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">RESEARCH COMMONS</span>
            <h2>{title}</h2>
          </div>
          <button
            className="modal-close"
            onClick={close}
            aria-label="Close dialog"
          >
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export default App;
