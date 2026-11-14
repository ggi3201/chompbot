/**
 * Spotify tools — search music and podcasts via the Spotify Web API.
 */

import { spotifyFetch, SpotifyNotConnectedError } from "./spotify-common.js";

const SPOTIFY_BASE = "https://api.spotify.com/v1";

const ALLOWED_TYPES = ["track", "album", "artist", "playlist", "show", "episode"] as const;
type SpotifyType = (typeof ALLOWED_TYPES)[number];

interface SpotifyImage { url: string; width: number; height: number }
interface SpotifyArtistRef { name: string; id: string }
interface SpotifyAlbumRef { name: string; id: string; release_date?: string }
interface SpotifyOwner { display_name: string; id: string }

interface SpotifyTrack {
  id: string;
  name: string;
  artists: SpotifyArtistRef[];
  album: SpotifyAlbumRef;
  duration_ms: number;
  explicit: boolean;
  external_urls: { spotify: string };
  uri: string;
}

interface SpotifyAlbum {
  id: string;
  name: string;
  artists: SpotifyArtistRef[];
  release_date: string;
  total_tracks: number;
  external_urls: { spotify: string };
  uri: string;
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  followers: { total: number };
  external_urls: { spotify: string };
  uri: string;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: SpotifyOwner;
  description: string | null;
  tracks: { total: number };
  external_urls: { spotify: string };
  uri: string;
}

interface SpotifyShow {
  id: string;
  name: string;
  publisher: string;
  description: string;
  total_episodes: number;
  external_urls: { spotify: string };
  uri: string;
}

interface SpotifyEpisode {
  id: string;
  name: string;
  description: string;
  duration_ms: number;
  release_date: string;
  external_urls: { spotify: string };
  uri: string;
}

interface SpotifySearchResponse {
  tracks?: { items: SpotifyTrack[] };
  albums?: { items: SpotifyAlbum[] };
  artists?: { items: SpotifyArtist[] };
  playlists?: { items: SpotifyPlaylist[] };
  shows?: { items: SpotifyShow[] };
  episodes?: { items: SpotifyEpisode[] };
}

function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function formatTrack(t: SpotifyTrack): string {
  const artists = t.artists.map((a) => a.name).join(", ");
  const explicit = t.explicit ? " [E]" : "";
  return `🎵 ${t.name}${explicit} — ${artists}\n   Album: ${t.album.name} • ${fmtDuration(t.duration_ms)}\n   URI: ${t.uri}\n   ${t.external_urls.spotify}`;
}

function formatAlbum(a: SpotifyAlbum): string {
  const artists = a.artists.map((x) => x.name).join(", ");
  return `💿 ${a.name} — ${artists}\n   Released: ${a.release_date} • ${a.total_tracks} tracks\n   URI: ${a.uri}\n   ${a.external_urls.spotify}`;
}

function formatArtist(a: SpotifyArtist): string {
  const genres = a.genres.length ? ` • ${a.genres.slice(0, 3).join(", ")}` : "";
  return `🎤 ${a.name}\n   ${a.followers.total.toLocaleString()} followers${genres}\n   URI: ${a.uri}\n   ${a.external_urls.spotify}`;
}

function formatPlaylist(p: SpotifyPlaylist): string {
  const desc = p.description ? `\n   ${p.description.slice(0, 120)}` : "";
  return `📀 ${p.name} — by ${p.owner.display_name}\n   ${p.tracks.total} tracks${desc}\n   URI: ${p.uri}\n   ${p.external_urls.spotify}`;
}

function formatShow(s: SpotifyShow): string {
  return `🎙️ ${s.name} — ${s.publisher}\n   ${s.total_episodes} episodes\n   ${s.description.slice(0, 140)}\n   URI: ${s.uri}\n   ${s.external_urls.spotify}`;
}

function formatEpisode(e: SpotifyEpisode): string {
  return `🎧 ${e.name}\n   ${e.release_date} • ${fmtDuration(e.duration_ms)}\n   ${e.description.slice(0, 140)}\n   URI: ${e.uri}\n   ${e.external_urls.spotify}`;
}

