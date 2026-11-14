import { expect, test } from "vitest";
import { normalizePlaylistItemUri, formatAudioFeatures, execTrackMetrics } from "../../src/agents/tools/spotify.js";

test("normalizes Spotify playlist item URIs", () => {
  expect(normalizePlaylistItemUri("spotify:track:4cOdK2wGLETKBW3PvgPWqT")).toBe(
    "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
  );
  expect(normalizePlaylistItemUri("spotify:episode:3fuz0q5vlIQE1DB6JmKZ8B")).toBe(
    "spotify:episode:3fuz0q5vlIQE1DB6JmKZ8B",
  );
  expect(normalizePlaylistItemUri("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc")).toBe(
    "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
  );
  expect(normalizePlaylistItemUri("https://open.spotify.com/episode/3fuz0q5vlIQE1DB6JmKZ8B?si=abc")).toBe(
    "spotify:episode:3fuz0q5vlIQE1DB6JmKZ8B",
  );
});

test("treats bare 22-character IDs as tracks for backwards compatibility", () => {
  expect(normalizePlaylistItemUri("4cOdK2wGLETKBW3PvgPWqT")).toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
});

test("rejects unsupported Spotify playlist item inputs", () => {
  expect(normalizePlaylistItemUri("spotify:album:0sNOF9WDwhWunNAHPD3Baj")).toBeNull();
  expect(normalizePlaylistItemUri("https://open.spotify.com/show/3fuz0q5vlIQE1DB6JmKZ8B")).toBeNull();
  expect(normalizePlaylistItemUri("")).toBeNull();
});

test("formats audio features for ranking", () => {
  const line = formatAudioFeatures({
    tempo: 119.6, key: 2, mode: 0, energy: 0.62, valence: 0.31,
    danceability: 0.45, acousticness: 0.1, instrumentalness: 0.02,
  });
  expect(line).toBe("120 BPM • D minor • energy 62 • valence 31 • dance 45 • acoustic 10 • instrumental 2");
  expect(formatAudioFeatures({ tempo: 90, key: -1, mode: 1, energy: 0, valence: 0, danceability: 0, acousticness: 0, instrumentalness: 0 })).toContain("key n/a");
});

test("rejects calls with no valid track ids", async () => {
  expect(await execTrackMetrics([])).toContain("ERROR");
  expect(await execTrackMetrics(["spotify:episode:3fuz0q5vlIQE1DB6JmKZ8B", "nonsense"])).toContain("No valid track IDs");
});
