import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Film, Image as ImageIcon, Search, X } from 'lucide-react';

interface VideoMetadata {
  duration?: string | null;
  actresses?: string[];
  studio?: string | null;
  genres?: string[];
  date?: string | null;
  thumbnailUrl?: string | null;
  description?: string | null;
}

interface VideoRecord {
  id: string;
  code: string;
  title: string;
  description?: string | null;
  metadata: VideoMetadata;
}

interface ScreenshotRecord {
  id: string;
  code: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  url: string;
}

const PAGE_SIZE = 24;

function getThumbnailUrl(rawUrl?: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('/api/proxy/image')) return trimmed;
  return `/api/proxy/image?url=${encodeURIComponent(trimmed)}`;
}

export function getHighResCoverUrl(code?: string): string | null {
  if (!code) return null;
  const match = code.trim().toLowerCase().match(/^([a-z]+)[-_]?0*([0-9]+)$/i);
  if (!match) return null;
  const dmmId = match[1] + match[2].padStart(5, '0');
  return `https://pics.dmm.co.jp/digital/video/${dmmId}/${dmmId}pl.jpg`;
}

function VideoThumbnail({
  src,
  highResSrc,
  alt,
  className,
  fallbackSize = 10,
}: {
  src?: string | null;
  highResSrc?: string | null;
  alt: string;
  className?: string;
  fallbackSize?: number;
}) {
  const [useFallback, setUseFallback] = useState(false);
  const [error, setError] = useState(false);

  // If high-res cover fails, seamlessly fall back to scene screenshot
  const targetUrl = !useFallback && highResSrc ? highResSrc : src;
  const resolvedUrl = targetUrl ? getThumbnailUrl(targetUrl) : '';

  if (!resolvedUrl || error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-900 text-slate-700">
        <Film className={`h-${fallbackSize} w-${fallbackSize}`} />
      </div>
    );
  }

  return (
    <img
      src={resolvedUrl}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        if (!useFallback && highResSrc && src && highResSrc !== src) {
          setUseFallback(true);
        } else {
          setError(true);
        }
      }}
      className={className || 'h-full w-full object-cover'}
    />
  );
}