export async function execSearchSpotify(
  query: string,
  types?: string[],
  limit?: number,
): Promise<string> {
  if (!query || !query.trim()) {
    return `ERROR: query is required.`;
  }

  // Default to track + episode (music + podcasts) when caller doesn't specify.
  const requested = (types && types.length > 0 ? types : ["track", "episode"])
    .map((t) => t.toLowerCase())
    .filter((t): t is SpotifyType => (ALLOWED_TYPES as readonly string[]).includes(t));

  if (requested.length === 0) {
    return `ERROR: type must be one of: ${ALLOWED_TYPES.join(", ")}.`;
  }

  const max = Math.min(Math.max(limit ?? 5, 1), 20);
  const params = new URLSearchParams({
    q: query.trim(),
    type: requested.join(","),
    limit: String(max),
  });

  try {
    const res = await spotifyFetch(`${SPOTIFY_BASE}/search?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `ERROR: Spotify search failed (${res.status}): ${body.slice(0, 200)}`;
    }

    const data = await res.json() as SpotifySearchResponse;
    const sections: string[] = [];

    if (data.tracks?.items.length) {
      sections.push(`── Tracks ──\n${data.tracks.items.map(formatTrack).join("\n\n")}`);
    }
    if (data.albums?.items.length) {
      sections.push(`── Albums ──\n${data.albums.items.map(formatAlbum).join("\n\n")}`);
    }
    if (data.artists?.items.length) {
      sections.push(`── Artists ──\n${data.artists.items.map(formatArtist).join("\n\n")}`);
    }
    if (data.playlists?.items.length) {
      sections.push(`── Playlists ──\n${data.playlists.items.map(formatPlaylist).join("\n\n")}`);
    }
    if (data.shows?.items.length) {
      sections.push(`── Podcasts ──\n${data.shows.items.map(formatShow).join("\n\n")}`);
    }
    if (data.episodes?.items.length) {
      sections.push(`── Episodes ──\n${data.episodes.items.map(formatEpisode).join("\n\n")}`);
    }

    if (sections.length === 0) {
      return `No Spotify results for "${query}" (types: ${requested.join(", ")}).`;
    }
    return sections.join("\n\n");
  } catch (e) {
    if (e instanceof SpotifyNotConnectedError) {
      return `ERROR: ${e.message}`;
    }
    return `ERROR: Spotify search failed: ${e instanceof Error ? e.message : "Unknown error"}`;
  }
}

// ── Playlists ───────────────────────────────────────────────────

interface SpotifyMe {
  id: string;
  display_name: string;
}

type SpotifyPlaylistItem = SpotifyTrack | SpotifyEpisode;

interface SpotifyPlaylistDetail {
  id: string;
  name: string;
  description: string | null;
  owner: SpotifyOwner;
  tracks: { total: number; items?: { track: SpotifyPlaylistItem | null }[] };
  external_urls: { spotify: string };
  uri: string;
  public: boolean | null;
  collaborative: boolean;
}

interface SpotifyPaging<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
}

function wrapSpotifyError(e: unknown, action: string): string {
  if (e instanceof SpotifyNotConnectedError) return `ERROR: ${e.message}`;
  return `ERROR: Spotify ${action} failed: ${e instanceof Error ? e.message : "Unknown error"}`;
}

async function getCurrentUserId(): Promise<string> {
  const res = await spotifyFetch(`${SPOTIFY_BASE}/me`);
  if (!res.ok) throw new Error(`Could not resolve Spotify user (${res.status})`);
  const me = await res.json() as SpotifyMe;
  return me.id;
}

export async function execListPlaylists(limit?: number): Promise<string> {
  const max = Math.min(Math.max(limit ?? 20, 1), 50);
  try {
    const res = await spotifyFetch(`${SPOTIFY_BASE}/me/playlists?limit=${max}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `ERROR: Spotify list playlists failed (${res.status}): ${body.slice(0, 200)}`;
    }
    const data = await res.json() as SpotifyPaging<SpotifyPlaylist>;
    if (!data.items.length) return "You have no playlists yet.";
    const lines = data.items.map((p) => {
      return `📀 ${p.name} (${p.tracks.total} tracks) — by ${p.owner.display_name}\n   ID: ${p.id}\n   URI: ${p.uri}\n   ${p.external_urls.spotify}`;
    });
    return `Showing ${data.items.length} of ${data.total} playlists:\n\n${lines.join("\n\n")}`;
  } catch (e) {
    return wrapSpotifyError(e, "list playlists");
  }
}

