# anatomy-grok-bot

Interactive isometric technical figures for **Cursor** and **Grok Bot**, packaged from the open-source [Anatomy](https://github.com/wheresryan22/anatomy) skill by [@wheresryan22](https://x.com/wheresryan22).

![A rotary engine figure built with the kit](assets/screenshot-rotary-engine.png)

## Credits

**Anatomy was created by Ryan ([@wheresryan22](https://x.com/wheresryan22)).** All of the figure-drawing design, the kit, the references and the examples in this plugin are his work.

- Original repository: <https://github.com/wheresryan22/anatomy>
- Live demo: <https://skills.wheresryan.sh/anatomy>
- Author on X: <https://x.com/wheresryan22>
- License: MIT (original copyright notice kept intact in [LICENSE](LICENSE))

This repository is an **unofficial packaging** of Anatomy for Cursor and Grok Bot by Pedro Gonzalez / Blueforce Innovations. It is not an official release by the original author. See [CREDITS.md](CREDITS.md) and [NOTICE](NOTICE) for details.

## What it does

Ask the agent for an explainer figure, a "how it works" diagram, or an isometric illustration and the `anatomy` skill builds it as a real, finely detailed physical object: solids with four-tone shading, correct painter's order, a framed card with title, hint and live readout, and calm eased motion. Output is a standalone HTML page (dark and light themes) or a lone SVG, framework-free or for React/Next.js, with optional WebGL shaders and an optional 3D mode.

It also bundles the kit's verification tools: a geometry audit (`--audit`), headless-Chrome screenshots, scripted interaction, and a line-end check.

## What's inside

```
.cursor-plugin/plugin.json   plugin manifest
skills/anatomy/SKILL.md      the skill (upstream rulebook + plugin notes)
skills/anatomy/kit/          the Anatomy kit (ESM + TypeScript + React)
skills/anatomy/scripts/      capture, drive, lines, inline-kit, 3D checks
skills/anatomy/references/   craft, kit API, motion, verify, WebGL, 3D, React
skills/anatomy/examples/     8 example figures (sources; build to get HTML)
```

## Requirements

- Node.js 18 or later. No npm install.
- Chrome or Chromium for screenshots and checks (set `CHROME_PATH` if it isn't found).

## Install

**Cursor Marketplace:** once listed, open **Customize**, search for `anatomy-grok-bot`, and select **Install**.

**Cursor, local test:** copy this folder to `~/.cursor/plugins/local/anatomy-grok-bot`, then run **Developer: Reload Window** and confirm the `anatomy` skill shows up under Customize.

**Grok Bot:** install the plugin from this repository's URL (`https://github.com/plgonzalezrx8/anatomy-grok-bot`) through Grok Bot's plugin settings.

## Usage

Just ask, for example:

- "Make an interactive isometric figure that explains how a cache key skips work."
- "Draw a how-it-works figure of a rotary engine for our blog post, light theme."

Or invoke it directly with `/anatomy` in Cursor chat.

Sanity-check the bundled kit from the skill folder:

```sh
cd skills/anatomy
node examples/dial-indicator/build.mjs
node examples/arcade-cabinet/build.mjs --audit   # ends "audit passed"
```

## Credit and license

Anatomy is by Ryan ([@wheresryan22](https://x.com/wheresryan22), [GitHub](https://github.com/wheresryan22)), released under the MIT License. Original repository: <https://github.com/wheresryan22/anatomy>. Demo: <https://skills.wheresryan.sh/anatomy>. This plugin is an unofficial, independent packaging by Pedro Gonzalez / Blueforce Innovations and is not an official release by the original author. See [CREDITS.md](CREDITS.md), [LICENSE](LICENSE) (original copyright notice kept intact) and [NOTICE](NOTICE) for exactly what changed.
