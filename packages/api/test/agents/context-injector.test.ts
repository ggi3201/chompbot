import { afterEach, expect, test, vi } from "vitest";
vi.mock("../../src/lib/secrets.js", () => ({ getSecret: () => null }));
import { getAgentContext } from "../../src/agents/context-injector.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function configuredHa() {
  vi.stubEnv("HOMEASSISTANT_URL", "http://ha.example.com");
  vi.stubEnv("HOMEASSISTANT_TOKEN", "test-token");
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("sensor.")
    ? { state: "Example City" }
    : { state: "home", attributes: { latitude: 51.5, longitude: -0.1 }, last_updated: new Date().toISOString() })));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

test("no entity configured means no location requests", async () => {
  const fetcher = configuredHa();
  vi.stubEnv("HOMEASSISTANT_LOCATION_ENTITY", "");
  expect(await getAgentContext()).not.toContain("user_location");
  expect(fetcher).not.toHaveBeenCalled();
});

test("configured tracker and optional geocoded sensor are used; without the sensor, tracker coordinates", async () => {
  const fetcher = configuredHa();
  vi.stubEnv("HOMEASSISTANT_LOCATION_ENTITY", "device_tracker.test_phone");
  vi.stubEnv("HOMEASSISTANT_GEOCODED_ENTITY", "sensor.test_place");
  expect(await getAgentContext()).toContain("user_location: Example City");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "http://ha.example.com/api/states/device_tracker.test_phone", "http://ha.example.com/api/states/sensor.test_place",
  ]);

  fetcher.mockClear();
  vi.stubEnv("HOMEASSISTANT_GEOCODED_ENTITY", "");
  expect(await getAgentContext()).toContain("user_location: 51.5000, -0.1000");
  expect(fetcher).toHaveBeenCalledOnce();
});
