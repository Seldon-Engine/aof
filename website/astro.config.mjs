import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://seldon-engine.github.io",
  base: "/aof",
  integrations: [
    starlight({
      title: "AOF — Agentic Ops Fabric",
      description:
        "Deterministic orchestration for multi-agent systems. AOF turns an agent swarm into a reliable, observable, restart-safe operating environment.",
      favicon: "/favicon.ico",
      social: {
        github: "https://github.com/Seldon-Engine/aof",
      },
      editLink: {
        baseUrl: "https://github.com/Seldon-Engine/aof/edit/main/website/",
      },
      lastUpdated: true,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "What is AOF?", link: "/getting-started/overview" },
            { label: "Installation & Setup", link: "/getting-started/installation" },
            { label: "Quick Start Tutorial", link: "/getting-started/quick-start" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Org Charts", link: "/concepts/org-charts" },
            { label: "Task Lifecycle", link: "/concepts/task-lifecycle" },
            { label: "Workflow Gates", link: "/concepts/workflow-gates" },
            { label: "Memory Medallion Architecture", link: "/concepts/memory-medallion" },
            { label: "Protocol System", link: "/concepts/protocols" },
            { label: "Notification Engine", link: "/concepts/notifications" },
            { label: "Cascading Dependencies", link: "/concepts/cascading-dependencies" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Agent Tools", link: "/reference/agent-tools" },
            { label: "CLI Commands", link: "/reference/cli" },
            { label: "Plugin Configuration", link: "/reference/plugin-config" },
            { label: "Org Chart YAML Schema", link: "/reference/org-chart-schema" },
            { label: "Task Format", link: "/reference/task-format" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Deployment Guide", link: "/guides/deployment" },
            { label: "Memory Module Setup", link: "/guides/memory-setup" },
            { label: "Writing Custom Workflow Gates", link: "/guides/custom-gates" },
            { label: "Migration Guide", link: "/guides/migration" },
          ],
        },
        {
          label: "Contributing",
          items: [
            { label: "Dev Setup", link: "/contributing/dev-setup" },
            { label: "Conventional Commits", link: "/contributing/conventional-commits" },
            { label: "Release Process", link: "/contributing/release-process" },
            { label: "Architecture Overview", link: "/contributing/architecture" },
          ],
        },
      ],
    }),
  ],
});