function CatalogHeader({
  searchInput,
  setSearchInput,
  submitSearch,
  clearSearch,
  onHomeClick,
}: {
  searchInput: string;
  setSearchInput: (value: string) => void;
  submitSearch: (event: React.FormEvent) => void;
  clearSearch: () => void;
  onHomeClick?: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-4 sm:px-6">
        <a
          href="/"
          onClick={(e) => {
            if (onHomeClick) {
              e.preventDefault();
              onHomeClick();
            }
          }}
          className="flex shrink-0 items-center gap-3"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold">PJ</div>
          <div className="hidden sm:block">
            <div className="font-semibold">PiratecultJAV</div>
            <div className="text-[11px] text-slate-500">Indexed video catalog</div>
          </div>
        </a>

        <form onSubmit={submitSearch} className="relative ml-auto w-full max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by code, title or description..."
            className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2.5 pl-10 pr-10 text-sm outline-none focus:border-indigo-500"
            aria-label="Search indexed videos"
          />
          {searchInput && (
            <button type="button" onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200" aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          )}
        </form>
      </div>
    </header>
  );
}

function VideoDetails({
  id,
  initialVideo,
  onBack,
}: {
  id: string;
  initialVideo?: VideoRecord | null;
  onBack: () => void;
}) {
  const [video, setVideo] = useState<VideoRecord | null>(initialVideo || null);
  const [botUrl, setBotUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialVideo);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<'cover' | 'scene'>('cover');
  const [screenshots, setScreenshots] = useState<ScreenshotRecord[]>([]);
  const [screenshotsLoading, setScreenshotsLoading] = useState(false);
  const [selectedScreenshot, setSelectedScreenshot] = useState<ScreenshotRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!initialVideo) {
      setLoading(true);
    }

    fetch('/api/videos/' + encodeURIComponent(id))
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load video');
        return data;
      })
      .then(data => {
        if (cancelled) return;
        setVideo(data.video || null);
        setBotUrl(data.botUrl || null);
      })
      .catch(err => {
        if (!cancelled && !initialVideo) {
          setError(err instanceof Error ? err.message : 'Unable to load video');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [id, initialVideo]);

  useEffect(() => {
    if (!video?.code) return;
    let cancelled = false;
    setScreenshotsLoading(true);
    fetch('/api/screenshots/' + encodeURIComponent(video.code))
      .then(async response => {
        if (!response.ok) throw new Error('Could not load screenshots');
        return response.json();
      })
      .then(data => {
        if (!cancelled) setScreenshots(Array.isArray(data.images) ? data.images : []);
      })
      .catch(() => {
        if (!cancelled) setScreenshots([]);
      })
      .finally(() => {
        if (!cancelled) setScreenshotsLoading(false);
      });
    return () => { cancelled = true; };
  }, [video?.code]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
          <div className="h-8 w-28 animate-pulse rounded bg-slate-800" />
          <div className="mt-8 grid gap-8 md:grid-cols-[480px_1fr]">
            <div className="aspect-video animate-pulse rounded-2xl bg-slate-900" />
            <div className="space-y-4"><div className="h-8 animate-pulse rounded bg-slate-900" /><div className="h-24 animate-pulse rounded bg-slate-900" /></div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !video) {
    return (
      <div className="min-h-screen bg-slate-950 px-4 py-12 text-slate-100">
        <div className="mx-auto max-w-xl rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center">
          <Film className="mx-auto mb-4 h-10 w-10 text-slate-600" />
          <h1 className="text-xl font-semibold">Video not found</h1>
          <p className="mt-2 text-sm text-slate-500">{error || 'This indexed post is unavailable.'}</p>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium hover:bg-indigo-500"
          >
            <ArrowLeft className="h-4 w-4" /> Back to catalog
          </a>
        </div>
      </div>
    );
  }

  const metadata = video.metadata || {};
  const thumbnail = metadata.thumbnailUrl || '';
  const hdCover = getHighResCoverUrl(video.code);
  const actresses = metadata.actresses || [];
  const genres = metadata.genres || [];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Back to catalog
        </a>

        <main className="mt-7 grid gap-8 md:grid-cols-[480px_1fr]">
          <div className="space-y-3">
            <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
              <div className="relative aspect-video bg-slate-950">
                <VideoThumbnail
                  src={thumbnail}
                  highResSrc={viewMode === 'cover' ? hdCover : undefined}
                  alt={video.title || video.code}
                  fallbackSize={14}
                />
                <div className="absolute right-2.5 top-2.5 rounded-md bg-slate-950/85 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-emerald-400">
                  {viewMode === 'cover' && hdCover ? 'HD JACKET' : 'SCENE CAPTURE'}
                </div>
              </div>
            </div>

            {hdCover && thumbnail && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setViewMode('cover')}
                  className={`flex-1 rounded-xl py-2 text-xs font-medium transition ${viewMode === 'cover' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/40' : 'border border-slate-800 bg-slate-900/80 text-slate-400 hover:text-white'}`}
                >
                  ✨ HD Cover (800x538)
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('scene')}
                  className={`flex-1 rounded-xl py-2 text-xs font-medium transition ${viewMode === 'scene' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/40' : 'border border-slate-800 bg-slate-900/80 text-slate-400 hover:text-white'}`}
                >
                  🎬 Scene Capture (16:9)
                </button>
              </div>
            )}
          </div>

          <section>
            <div className="inline-flex rounded-lg bg-slate-900 px-2.5 py-1 font-mono text-xs font-semibold text-indigo-300">{video.code}</div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">{video.title || video.code}</h1>

            <div className="mt-5 flex flex-wrap gap-2">
              {metadata.duration && <span className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-sm text-slate-300">Duration: {metadata.duration}</span>}
              {metadata.date && <span className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-sm text-slate-300">Release: {metadata.date}</span>}
              {metadata.studio && <span className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-sm text-slate-300">Studio: {metadata.studio}</span>}
            </div>

            {actresses.length > 0 && (
              <div className="mt-7">
                <h2 className="text-sm font-semibold text-slate-300">Actresses</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {actresses.map(name => <span key={name} className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-slate-400">{name}</span>)}
                </div>
              </div>
            )}

            {genres.length > 0 && (
              <div className="mt-6">
                <h2 className="text-sm font-semibold text-slate-300">Genres</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {genres.map(genre => <span key={genre} className="rounded-lg bg-indigo-950/60 px-3 py-1.5 text-xs text-indigo-300">{genre}</span>)}
                </div>
              </div>
            )}

            <div className="mt-8">
              {botUrl ? (
                <a href={botUrl} target="_blank" rel="noreferrer" className="inline-flex w-full items-center justify-center rounded-xl bg-indigo-600 px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/30 hover:bg-indigo-500 sm:w-auto">
                  Get Video on Telegram
                </a>
              ) : (
                <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-500">Telegram bot is currently unavailable.</p>
              )}
            </div>
          </section>
        </main>

        <section className="mt-10 border-t border-slate-800 pt-7" aria-labelledby="screenshots-heading">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 id="screenshots-heading" className="flex items-center gap-2 text-lg font-semibold">
                <ImageIcon className="h-5 w-5 text-indigo-400" /> Screenshots
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {screenshotsLoading ? 'Loading screenshots…' : screenshots.length ? `${screenshots.length} screenshot${screenshots.length === 1 ? '' : 's'}` : 'No screenshots have been indexed for this video yet.'}
              </p>
            </div>
          </div>

          {screenshots.length > 0 && (
            <div className="mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-3">
              {screenshots.map((screenshot, index) => (
                <button
                  key={screenshot.id}
                  type="button"
                  onClick={() => setSelectedScreenshot(screenshot)}
                  className="group relative w-[78vw] max-w-sm shrink-0 snap-start overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-left sm:w-80"
                  aria-label={`View screenshot ${index + 1} of ${screenshots.length}`}
                >
                  <img
                    src={screenshot.url}
                    alt={`${video.code} screenshot ${index + 1}`}
                    loading="lazy"
                    className="aspect-video w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                  />
                  <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-1 text-xs text-white">
                    {index + 1} / {screenshots.length}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {selectedScreenshot && (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 p-3 sm:p-8"
            role="dialog"
            aria-modal="true"
            aria-label="Screenshot viewer"
            onClick={() => setSelectedScreenshot(null)}
          >
            <button
              type="button"
              onClick={() => setSelectedScreenshot(null)}
              className="absolute right-3 top-3 z-10 rounded-full bg-slate-800/90 p-2.5 text-white hover:bg-slate-700"
              aria-label="Close screenshot viewer"
            >
              <X className="h-6 w-6" />
            </button>
            <img
              src={selectedScreenshot.url}
              alt={`${video.code} screenshot`}
              className="max-h-[90vh] max-w-full rounded-lg object-contain"
              onClick={event => event.stopPropagation()}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CatalogPage({
  navigate,
}: {
  navigate: (path: string, initialVideo?: VideoRecord) => void;
}) {

  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchVideos = useCallback(async (search: string, currentPage: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String((currentPage - 1) * PAGE_SIZE));
      if (search.trim()) params.set('q', search.trim());

      const response = await fetch('/api/videos?' + params.toString());
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load catalog');

      setVideos(data.videos || []);
      setTotal(Number(data.total || 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load catalog');
      setVideos([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchVideos(query, page); }, [fetchVideos, query, page]);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput('');
    setQuery('');
    setPage(1);
  };

  const goToPage = (next: number) => {
    const target = Math.min(Math.max(next, 1), totalPages);
    setPage(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <CatalogHeader
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        submitSearch={submitSearch}
        clearSearch={clearSearch}
        onHomeClick={() => navigate('/')}
      />

      <main className="mx-auto max-w-7xl px-4 py-7 sm:px-6">
        <div className="mb-7">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{query ? 'Search results' : 'Latest indexed posts'}</h1>
          <p className="mt-1 text-sm text-slate-500">{loading ? 'Loading catalog...' : String(total.toLocaleString()) + ' indexed posts'}{query ? ' for “' + query + '”' : ''}</p>
        </div>

        {error && <div className="mb-6 rounded-xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-300">{error}</div>}

        {loading ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
                <div className="aspect-video animate-pulse bg-slate-800" />
                <div className="space-y-2 p-3"><div className="h-4 animate-pulse rounded bg-slate-800" /><div className="h-3 w-2/3 animate-pulse rounded bg-slate-800" /></div>
              </div>
            ))}
          </div>
        ) : videos.length === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 text-center">
            <Film className="mb-3 h-8 w-8 text-slate-600" />
            <h2 className="font-medium text-slate-300">No indexed posts found</h2>
            <p className="mt-1 text-sm text-slate-500">{query ? 'Try another code or search term.' : 'There are no available indexed posts yet.'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {videos.map((video) => {
              const thumbnail = video.metadata?.thumbnailUrl || '';
              const hdCover = getHighResCoverUrl(video.code);
              const actresses = video.metadata?.actresses || [];
              return (
                <a
                  key={video.id}
                  href={'/video/' + encodeURIComponent(video.id)}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/video/' + encodeURIComponent(video.id), video);
                  }}
                  className="group block overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 transition hover:-translate-y-0.5 hover:border-slate-700"
                >
                  <div className="relative aspect-video overflow-hidden bg-slate-950">
                    <VideoThumbnail
                      src={thumbnail}
                      highResSrc={hdCover}
                      alt={video.title || video.code}
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      fallbackSize={10}
                    />
                    <div className="absolute left-2 top-2 rounded-md bg-slate-950/85 px-2 py-1 font-mono text-[11px] font-semibold text-indigo-300">{video.code}</div>
                  </div>
                  <div className="p-3">
                    <h2 className="line-clamp-2 text-sm font-medium leading-5 text-slate-200">{video.title || video.code}</h2>
                    {actresses.length > 0 && <p className="mt-1 line-clamp-1 text-xs text-slate-500">{actresses.join(', ')}</p>}
                    {video.metadata?.studio && <p className="mt-1 line-clamp-1 text-xs text-slate-500">Studio: {video.metadata.studio}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-slate-600">
                      {video.metadata?.duration && <span className="rounded bg-slate-800 px-1.5 py-0.5">{video.metadata.duration}</span>}
                      {video.metadata?.date && <span className="rounded bg-slate-800 px-1.5 py-0.5">{video.metadata.date}</span>}
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        )}

        {!loading && totalPages > 1 && (
          <nav className="mt-8 flex items-center justify-center gap-2" aria-label="Catalog pagination">
            <button onClick={() => goToPage(page - 1)} disabled={page <= 1} className="rounded-lg border border-slate-800 p-2 text-slate-400 hover:bg-slate-900 disabled:opacity-30" aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(5, totalPages) }).map((_, index) => {
                let pageNumber = index + 1;
                if (totalPages > 5) {
                  if (page <= 3) pageNumber = index + 1;
                  else if (page >= totalPages - 2) pageNumber = totalPages - 4 + index;
                  else pageNumber = page - 2 + index;
                }
                return <button key={pageNumber} onClick={() => goToPage(pageNumber)} className={pageNumber === page ? 'min-w-9 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white' : 'min-w-9 rounded-lg border border-slate-800 px-3 py-2 text-sm text-slate-400 hover:bg-slate-900'}>{pageNumber}</button>;
              })}
            </div>
            <button onClick={() => goToPage(page + 1)} disabled={page >= totalPages} className="rounded-lg border border-slate-800 p-2 text-slate-400 hover:bg-slate-900 disabled:opacity-30" aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
          </nav>
        )}

        {!loading && total > 0 && <p className="mt-4 text-center text-xs text-slate-600">Page {page} of {totalPages}</p>}
      </main>

      <footer className="border-t border-slate-900 py-8 text-center text-xs text-slate-600">PiratecultJAV · Public indexed catalog</footer>
    </div>
  );
}

export default function App() {
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const [activeVideo, setActiveVideo] = useState<VideoRecord | null>(null);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((path: string, initialVideo?: VideoRecord) => {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    if (initialVideo) {
      setActiveVideo(initialVideo);
    }
    setCurrentPath(path);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const detailMatch = currentPath.match(/^\/video\/([^/]+)\/?$/);
  if (detailMatch) {
    const videoId = decodeURIComponent(detailMatch[1]);
    const matchedInitial = String(activeVideo?.id) === String(videoId) ? activeVideo : null;
    return (
      <VideoDetails
        id={videoId}
        initialVideo={matchedInitial}
        onBack={() => navigate('/')}
      />
    );
  }

  return <CatalogPage navigate={navigate} />;
}

