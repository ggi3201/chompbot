// Main Canvas renderer — takes a parsed CanvasBlock and renders the right component.

import type { CanvasBlock } from "../../lib/canvas-parser";
import { GlassCard } from "../ui";
import InfoCard from "./InfoCard";
import MetricGrid from "./MetricGrid";
import DataTable from "./DataTable";
import ProgressBar from "./ProgressBar";
import LinkList from "./LinkList";
import BarChart from "./BarChart";
import LineChart from "./LineChart";
import Slider from "./Slider";
import Tabs from "./Tabs";
import Sparkline from "./Sparkline";
import Timeline from "./Timeline";
import DonutChart from "./DonutChart";
import Heatmap from "./Heatmap";
import Callout from "./Callout";
import Countdown from "./Countdown";
import RadarChart from "./RadarChart";
import PixelCanvas from "./PixelCanvas";
import DrawingCanvas from "./DrawingCanvas";
import Artifact from "./Artifact";
import Sketchpad from "./Sketchpad";
import Embed from "./Embed";
import ActionButton from "./ActionButton";
import Choice from "./Choice";
import CanvasForm from "./CanvasForm";

interface CanvasRendererProps {
  data: CanvasBlock;
}

export default function CanvasRenderer({ data }: CanvasRendererProps) {
  switch (data.type) {
    case "info-card":
      return (
        <InfoCard
          title={data.title as string}
          value={data.value as string}
          subtitle={data.subtitle as string | undefined}
          change={data.change as string | undefined}
          color={data.color as string | undefined}
        />
      );

    case "metric-grid":
      return (
        <MetricGrid
          items={data.items as { title: string; value: string; subtitle?: string; change?: string; color?: string }[]}
          columns={data.columns as number | undefined}
        />
      );

    case "data-table":
      return (
        <DataTable
          title={data.title as string | undefined}
          headers={data.headers as string[]}
          rows={data.rows as string[][]}
        />
      );

    case "progress-bar":
      return (
        <ProgressBar
          label={data.label as string}
          value={data.value as number}
          max={data.max as number | undefined}
          color={data.color as string | undefined}
          showPercent={data.showPercent as boolean | undefined}
        />
      );

    case "link-list":
      return (
        <LinkList
          title={data.title as string | undefined}
          items={data.items as { label: string; url: string; description?: string }[]}
        />
      );

    case "bar-chart":
      return (
        <BarChart
          title={data.title as string | undefined}
          bars={data.bars as { label: string; value: number; color?: string }[]}
        />
      );

    case "line-chart":
      return (
        <LineChart
          title={data.title as string | undefined}
          labels={data.labels as string[] | undefined}
          series={data.series as { label: string; data: number[]; color?: string }[]}
          height={data.height as number | undefined}
        />
      );

    case "slider":
      return (
        <Slider
          label={data.label as string}
          value={data.value as number}
          min={data.min as number | undefined}
          max={data.max as number | undefined}
          step={data.step as number | undefined}
          unit={data.unit as string | undefined}
          color={data.color as string | undefined}
          submitLabel={data.submitLabel as string | undefined}
        />
      );

    case "artifact":
      return <Artifact id={data.id as string} title={data.title as string | undefined} />;

    case "sketchpad":
      return <Sketchpad id={data.id as string} title={data.title as string | undefined} upTo={data.upTo as number | undefined} />;

    case "embed":
      return <Embed url={data.url as string} title={data.title as string | undefined} height={data.height as number | undefined} />;

    case "button":
      return (
        <ActionButton
          label={data.label as string}
          prompt={data.prompt as string | undefined}
          variant={data.variant as "primary" | "ghost" | "outline" | "danger" | undefined}
        />
      );

    case "choice":
      return <Choice title={data.title as string | undefined} options={data.options as { label: string; value?: string }[]} />;

    case "form":
      return (
        <CanvasForm
          title={data.title as string | undefined}
          fields={data.fields as never}
          submitLabel={data.submitLabel as string | undefined}
          prompt={data.prompt as string | undefined}
        />
      );

    case "tabs":
      return (
        <Tabs
          tabs={data.tabs as { label: string; content: string }[]}
          color={data.color as string | undefined}
        />
      );

    case "sparkline":
      return (
        <Sparkline
          values={data.values as number[]}
          label={data.label as string | undefined}
          color={data.color as string | undefined}
          height={data.height as number | undefined}
          width={data.width as number | undefined}
        />
      );

    case "timeline":
      return (
        <Timeline
          title={data.title as string | undefined}
          events={data.events as { time?: string; title: string; description?: string; color?: string; icon?: string }[]}
          color={data.color as string | undefined}
        />
      );

    case "donut-chart":
      return (
        <DonutChart
          title={data.title as string | undefined}
          segments={data.segments as { label: string; value: number; color?: string }[]}
          size={data.size as number | undefined}
          thickness={data.thickness as number | undefined}
          centerLabel={data.centerLabel as string | undefined}
          centerValue={data.centerValue as string | undefined}
        />
      );

    case "heatmap":
      return (
        <Heatmap
          title={data.title as string | undefined}
          data={data.data as number[]}
          columns={data.columns as number | undefined}
          labels={data.labels as string[] | undefined}
          color={data.color as string | undefined}
        />
      );

    case "callout":
      return (
        <Callout
          variant={data.variant as "info" | "warning" | "success" | "error" | "tip" | undefined}
          title={data.title as string | undefined}
          message={data.message as string}
        />
      );

    case "countdown":
      return (
        <Countdown
          title={data.title as string | undefined}
          target={data.target as string}
          color={data.color as string | undefined}
          subtitle={data.subtitle as string | undefined}
        />
      );

    case "radar-chart":
      return (
        <RadarChart
          title={data.title as string | undefined}
          axes={data.axes as string[]}
          datasets={data.datasets as { label: string; values: number[]; color?: string }[]}
          max={data.max as number | undefined}
          size={data.size as number | undefined}
        />
      );

    case "pixel-canvas":
      return (
        <PixelCanvas
          title={data.title as string | undefined}
          width={data.width as number | undefined}
          height={data.height as number | undefined}
          cellSize={data.cellSize as number | undefined}
          palette={data.palette as string[] | undefined}
          initialPixels={data.initialPixels as { x: number; y: number; color: string }[] | undefined}
        />
      );

    case "drawing-canvas":
      return (
        <DrawingCanvas
          title={data.title as string | undefined}
          width={data.width as number | undefined}
          height={data.height as number | undefined}
          viewBox={data.viewBox as string | undefined}
          background={data.background as string | undefined}
          paths={data.paths as { d: string; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number }[] | undefined}
          shapes={data.shapes as {
            type: "rect" | "circle" | "ellipse" | "line" | "polygon" | "polyline";
            [key: string]: unknown;
          }[] | undefined}
          labels={data.labels as { x: number; y: number; text: string; size?: number; color?: string; anchor?: "start" | "middle" | "end"; weight?: number }[] | undefined}
        />
      );

    default:
      // Unknown canvas type — render nothing rather than crashing
      return (
        <GlassCard className="px-4 py-3 text-[13px] text-text-muted">
          Unknown canvas block <span className="font-mono text-xs">{data.type}</span>
        </GlassCard>
      );
  }
}