export async function execGetPlaylist(playlistId: string, trackLimit?: number): Promise<string> {
  if (!playlistId) return "ERROR: playlist_id is required.";
  const max = Math.min(Math.max(trackLimit ?? 50, 1), 100);
  try {
    const res = await spotifyFetch(
      `${SPOTIFY_BASE}/playlists/${encodeURIComponent(playlistId)}?fields=id,name,description,owner,public,collaborative,external_urls,uri,tracks.total,tracks.items(track(type,id,name,artists(name,id),album(name,id),duration_ms,explicit,release_date,external_urls,uri))&limit=${max}`,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `ERROR: Spotify get playlist failed (${res.status}): ${body.slice(0, 200)}`;
    }
    const p = await res.json() as SpotifyPlaylistDetail;
    const meta = [
      `📀 **${p.name}** — by ${p.owner.display_name}`,
      `   ${p.tracks.total} items • ${p.public ? "public" : "private"}${p.collaborative ? " • collaborative" : ""}`,
      p.description ? `   ${p.description}` : null,
      `   URI: ${p.uri}`,
      `   ${p.external_urls.spotify}`,
    ].filter(Boolean).join("\n");

    const items = p.tracks.items
      ?.map((it) => it.track)
      .filter((t): t is SpotifyPlaylistItem => t !== null)
      .map((t, i) => {
        if ("artists" in t) {
          const artists = t.artists.map((a) => a.name).join(", ");
          return `   ${i + 1}. ${t.name} — ${artists} (${fmtDuration(t.duration_ms)})\n      ${t.uri}`;
        }
        return `   ${i + 1}. ${t.name} — episode (${fmtDuration(t.duration_ms)})\n      ${t.uri}`;
      });
    if (!items?.length) return `${meta}\n\n(no items loaded)`;
    return `${meta}\n\n── Items ──\n${items.join("\n")}`;
  } catch (e) {
    return wrapSpotifyError(e, "get playlist");
  }
}

