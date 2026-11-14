import { test, expect } from "vitest";
import { MCP_TOOLS } from "../../src/mcp/tool-definitions.js";
import { chompSelfSkill } from "../../src/seed/chomp-self.js";
import { phoneWidgetSkill } from "../../src/seed/phone-widget.js";
import { publishSchema } from "../../src/phone-cards/store.js";

test("the catalogue lists every tool once", () => {
  const { content } = chompSelfSkill();
  for (const { name } of MCP_TOOLS) {
    expect(content.split(`- \`${name}\`:`)).toHaveLength(2);
  }
});

test("the guide and the phone-widget skill only name tools that exist", () => {
  const names = new Set(MCP_TOOLS.map((tool) => tool.name));
  const toolsIn = (text: string) => [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
  const widget = toolsIn(phoneWidgetSkill().content);
  expect(widget).toContain("publish_phone_cards");
  expect(widget.filter((name) => !names.has(name))).toEqual([]);
  const guide = toolsIn(chompSelfSkill().content.split("## Every Chomp tool")[0]);
  expect(guide.length).toBeGreaterThan(0);
  expect(guide.filter((name) => !names.has(name))).toEqual([]);
});

test("the phone-widget skill's trip example is a valid publish, apart from its dates", () => {
  const example = JSON.parse(phoneWidgetSkill().content.match(/```json\n([\s\S]+?)```/)![1]);
  const future = JSON.parse(JSON.stringify(example).replaceAll("2026-", "2099-"));
  expect(publishSchema.safeParse(future).error).toBeUndefined();
});
