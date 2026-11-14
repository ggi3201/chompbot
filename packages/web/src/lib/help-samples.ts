import type { CanvasBlock } from "./canvas-parser";

export interface HelpSample {
  /** The canvas type, or a plain name for things that are not canvas blocks. */
  name: string;
  blurb: string;
  /** Goes into the composer from "Try it". */
  ask: string;
  /** What it looks like. Absent for things that need a server id or a URL to show anything. */
  block?: CanvasBlock;
}

const inDays = (days: number) => new Date(Date.now() + days * 864e5).toISOString();

export const HELP_GROUPS: Array<{ id: string; samples: HelpSample[] }> = [
  {
    id: "numbers",
    samples: [
      {
        name: "info-card",
        blurb: "One number that matters",
        ask: "What is BTC at? Show it as a card",
        block: { type: "info-card", title: "BTC", value: "$104,230", change: "+2.3%", color: "emerald" },
      },
      {
        name: "metric-grid",
        blurb: "A few numbers side by side: prices, stats",
        ask: "Show my crypto tickers as a metric grid",
        block: {
          type: "metric-grid",
          columns: 3,
          items: [
            { title: "BTC", value: "$104,230", change: "+2.3%", color: "emerald" },
            { title: "ETH", value: "$3,910", change: "-0.8%", color: "pink" },
            { title: "XRP", value: "$2.41", change: "+4.1%", color: "cyan" },
          ],
        },
      },
      {
        name: "progress-bar",
        blurb: "How far along something is",
        ask: "Show my weekly Claude usage as a progress bar",
        block: { type: "progress-bar", label: "Weekly usage", value: 34, max: 100, color: "amber" },
      },
      {
        name: "countdown",
        blurb: "A live timer to a date",
        ask: "Count down to my next flight",
        block: { type: "countdown", title: "Next trip", target: inDays(3), subtitle: "Home to Lisbon", color: "cyan" },
      },
      {
        name: "callout",
        blurb: "A note that should not be missed (info, warning, success, error, tip)",
        ask: "Put the one thing I must not miss in a callout",
        block: { type: "callout", variant: "tip", title: "Tip", message: "Type / for commands and @ for an agent." },
      },
    ],
  },
  {
    id: "charts",
    samples: [
      {
        name: "bar-chart",
        blurb: "Compare a handful of things",
        ask: "Compare my open positions in a bar chart",
        block: {
          type: "bar-chart",
          title: "Sessions today",
          bars: [
            { label: "Claude", value: 14, color: "amber" },
            { label: "Codex", value: 6, color: "blue" },
            { label: "Direct", value: 9, color: "emerald" },
          ],
        },
      },
      {
        name: "line-chart",
        blurb: "A trend over time, one or more series",
        ask: "Chart the last week of my weight as a line chart",
        block: {
          type: "line-chart",
          title: "Last 5 days",
          labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
          series: [
            { label: "Mine", data: [3, 5, 4, 8, 7], color: "#f2a33a" },
            { label: "Target", data: [4, 4, 5, 6, 7], color: "#38bdf8" },
          ],
        },
      },
      {
        name: "donut-chart",
        blurb: "Shares of a whole",
        ask: "Split my portfolio into a donut chart",
        block: {
          type: "donut-chart",
          segments: [
            { label: "Stocks", value: 60, color: "#f2a33a" },
            { label: "Crypto", value: 25, color: "#a78bfa" },
            { label: "Cash", value: 15, color: "#34d399" },
          ],
          centerLabel: "Total",
          centerValue: "100%",
          size: 140,
        },
      },
      {
        name: "radar-chart",
        blurb: "Compare options across several criteria",
        ask: "Compare these two laptops on a radar chart",
        block: {
          type: "radar-chart",
          axes: ["Speed", "Price", "Battery", "Screen", "Weight"],
          max: 10,
          size: 220,
          datasets: [
            { label: "A", values: [8, 6, 9, 7, 5], color: "#f2a33a" },
            { label: "B", values: [6, 9, 5, 8, 8], color: "#38bdf8" },
          ],
        },
      },
      {
        name: "heatmap",
        blurb: "Intensity over a grid, like days of the week",
        ask: "Show how active I was over the last 3 weeks as a heatmap",
        block: { type: "heatmap", columns: 7, data: [1, 3, 2, 5, 4, 0, 1, 2, 4, 3, 6, 5, 1, 0, 3, 5, 4, 7, 6, 2, 1], color: "amber" },
      },
      {
        name: "sparkline",
        blurb: "A tiny trend that fits in a line",
        ask: "Give me NVDA with a sparkline",
        block: { type: "sparkline", label: "NVDA, 7 days", values: [118, 121, 119, 125, 124, 130, 133], color: "emerald" },
      },
    ],
  },
  {
    id: "lists",
    samples: [
      {
        name: "data-table",
        blurb: "Rows and columns: emails, events, issues",
        ask: "List my open GitHub issues as a table",
        block: {
          type: "data-table",
          headers: ["Repo", "Issue", "State"],
          rows: [
            ["chomp", "#412 Help sheet", "open"],
            ["website", "#38 Dark mode", "open"],
            ["notes-app", "#9 Search", "done"],
          ],
        },
      },
      {
        name: "link-list",
        blurb: "Search results and sources, with a line each",
        ask: "Find three good reads on this and list them",
        block: {
          type: "link-list",
          items: [
            { label: "Home Assistant docs", url: "https://www.home-assistant.io/docs/", description: "Start here" },
            { label: "Traefik", url: "https://doc.traefik.io/traefik/", description: "Routers and middleware" },
          ],
        },
      },
      {
        name: "timeline",
        blurb: "What happens when, in order",
        ask: "Lay out my trip day as a timeline",
        block: {
          type: "timeline",
          events: [
            { time: "06:10", title: "Taxi to the airport", description: "About 20 minutes" },
            { time: "07:25", title: "Flight TP 1355", description: "Home to Lisbon" },
            { time: "11:30", title: "Client office" },
          ],
        },
      },
      {
        name: "tabs",
        blurb: "Several short answers, one at a time",
        ask: "Give me pros and cons in tabs",
        block: {
          type: "tabs",
          tabs: [
            { label: "Pros", content: "- Fast\n- Cheap" },
            { label: "Cons", content: "- Loud\n- Short battery" },
          ],
        },
      },
    ],
  },
  {
    id: "drawing",
    samples: [
      {
        name: "drawing-canvas",
        blurb: "Logos, wireframes, diagrams: vector shapes and labels",
        ask: "Draw a simple diagram of how my home network fits together",
        block: {
          type: "drawing-canvas",
          width: 240,
          height: 90,
          viewBox: "0 0 240 90",
          background: "#19191b",
          paths: [
            { d: "M10 25h60v40h-60z", fill: "#232325", stroke: "#f2a33a", strokeWidth: 2 },
            { d: "M90 25h60v40h-60z", fill: "#232325", stroke: "#38bdf8", strokeWidth: 2 },
            { d: "M170 25h60v40h-60z", fill: "#232325", stroke: "#34d399", strokeWidth: 2 },
            { d: "M70 45h20M150 45h20", fill: "none", stroke: "#8a8a8f", strokeWidth: 2 },
          ],
          labels: [
            { x: 40, y: 50, text: "Phone", size: 11, color: "#e6e6e8", anchor: "middle" },
            { x: 120, y: 50, text: "Traefik", size: 11, color: "#e6e6e8", anchor: "middle" },
            { x: 200, y: 50, text: "Chomp", size: 11, color: "#e6e6e8", anchor: "middle" },
          ],
        },
      },
      {
        name: "pixel-canvas",
        blurb: "Pixel art you can click to paint",
        ask: "Make a small pixel-art heart I can edit",
        block: {
          type: "pixel-canvas",
          width: 7,
          height: 6,
          cellSize: 20,
          palette: ["#f2a33a", "#ef4444", "#ffffff", "#232325"],
          initialPixels: [
            [1, 0], [2, 0], [4, 0], [5, 0],
            [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1],
            [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2],
            [1, 3], [2, 3], [3, 3], [4, 3], [5, 3],
            [2, 4], [3, 4], [4, 4],
            [3, 5],
          ].map(([x, y]) => ({ x, y, color: "#ef4444" })),
        },
      },
      {
        name: "sketchpad",
        blurb: "A shared sheet: you draw, Chomp reads it and draws back",
        ask: "Open a sketch so we can draw this out together",
      },
    ],
  },
  {
    id: "inputs",
    samples: [
      {
        name: "button",
        blurb: "One tap answers for you (primary, ghost, outline, danger)",
        ask: "Ask me yes or no with buttons before you do it",
        block: { type: "button", label: "Yes, do it", variant: "primary" },
      },
      {
        name: "choice",
        blurb: "Pick one of a few options",
        ask: "Let me choose between the options with a choice",
        block: { type: "choice", title: "Which one?", options: [{ label: "Cheap and close" }, { label: "Fast" }, { label: "Skip it" }] },
      },
      {
        name: "form",
        blurb: "Several inputs at once: text, number, select, checkbox",
        ask: "Collect what you need for the trip in a form",
        block: {
          type: "form",
          title: "Trip details",
          submitLabel: "Send",
          fields: [
            { name: "city", label: "City", type: "text", value: "Lisbon" },
            { name: "nights", label: "Nights", type: "number", value: "1" },
            { name: "bag", label: "Checked bag", type: "checkbox" },
          ],
        },
      },
      {
        name: "slider",
        blurb: "Set a value on a scale",
        ask: "Let me set the budget with a slider",
        block: { type: "slider", label: "Budget", value: 1500, min: 0, max: 5000, step: 100, unit: " kr", color: "amber", submitLabel: "Use this" },
      },
    ],
  },
  {
    id: "pages",
    samples: [
      {
        name: "artifact",
        blurb: "A whole page or mini-app in the chat: planners, calculators, games. It can answer back into the chat",
        ask: "Build me a small page for this that I can use right here",
      },
      {
        name: "embed",
        blurb: "Any web page shown inline",
        ask: "Show that page inline in the chat",
      },
      {
        name: "images",
        blurb: "Screenshots, before and after, mockups: shown right in the message",
        ask: "Show me a before and after screenshot",
      },
      {
        name: "preview",
        blurb: "A live page beside the chat for any web UI Chomp builds (top bar, window icon)",
        ask: "Start a preview of the app and show me",
      },
      {
        name: "task list",
        blurb: "On longer jobs Chomp pins its steps above the box and ticks them off",
        ask: "Plan this as a task list and work through it",
      },
    ],
  },
];