export async function execCreatePlaylist(
  name: string,
  description?: string,
  isPublic?: boolean,
): Promise<string> {
  if (!name || !name.trim()) return "ERROR: name is required.";
  try {
    const userId = await getCurrentUserId();
    const res = await spotifyFetch(`${SPOTIFY_BASE}/users/${encodeURIComponent(userId)}/playlists`, {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        description: description?.trim() || undefined,
        public: isPublic === true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `ERROR: Spotify create playlist failed (${res.status}): ${body.slice(0, 200)}`;
    }
    const p = await res.json() as SpotifyPlaylistDetail;
    return `✅ Created playlist "${p.name}"\n   ID: ${p.id}\n   URI: ${p.uri}\n   ${p.external_urls.spotify}`;
  } catch (e) {
    return wrapSpotifyError(e, "create playlist");
  }
}

export function normalizePlaylistItemUri(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (t.startsWith("spotify:track:") || t.startsWith("spotify:episode:")) return t;
  // Accept bare 22-char track IDs
  if (/^[A-Za-z0-9]{22}$/.test(t)) return `spotify:track:${t}`;
  // Accept full URLs https://open.spotify.com/{track|episode}/<id>
  const urlMatch = t.match(/spotify\.com\/(track|episode)\/([A-Za-z0-9]{22})/);
  if (urlMatch) return `spotify:${urlMatch[1]}:${urlMatch[2]}`;
  return null;
}

export async function execAddToPlaylist(playlistId: string, trackUris: string[]): Promise<string> {
  if (!playlistId) return "ERROR: playlist_id is required.";
  if (!trackUris?.length) return "ERROR: track_uris is required.";

  const normalized: string[] = [];
  const skipped: string[] = [];
  for (const u of trackUris) {
    const n = normalizePlaylistItemUri(u);
    if (n) normalized.push(n);
    else skipped.push(u);
  }
  if (!normalized.length) return `ERROR: No valid track or episode URIs provided. Skipped: ${skipped.join(", ")}`;

  try {
    // Spotify caps at 100 URIs per request — chunk if needed
    let added = 0;
    for (let i = 0; i < normalized.length; i += 100) {
      const chunk = normalized.slice(i, i + 100);
      const res = await spotifyFetch(`${SPOTIFY_BASE}/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: "POST",
        body: JSON.stringify({ uris: chunk }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return `ERROR: Spotify add to playlist failed (${res.status}) at chunk ${i / 100}: ${body.slice(0, 200)}`;
      }
      added += chunk.length;
    }
    const skip = skipped.length ? ` (skipped ${skipped.length} unrecognized URIs)` : "";
    return `✅ Added ${added} item${added === 1 ? "" : "s"} to playlist ${playlistId}${skip}.`;
  } catch (e) {
    return wrapSpotifyError(e, "add to playlist");
  }
}

export async function execRemoveFromPlaylist(playlistId: string, trackUris: string[]): Promise<string> {
  if (!playlistId) return "ERROR: playlist_id is required.";
  if (!trackUris?.length) return "ERROR: track_uris is required.";

  const normalized: string[] = [];
  const skipped: string[] = [];
  for (const u of trackUris) {
    const n = normalizePlaylistItemUri(u);
    if (n) normalized.push(n);
    else skipped.push(u);
  }
  if (!normalized.length) return `ERROR: No valid track or episode URIs provided. Skipped: ${skipped.join(", ")}`;

  try {
    let removed = 0;
    for (let i = 0; i < normalized.length; i += 100) {
      const chunk = normalized.slice(i, i + 100);
      const res = await spotifyFetch(`${SPOTIFY_BASE}/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: "DELETE",
        body: JSON.stringify({ tracks: chunk.map((uri) => ({ uri })) }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return `ERROR: Spotify remove from playlist failed (${res.status}) at chunk ${i / 100}: ${body.slice(0, 200)}`;
      }
      removed += chunk.length;
    }
    const skip = skipped.length ? ` (skipped ${skipped.length} unrecognized URIs)` : "";
    return `✅ Removed ${removed} item${removed === 1 ? "" : "s"} from playlist ${playlistId}${skip}.`;
  } catch (e) {
    return wrapSpotifyError(e, "remove from playlist");
  }
}

const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAX_METRIC_TRACKS = 20;

interface AudioFeatures {
  tempo: number; key: number; mode: number; energy: number; valence: number;
  danceability: number; acousticness: number; instrumentalness: number;
}

export function formatAudioFeatures(f: AudioFeatures): string {
  const pct = (x: number) => Math.round(x * 100);
  const key = f.key >= 0 ? `${KEY_NAMES[f.key]} ${f.mode === 1 ? "major" : "minor"}` : "key n/a";
  return `${Math.round(f.tempo)} BPM • ${key} • energy ${pct(f.energy)} • valence ${pct(f.valence)} • dance ${pct(f.danceability)} • acoustic ${pct(f.acousticness)} • instrumental ${pct(f.instrumentalness)}`;
}

/** GET a Spotify URL; returns the parsed body or the HTTP status when it is not OK. */
async function getOrStatus<T>(url: string): Promise<{ data: T } | { status: number }> {
  const res = await spotifyFetch(url);
  return res.ok ? { data: (await res.json()) as T } : { status: res.status };
}

/**
 * Per-track metrics for ranking recommendation candidates: popularity, release year, artist genres
 * and audio features. Audio features are restricted for newer Spotify apps, so a 403 is reported
 * per track instead of failing the whole call. Per-id requests (not the batch endpoints) so one
 * restricted endpoint cannot blank the rest.
 */
export async function execTrackMetrics(inputs: string[]): Promise<string> {
  if (!inputs?.length) return "ERROR: track_ids is required.";
  const ids = [...new Set(inputs.map((i) => normalizePlaylistItemUri(i)).filter((u): u is string => !!u && u.startsWith("spotify:track:")).map((u) => u.slice(14)))];
  if (!ids.length) return "ERROR: No valid track IDs, URIs or URLs provided.";
  const capped = ids.slice(0, MAX_METRIC_TRACKS);

  try {
    const rows = await Promise.all(capped.map(async (id) => {
      const [track, af] = await Promise.all([
        getOrStatus<SpotifyTrack & { popularity?: number }>(`${SPOTIFY_BASE}/tracks/${id}`),
        getOrStatus<AudioFeatures>(`${SPOTIFY_BASE}/audio-features/${id}`),
      ]);
      const artist = "data" in track && track.data.artists[0]
        ? await getOrStatus<SpotifyArtist>(`${SPOTIFY_BASE}/artists/${track.data.artists[0].id}`)
        : null;
      return { id, track, af, artist };
    }));

    const lines = rows.map(({ id, track, af, artist }) => {
      if (!("data" in track)) return `❌ ${id}: track lookup failed (${track.status})`;
      const t = track.data;
      const pop = t.popularity === undefined ? "popularity n/a" : `popularity ${t.popularity}/100`;
      const year = t.album.release_date?.slice(0, 4) ?? "?";
      const genres = artist && "data" in artist && artist.data.genres.length ? ` • ${artist.data.genres.slice(0, 3).join(", ")}` : "";
      const feat = "data" in af ? formatAudioFeatures(af.data) : `audio features unavailable (HTTP ${af.status})`;
      return `🎵 ${t.name} — ${t.artists.map((a) => a.name).join(", ")} (${year})\n   ${pop}${genres}\n   ${feat}\n   ${t.uri}`;
    });
    const blocked = rows.filter((r) => !("data" in r.af)).length;
    const note = blocked === rows.length ? "⚠ Audio features are unavailable for this Spotify app on every track; use popularity and genres only.\n\n" : "";
    const trunc = ids.length > capped.length ? `\n\n(Only the first ${MAX_METRIC_TRACKS} of ${ids.length} tracks were checked.)` : "";
    return `${note}${lines.join("\n\n")}${trunc}`;
  } catch (e) {
    return wrapSpotifyError(e, "get track metrics");
  }
}
