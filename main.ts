import {
  defineExtension,
  confirm,
  type ContentSource,
  type ContentMetadata,
  type MovieMetadata,
  type EpisodeMetadata,
} from 'azot';

const API_BASE = 'https://api.tvoe.live';
const CDN_BASE = 'https://hls.cdn.tvoe.live';
const TOKEN_KEY = 'tvoe_token';
const PENDING_CODE_KEY = 'tvoe_pending_code';
const MAX_POLL_ATTEMPTS = 30;
const SERIAL_HINT_KEY = 'tvoe_serial_hint_shown';

const BASE_HEADERS: Record<string, string> = {
  'Origin': 'https://tvoe.live',
  'Referer': 'https://tvoe.live/',
};

interface VideoObject {
  _id: string;
  src: string;
  version?: number;
  thumbnail?: string;
  duration?: number;
  qualities?: string[];
  audio?: string[];
  subtitles?: string[];
  published?: boolean;
  nameForUser?: string;
}

interface MovieVideos {
  films?: VideoObject[];
  seasons?: VideoObject[][];
  trailers?: VideoObject[];
}

interface MovieResponse {
  _id: string;
  name: string;
  origName?: string;
  categoryAlias: 'films' | 'serials';
  videos: MovieVideos;
}

interface ActivateResponse {
  code?: number;
  isConfirmed?: boolean;
  QRUrl?: string;
  token?: string;
}

async function buildHlsUrl(src: string): Promise<string> {
  const candidates = [
    `${CDN_BASE}${src}/hls/0/master.m3u8`,
    `${CDN_BASE}${src}/master-0.m3u8`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return url;
    } catch {}
  }
  return candidates[0];
}

async function authenticate(): Promise<string> {
  const existing = localStorage.getItem(TOKEN_KEY);
  if (existing) return existing;

  let code = Number(localStorage.getItem(PENDING_CODE_KEY)) || null;

  if (!code) {
    const genRes = await fetch(`${API_BASE}/auth/activate?getNewCode=true`, {
      headers: BASE_HEADERS,
    });

    if (!genRes.ok) {
      throw new Error(`Не удалось получить код активации (${genRes.status})`);
    }

    const data = (await genRes.json()) as ActivateResponse;
    if (!data.code) throw new Error('Сервер не вернул код активации');
    code = data.code;
    localStorage.setItem(PENDING_CODE_KEY, String(code));
  }

  const message = `Перейди на https://tvoe.live → Профиль → Устройства → Подключить ТВ\n\nВведи код ${code} и нажми OK здесь.`;
  const confirmed = await confirm(message, { title: 'Вход в TVОЁ' });
  if (!confirmed) {
    localStorage.removeItem(PENDING_CODE_KEY);
    throw new Error('Авторизация отменена.');
  }

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const pollRes = await fetch(`${API_BASE}/auth/activate?code=${code}`, {
      headers: BASE_HEADERS,
    });

    if (!pollRes.ok) continue;

    const data = (await pollRes.json()) as ActivateResponse;

    if (data.token) {
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.removeItem(PENDING_CODE_KEY);
      return data.token;
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error('Время ожидания подтверждения истекло. Запусти снова.');
}

async function fetchMovie(alias: string, token: string): Promise<MovieResponse> {
  const res = await fetch(`${API_BASE}/movies/movie?alias=${alias}`, {
    headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new Error('Сессия истекла. Запусти снова для повторного входа.');
  }

  if (!res.ok) {
    throw new Error(`Ошибка получения данных о контенте (${res.status})`);
  }

  return res.json() as Promise<MovieResponse>;
}

export default defineExtension({
  async fetchContentSource(contentId: string): Promise<ContentSource | null> {
    const url = await buildHlsUrl(contentId);
    return { url };
  },

  canHandle(url) {
    return new URL(url as unknown as string).hostname.includes('tvoe.live');
  },

  async fetchContentMetadata(url: string): Promise<ContentMetadata[]> {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const alias = pathParts[pathParts.length - 1];

    if (!alias) {
      throw new Error('Не удалось определить идентификатор контента из URL');
    }

    const token = await authenticate();
    const movie = await fetchMovie(alias, token);
    const results: ContentMetadata[] = [];

    if (movie.categoryAlias === 'films') {
      const films = movie.videos?.films ?? [];
      for (const video of films) {
        if (!video.published || !video.src) continue;
        const meta: MovieMetadata = { title: movie.name, id: video.src };
        results.push(meta);
        break;
      }
    } else if (movie.categoryAlias === 'serials') {
      const seasons = movie.videos?.seasons ?? [];

      if (!localStorage.getItem(SERIAL_HINT_KEY)) {
        localStorage.setItem(SERIAL_HINT_KEY, '1');
        await confirm(
          'По умолчанию скачивается только первая серия первого сезона. Чтобы скачать конкретную серию, добавь в конец ссылки: ?season=1&episode=1, где season — номер сезона, episode — номер серии.',
          { title: 'Совет по скачиванию сериалов' },
        );
      }

      const targetSeason = parsedUrl.searchParams.get('season')
        ? parseInt(parsedUrl.searchParams.get('season')!)
        : 1;
      const targetEpisode = parsedUrl.searchParams.get('episode')
        ? parseInt(parsedUrl.searchParams.get('episode')!)
        : 1;

      for (let si = 0; si < seasons.length; si++) {
        const seasonNum = si + 1;
        if (seasonNum !== targetSeason) continue;

        const season = seasons[si];
        if (!Array.isArray(season)) continue;

        for (let ei = 0; ei < season.length; ei++) {
          const episodeNum = ei + 1;
          if (episodeNum !== targetEpisode) continue;

          const episode = season[ei];
          if (!episode || !episode.published || !episode.src) continue;

          const meta: EpisodeMetadata = {
            id: episode.src,
            title: movie.name,
            episodeTitle: episode.nameForUser,
            seasonNumber: seasonNum,
            episodeNumber: episodeNum,
          };
          results.push(meta);
        }
      }
    }

    return results;
  },
});
